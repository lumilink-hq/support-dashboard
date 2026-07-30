-- =============================================================================
-- 0020_product_search_real_catalog.sql
-- Correct 0019 against the ACTUAL Tsunami catalogue (68 products, exported and
-- inspected 2026-07-29). Three findings, each of which 0019 got wrong:
--
-- 1. product_type IS ALMOST ALWAYS BLANK. Only 5 of 68 carry a Type ("Flower"
--    x4 on the WAVE items, "Insurance" on Route). So catalog_overview filed 47
--    of 52 active products under "Other", and "what flower do you have" matched
--    four products when every one of the 52 is flower.
--    THE DATA IS IN THE TAGS: all 52 carry `format-flower`. Type is now derived
--    from a tag prefix when the column is empty.
--
-- 2. THE VENDOR BOOST IN 0019 WAS A MISTAKE. Vendor is "Tsunami.store" on 67 of
--    68 rows — the store's own name, not a brand. 0019 scored an exact vendor
--    match at 0.88, so a caller saying "Tsunami" scored all 52 products
--    identically AND buried the four products actually called `Tsunami Z`,
--    `Tsunami Biscotti`, `Tsunami Gushers`, `Tsunami 41`. The brand lives in the
--    TITLE here, not the vendor column.
--    Rather than delete the boost (a client with real multi-brand inventory
--    wants it), we detect the "house vendor" — the one covering more than half
--    the catalogue — and refuse to let it act as a distinguishing signal.
--
-- 3. TAGS ARE PREFIXED, so `v_q = any(tags)` never fired. Real tags are
--    `strain-indica`, `effect-sleep`, `format-flower`, `level-beginner`. A caller
--    says "indica", which matched only weakly as a substring. Tag matching is now
--    suffix-aware: "indica" matches `strain-indica` at full tag weight.
--
-- Also: the status filter is now case-insensitive. The Shopify GraphQL API
-- returns "ACTIVE" but the CSV export writes "active", and a lowercase value
-- reaching this table would have silently hidden the entire catalogue.
--
-- Idempotent (create or replace). No table changes; 0018's schema stands.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- catalog_type_of — the product's category, falling back to a tag.
--
-- `format-flower` -> "Flower". Prefix is configurable per client via
-- settings.product_type_tag_prefix (default 'format-') because another store
-- might use `category-` or `kind-`.
-- -----------------------------------------------------------------------------
create or replace function catalog_type_of(
  p_product_type text,
  p_tags         text[],
  p_prefix       text default 'format-'
)
returns text
language sql
immutable
set search_path = public
as $$
  select coalesce(
    nullif(trim(coalesce(p_product_type, '')), ''),
    (
      select initcap(replace(substring(t from length(p_prefix) + 1), '-', ' '))
        from unnest(coalesce(p_tags, '{}')) t
       where left(lower(t), length(p_prefix)) = lower(p_prefix)
         and length(t) > length(p_prefix)
       order by t
       limit 1
    ),
    'Other'
  );
$$;

-- -----------------------------------------------------------------------------
-- catalog_overview — now grouped by the DERIVED type, so "Flower" is one bucket
-- of 52 rather than "Other" being one bucket of 47.
--
-- The brand list drops the house vendor: telling a caller "we carry
-- Tsunami.store" is noise.
-- -----------------------------------------------------------------------------
create or replace function catalog_overview(
  p_client_id     uuid,
  p_max_types     int default 6,
  p_max_examples  int default 4,
  p_max_brands    int default 8
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_prefix   text;
  v_total    int;
  v_house    text;
  v_house_n  int;
  v_result   jsonb;
begin
  select coalesce(settings ->> 'product_type_tag_prefix', 'format-')
    into v_prefix from clients where id = p_client_id;
  if v_prefix is null then
    return jsonb_build_object('types', '[]'::jsonb, 'brands', '[]'::jsonb);
  end if;

  select count(*) into v_total
    from products_cache
   where client_id = p_client_id
     and upper(coalesce(status, 'ACTIVE')) = 'ACTIVE';

  select vendor, count(*) into v_house, v_house_n
    from products_cache
   where client_id = p_client_id
     and upper(coalesce(status, 'ACTIVE')) = 'ACTIVE'
     and nullif(trim(coalesce(vendor, '')), '') is not null
   group by vendor
   order by count(*) desc
   limit 1;

  -- Covering most of the catalogue means it's the storefront, not a brand.
  if v_total = 0 or v_house_n is null
     or (v_house_n::numeric / greatest(v_total, 1)) <= 0.5 then
    v_house := null;
  end if;

  select jsonb_build_object(
    'types', coalesce((
      select jsonb_agg(t order by t.n desc)
      from (
        select
          catalog_type_of(p.product_type, p.tags, v_prefix) as type,
          count(*)                                          as n,
          (array_agg(p.title order by p.title))[1:greatest(p_max_examples, 1)] as examples
        from products_cache p
        where p.client_id = p_client_id
          and upper(coalesce(p.status, 'ACTIVE')) = 'ACTIVE'
        group by catalog_type_of(p.product_type, p.tags, v_prefix)
        order by count(*) desc
        limit greatest(p_max_types, 1)
      ) t
    ), '[]'::jsonb),
    'brands', coalesce((
      select jsonb_agg(v.vendor order by v.n desc)
      from (
        select p.vendor, count(*) as n
        from products_cache p
        where p.client_id = p_client_id
          and upper(coalesce(p.status, 'ACTIVE')) = 'ACTIVE'
          and nullif(trim(coalesce(p.vendor, '')), '') is not null
          and (v_house is null or p.vendor <> v_house)
        group by p.vendor
        order by count(*) desc
        limit greatest(p_max_brands, 1)
      ) v
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- search_products — same layered approach as 0019, corrected per the findings.
-- -----------------------------------------------------------------------------
create or replace function search_products(
  p_client_id uuid,
  p_query     text,
  p_limit     int default 3
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_raw       text := nullif(trim(coalesce(p_query, '')), '');
  v_q         text;
  v_limit     int  := least(greatest(coalesce(p_limit, 3), 1), 10);
  v_max_age   int;
  v_aliases   jsonb;
  v_prefix    text;
  v_newest    timestamptz;
  v_fresh     boolean;
  v_tokens    text[];
  v_house     text;
  v_house_n   int;
  v_total     int;
  v_matches   jsonb;
  v_count     int;
  v_total_matches int;
  v_broad     boolean;
begin
  if p_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'client_id is required');
  end if;
  if v_raw is null then
    return jsonb_build_object('ok', false, 'error', 'need_product_name');
  end if;

  select coalesce((settings ->> 'product_cache_max_age_minutes')::int, 120),
         coalesce(settings -> 'product_aliases', '{}'::jsonb),
         coalesce(settings ->> 'product_type_tag_prefix', 'format-')
    into v_max_age, v_aliases, v_prefix
    from clients where id = p_client_id;

  if v_max_age is null then
    return jsonb_build_object('ok', false, 'error', 'unknown_client');
  end if;

  v_q := lower(v_raw);
  if v_aliases ? v_q then
    v_q := lower(v_aliases ->> v_q);
  end if;

  v_tokens := array_remove(regexp_split_to_array(v_q, '\s+'), '');

  select max(fetched_at) into v_newest
    from products_cache where client_id = p_client_id;

  if v_newest is null then
    return jsonb_build_object(
      'ok', false, 'error', 'catalog_not_synced',
      'message', 'No product data for this store yet. Do not tell the caller the item does not exist.');
  end if;

  v_fresh := v_newest > now() - make_interval(mins => v_max_age);

  -- House vendor: not a usable search signal (finding 2).
  select count(*) into v_total
    from products_cache
   where client_id = p_client_id
     and upper(coalesce(status, 'ACTIVE')) = 'ACTIVE';

  select vendor, count(*) into v_house, v_house_n
    from products_cache
   where client_id = p_client_id
     and upper(coalesce(status, 'ACTIVE')) = 'ACTIVE'
     and nullif(trim(coalesce(vendor, '')), '') is not null
   group by vendor
   order by count(*) desc
   limit 1;

  if v_total = 0 or v_house_n is null
     or (v_house_n::numeric / greatest(v_total, 1)) <= 0.5 then
    v_house := null;
  end if;

  with base as (
    select
      p.*,
      catalog_type_of(p.product_type, p.tags, v_prefix) as derived_type,
      -- THE HOUSE VENDOR IS EXCLUDED FROM THE HAYSTACK, not just from the boost.
      -- "Tsunami.store" sits on all 52 products, so leaving it in gave every one
      -- of them a 0.70 substring hit for the query "tsunami" — the whole
      -- catalogue matched, drowning the four products actually NAMED Tsunami
      -- something. Neutralising the exact-vendor score alone was not enough.
      lower(concat_ws(' ', p.title, p.product_type,
                      case when v_house is not null and p.vendor = v_house
                           then null else p.vendor end,
                      array_to_string(p.tags, ' '))) as hay
    from products_cache p
    where p.client_id = p_client_id
      and upper(coalesce(p.status, 'ACTIVE')) = 'ACTIVE'
  ),
  scored as (
    select
      b.*,
      (
        select count(*)
        from unnest(v_tokens) tok
        where length(tok) >= 3 and b.hay like '%' || tok || '%'
      )::numeric as tok_hits,
      greatest(
        case when lower(b.handle) = v_q or lower(b.title) = v_q then 1.00 else 0 end,
        -- Derived, so "flower" reaches all 52 rather than the 4 with a Type set.
        case when lower(b.derived_type) = v_q                   then 0.95 else 0 end,
        -- Vendor only counts when it ISN'T the storefront's own name.
        case
          when v_house is not null and lower(v_house) = v_q then 0
          when lower(coalesce(b.vendor, '')) = v_q          then 0.88
          else 0
        end,
        -- Tag match, suffix-aware: "indica" matches strain-indica at full weight.
        case when exists (
          select 1 from unnest(b.tags) t
           where lower(t) = v_q
              or lower(t) like '%-' || v_q
              or lower(replace(t, '-', ' ')) = v_q
        ) then 0.86 else 0 end,
        word_similarity(v_q, lower(b.title)) * 0.90,
        case when b.hay like '%' || v_q || '%'                  then 0.70 else 0 end,
        similarity(lower(b.title), v_q) * 0.60
      ) as sig
    from base b
  ),
  ranked as (
    select
      s.*,
      greatest(
        s.sig,
        case
          when cardinality(v_tokens) > 0
            then (s.tok_hits / cardinality(v_tokens)) * 0.75
          else 0
        end
      ) as score
    from scored s
  ),
  -- `above` is every product clearing the floor. total_matches comes from HERE
  -- rather than a second query duplicating the match logic — two copies of these
  -- rules would silently drift apart on the next tweak.
  above as (
    select * from ranked r
    -- FLOOR TUNED AGAINST THE REAL CATALOGUE (68 products, scored with pg_trgm's
    -- own algorithm, 2026-07-29). The bands separate cleanly:
    --   exact word present in the title  -> 0.90
    --   fuzzy near-word                  -> 0.24 to 0.28
    -- At the old 0.20, "gummies" scored 0.245 against "Gumbo" — a store selling
    -- no gummies would have offered one. 0.30 drops that while keeping genuine
    -- near-misses like "gushers" -> "White Gusherz" (0.54). Junk ("televisions",
    -- "laptop", "vape pen") scored 0 either way.
    where r.score >= 0.30
  )
  select
    coalesce(jsonb_agg(m order by m.score desc, m.title), '[]'::jsonb),
    count(*),
    (select count(*) from above)
  into v_matches, v_count, v_total_matches
  from (
    select
      r.title,
      -- The derived type, so the agent can say "Flower" instead of nothing.
      r.derived_type as product_type,
      r.vendor,
      r.currency,
      r.price_min,
      r.price_max,
      r.url,
      left(coalesce(r.description, ''), 400) as description,
      case when not r.tracks_inventory then null else r.available end as available,
      case
        when not r.tracks_inventory then 'none'
        when v_fresh then 'fresh'
        else 'stale'
      end as stock_confidence,
      case when v_fresh then r.total_inventory else null end as total_inventory,
      r.variants,
      round(r.score::numeric, 3) as score
    from above r
    order by r.score desc, r.title
    limit v_limit
  ) m;

  -- A query that matched far more than we can read out is a BROAD query, not a
  -- product lookup. "Flower" hits all 52; naming three alphabetically is a worse
  -- answer than asking whether they want indica, sativa or hybrid.
  v_broad := coalesce(v_total_matches, 0) > v_limit;

  return jsonb_build_object(
    'ok',              true,
    'query',           v_raw,
    'resolved_query',  v_q,
    'fresh',           v_fresh,
    'fetched_at',      v_newest,
    'max_age_minutes', v_max_age,
    'match_count',     coalesce(v_count, 0),
    'total_matches',   coalesce(v_total_matches, 0),
    'broad',           v_broad,
    'matches',         v_matches,
    -- Catalogue comes back on a MISS (so the agent offers options instead of a
    -- dead end) and on a BROAD hit (so it can narrow instead of guessing).
    'catalog',         case
                         when coalesce(v_count, 0) = 0 or v_broad
                           then catalog_overview(p_client_id)
                         else null
                       end
  );
end;
$$;

revoke execute on function catalog_type_of(text, text[], text) from public;
grant  execute on function catalog_type_of(text, text[], text) to authenticated, service_role;

revoke execute on function catalog_overview(uuid, int, int, int) from public;
grant  execute on function catalog_overview(uuid, int, int, int) to authenticated, service_role;

revoke execute on function search_products(uuid, text, int) from public;
grant  execute on function search_products(uuid, text, int) to authenticated, service_role;

comment on function catalog_type_of(text, text[], text) is
  'Product category, falling back to a tag prefix when product_type is blank (as it is for 47 of 52 Tsunami products).';

-- End of 0020.
