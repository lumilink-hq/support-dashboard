-- =============================================================================
-- 0019_product_search_matching.sql
-- Make product search survive how people actually talk.
--
-- THE PROBLEM (found on a live call, 2026-07-29): product titles carry a brand
-- plus a product name — "WAVE Super Runtz", "WAVE Zoap" — and the catalogue
-- spans several brands, not one. Callers say "Runtz", or "the wedding cake one",
-- or "indica", or just the brand. 0018's matcher failed all of those, for three
-- different reasons:
--
--   1. similarity() normalises over the WHOLE string, so
--      similarity('WAVE Super Runtz', 'runtz') sits around the 0.3 default
--      threshold — a caller who says the short name scores WORSE than one who
--      recites the full title. word_similarity() is the built-in answer: it asks
--      "does this query match a WORD inside the target", which is the actual
--      question. word_similarity('runtz', 'WAVE Super Runtz') is ~1.0.
--
--   2. A brand shared across many titles inflates similarity BETWEEN those
--      products, muddying rank. Worse, a caller naming the brand alone got no
--      strong signal at all, because the brand is only part of a longer title.
--      Brand is now matched explicitly against vendor AND as a title word.
--
--   3. tags, product_type and vendor were stored and never searched. "indica",
--      "thca" and "sativa" are exactly how customers ask for flower.
--
-- AND THE BIGGER MISS: a zero-match returned an empty list, so the agent said
-- "I couldn't find that." For a catalogue of three strains, the useful answer is
-- "we carry Flower — Super Runtz, Zoap and Wedding Cake." So a miss now comes
-- back WITH the catalogue, and the agent offers options instead of a dead end.
--
-- Idempotent (create or replace). Replaces 0018's search_products; the table and
-- the other RPCs are untouched.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- catalog_overview — what the store sells, compactly enough to read aloud.
--
-- Types with a few example names each, plus the brand list, because the
-- catalogue spans several brands and "which brands do you carry" is as common as
-- "what kinds". Capped hard on both: this gets spoken, and nobody absorbs a list
-- of thirty.
-- -----------------------------------------------------------------------------
create or replace function catalog_overview(
  p_client_id     uuid,
  p_max_types     int default 6,
  p_max_examples  int default 4,
  p_max_brands    int default 8
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'types', coalesce((
      select jsonb_agg(t order by t.n desc)
      from (
        select
          coalesce(p.product_type, 'Other') as type,
          count(*)                          as n,
          (array_agg(p.title order by p.title))[1:greatest(p_max_examples, 1)] as examples
        from products_cache p
        where p.client_id = p_client_id
          and coalesce(p.status, 'ACTIVE') = 'ACTIVE'
        group by coalesce(p.product_type, 'Other')
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
          and coalesce(p.status, 'ACTIVE') = 'ACTIVE'
          and nullif(trim(coalesce(p.vendor, '')), '') is not null
        group by p.vendor
        order by count(*) desc
        limit greatest(p_max_brands, 1)
      ) v
    ), '[]'::jsonb)
  );
$$;

-- -----------------------------------------------------------------------------
-- search_products — layered matching.
--
-- Match if ANY of these hold (cheapest first):
--   • exact handle / title / product_type
--   • the query matches a word inside the title      (word_similarity, `<%`)
--   • the query is a substring of the haystack       (title+type+vendor+tags)
--   • any query token of 3+ chars appears in the haystack
--
-- Ranked by the strongest signal, so an exact title still beats a tag brush.
-- Aliases (settings.product_aliases) are applied first, which is how "gummies"
-- reaches "Edibles" when the store never uses the caller's word.
--
-- NOTE ON COST: this scores every ACTIVE product for the tenant rather than
-- prefiltering with the trigram index. Deliberate at this catalogue size — a few
-- hundred rows scan in single-digit milliseconds, and it avoids the `%` operator's
-- threshold cliff, which is what dropped "Runtz" in the first place. If a client's
-- catalogue reaches a few thousand products, add a `hay % v_q or v_q <% title`
-- prefilter to `base` and keep the scoring identical.
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
  v_newest    timestamptz;
  v_fresh     boolean;
  v_tokens    text[];
  v_matches   jsonb;
  v_count     int;
begin
  if p_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'client_id is required');
  end if;
  if v_raw is null then
    return jsonb_build_object('ok', false, 'error', 'need_product_name');
  end if;

  select coalesce((settings ->> 'product_cache_max_age_minutes')::int, 120),
         coalesce(settings -> 'product_aliases', '{}'::jsonb)
    into v_max_age, v_aliases
    from clients where id = p_client_id;

  if v_max_age is null then
    return jsonb_build_object('ok', false, 'error', 'unknown_client');
  end if;

  -- Alias substitution, case-insensitively on the whole phrase. Keyed by what a
  -- CALLER says, valued with what the STORE calls it:
  --   {"gummies": "Edibles", "weed": "Flower", "pre roll": "Pre-Roll"}
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

  with base as (
    select
      p.*,
      lower(concat_ws(' ', p.title, p.product_type, p.vendor,
                      array_to_string(p.tags, ' '))) as hay
    from products_cache p
    where p.client_id = p_client_id
      and coalesce(p.status, 'ACTIVE') = 'ACTIVE'
  ),
  scored as (
    select
      b.*,
      -- How many of the caller's words land anywhere in the haystack. Handles
      -- "super runtz 3.5" where no single substring spans the whole phrase.
      (
        select count(*)
        from unnest(v_tokens) tok
        where length(tok) >= 3 and b.hay like '%' || tok || '%'
      )::numeric as tok_hits,
      greatest(
        case when lower(b.handle) = v_q or lower(b.title) = v_q then 1.00 else 0 end,
        case when lower(coalesce(b.product_type, '')) = v_q     then 0.95 else 0 end,
        -- Brand as a first-class query. The catalogue spans several brands, so
        -- "do you have any <brand>" is a normal question and must return that
        -- brand's products rather than scraping by on substring luck.
        case when lower(coalesce(b.vendor, '')) = v_q           then 0.88 else 0 end,
        word_similarity(v_q, lower(coalesce(b.vendor, ''))) * 0.84,
        case when v_q = any(select lower(t) from unnest(b.tags) t) then 0.80 else 0 end,
        -- The fix for "Runtz" -> "WAVE Super Runtz".
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
  )
  select
    coalesce(jsonb_agg(m order by m.score desc, m.title), '[]'::jsonb),
    count(*)
  into v_matches, v_count
  from (
    select
      r.title,
      r.product_type,
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
    from ranked r
    -- 0.20 floor: loose enough for a single tag or a partial name, tight enough
    -- that "do you sell televisions" returns nothing rather than a random strain.
    where r.score >= 0.20
    order by r.score desc, r.title
    limit v_limit
  ) m;

  return jsonb_build_object(
    'ok',              true,
    'query',           v_raw,
    'resolved_query',  v_q,
    'fresh',           v_fresh,
    'fetched_at',      v_newest,
    'max_age_minutes', v_max_age,
    'match_count',     coalesce(v_count, 0),
    'matches',         v_matches,
    -- On a miss, hand back the catalogue so the agent can offer real options
    -- instead of "I couldn't find that". This is the difference between a dead
    -- end and a sale.
    'catalog',         case
                         when coalesce(v_count, 0) = 0
                           then catalog_overview(p_client_id)
                         else null
                       end
  );
end;
$$;

revoke execute on function catalog_overview(uuid, int, int, int) from public;
grant  execute on function catalog_overview(uuid, int, int, int) to authenticated, service_role;

revoke execute on function search_products(uuid, text, int) from public;
grant  execute on function search_products(uuid, text, int) to authenticated, service_role;

comment on function search_products(uuid, text, int) is
  'Layered product match: exact, word_similarity, substring, token coverage. Returns catalog_overview on a miss.';

-- End of 0019.
