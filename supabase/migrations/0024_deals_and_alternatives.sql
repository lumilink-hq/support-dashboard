-- =============================================================================
-- 0024_deals_and_alternatives.sql
-- Two gaps that made the agent sound worse than the website.
--
-- GAP 1 — DEALS WERE INVISIBLE. products_cache stored the CURRENT price and
-- nothing else, so a product marked down from $50 to $25 looked identical to one
-- that has always cost $25. On a store whose entire merchandising is discounts
-- (Bud Club runs BOGO, ounce specials and bulk tiers on the homepage), the two
-- most natural questions a caller can ask — "what deals do you have?" and "is
-- that on sale?" — could not be answered at all. Worse, the agent would quote
-- $25 flat while the customer was looking at a page shouting "$50 $25", which
-- reads as the bot not knowing its own store.
--
-- GAP 2 — AN OUT-OF-STOCK MATCH WAS A DEAD END. A found-but-unavailable product
-- returned `available: false` and stopped. That is the single most common way a
-- product call ends badly: the caller named the one thing that is sold out, and
-- the agent had nothing to offer even though eleven similar products were in
-- stock. `alternatives` fixes that, and it deliberately only appears when
-- EVERYTHING matched is unavailable — offering substitutes for something the
-- store actually has in stock is pushy and unhelpful.
--
-- Both are additive. Existing callers that ignore the new fields behave exactly
-- as before.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Columns.
--
-- compare_at_* is the "was" price (Shopify compareAtPrice, Woo regular_price).
-- NULL means "no reference price", which is NOT the same as "not discounted" —
-- a store can flag on_sale without publishing a struck-through price, so the two
-- are stored independently rather than deriving one from the other.
-- -----------------------------------------------------------------------------
alter table products_cache
  add column if not exists on_sale        boolean not null default false,
  add column if not exists compare_at_min numeric(12,2),
  add column if not exists compare_at_max numeric(12,2);

comment on column products_cache.on_sale is
  'Platform says this product is discounted right now.';
comment on column products_cache.compare_at_min is
  'The "was" price (lowest across variants). NULL = no reference price published.';

-- Partial index: deal queries only ever look at discounted rows, and on most
-- catalogs that is a small minority.
create index if not exists idx_products_client_on_sale
  on products_cache (client_id) where on_sale;

-- -----------------------------------------------------------------------------
-- 2. upsert_products — carry the three new fields.
--
-- Supersedes 0018. Every existing field is unchanged; adapters that don't send
-- the new keys get `on_sale = false` and NULL reference prices, which is the
-- correct reading of "this platform didn't tell us".
-- -----------------------------------------------------------------------------
create or replace function upsert_products(
  p_client_id uuid,
  p_products  jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  if p_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'client_id is required');
  end if;
  if not exists (select 1 from clients where id = p_client_id) then
    return jsonb_build_object('ok', false, 'error', 'unknown_client');
  end if;
  if p_products is null or jsonb_typeof(p_products) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'products must be a jsonb array');
  end if;

  insert into products_cache (
    client_id, product_ref, handle, title, product_type, vendor, status, tags,
    description, url, currency, price_min, price_max, tracks_inventory,
    total_inventory, available, variants, on_sale, compare_at_min,
    compare_at_max, fetched_at
  )
  select
    p_client_id,
    p ->> 'product_ref',
    p ->> 'handle',
    coalesce(p ->> 'title', '(untitled)'),
    p ->> 'product_type',
    p ->> 'vendor',
    p ->> 'status',
    coalesce(
      (select array_agg(t) from jsonb_array_elements_text(
         case when jsonb_typeof(p -> 'tags') = 'array' then p -> 'tags' else '[]'::jsonb end
       ) t),
      '{}'
    ),
    p ->> 'description',
    p ->> 'url',
    p ->> 'currency',
    (p ->> 'price_min')::numeric,
    (p ->> 'price_max')::numeric,
    coalesce((p ->> 'tracks_inventory')::boolean, true),
    (p ->> 'total_inventory')::int,
    (p ->> 'available')::boolean,
    case when jsonb_typeof(p -> 'variants') = 'array' then p -> 'variants' else '[]'::jsonb end,
    coalesce((p ->> 'on_sale')::boolean, false),
    (p ->> 'compare_at_min')::numeric,
    (p ->> 'compare_at_max')::numeric,
    now()
  from jsonb_array_elements(p_products) p
  where nullif(trim(coalesce(p ->> 'product_ref', '')), '') is not null
  on conflict (client_id, product_ref) do update
    set handle           = excluded.handle,
        title            = excluded.title,
        product_type     = excluded.product_type,
        vendor           = excluded.vendor,
        status           = excluded.status,
        tags             = excluded.tags,
        description      = excluded.description,
        url              = excluded.url,
        currency         = excluded.currency,
        price_min        = excluded.price_min,
        price_max        = excluded.price_max,
        tracks_inventory = excluded.tracks_inventory,
        total_inventory  = excluded.total_inventory,
        available        = excluded.available,
        variants         = excluded.variants,
        on_sale          = excluded.on_sale,
        compare_at_min   = excluded.compare_at_min,
        compare_at_max   = excluded.compare_at_max,
        fetched_at       = excluded.fetched_at,
        updated_at       = now();

  get diagnostics v_count = row_count;

  return jsonb_build_object('ok', true, 'upserted', v_count);
end;
$$;

revoke execute on function upsert_products(uuid, jsonb) from public, authenticated;
grant  execute on function upsert_products(uuid, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 3. Is this a "what's on sale" question?
--
-- Kept as its own function so the vocabulary is testable and editable without
-- touching search_products. Matched on WORD BOUNDARIES: 'sale' as a substring
-- also occurs in "wholesale" and, more to the point, would fire on a product
-- literally named something containing it.
--
-- Deliberately NOT matched: "cheap", "cheapest", "budget", "under twenty". Those
-- are price-SORT questions, not discount questions, and answering them with the
-- discount list would be wrong — the cheapest product is frequently not on sale.
-- -----------------------------------------------------------------------------
create or replace function is_deals_query(p_query text)
returns boolean
language sql
immutable
as $$
  select coalesce(
    lower(coalesce(p_query, '')) ~
      '(^|\s)(deal|deals|sale|sales|discount|discounts|discounted|special|specials|promo|promos|promotion|promotions|offer|offers|bogo|clearance|markdown|marked\s+down|on\s+sale|buy\s+one)($|\s)',
    false
  );
$$;

comment on function is_deals_query(text) is
  'True when a product query is asking about discounts rather than naming a product.';

-- -----------------------------------------------------------------------------
-- 4. search_products — deals intent + alternatives.
--
-- Supersedes 0021. Changes, all additive:
--   • `is_deals_query` short-circuits into a discount listing ranked by how big
--     the saving is, because "what's the best deal" is the implied question.
--   • every match now carries on_sale / was_price / discount_pct.
--   • `alternatives` appears only when every match is out of stock.
--
-- Everything else — scoring, the 0.30 floor, house-vendor suppression, the
-- stock-policy gate, catalog_overview on a miss — is unchanged from 0021/0020.
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
  v_policy    text;
  v_aliases   jsonb;
  v_prefix    text;
  v_newest    timestamptz;
  v_age_min   numeric;
  v_within    boolean;
  v_state     boolean;
  v_tokens    text[];
  v_house     text;
  v_house_n   int;
  v_total     int;
  v_matches   jsonb;
  v_count     int;
  v_total_matches int;
  v_broad     boolean;
  v_deals     boolean;
  v_deal_total int;
  v_alts      jsonb;
  v_all_out   boolean;
  v_top_type  text;
begin
  if p_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'client_id is required');
  end if;
  if v_raw is null then
    return jsonb_build_object('ok', false, 'error', 'need_product_name');
  end if;

  select coalesce((settings ->> 'product_cache_max_age_minutes')::int, 120),
         lower(coalesce(settings ->> 'stock_policy', 'always')),
         coalesce(settings -> 'product_aliases', '{}'::jsonb),
         coalesce(settings ->> 'product_type_tag_prefix', 'format-')
    into v_max_age, v_policy, v_aliases, v_prefix
    from clients where id = p_client_id;

  if v_max_age is null then
    return jsonb_build_object('ok', false, 'error', 'unknown_client');
  end if;

  v_q := lower(v_raw);
  if v_aliases ? v_q then
    v_q := lower(v_aliases ->> v_q);
  end if;

  v_tokens := array_remove(regexp_split_to_array(v_q, '\s+'), '');
  v_deals  := is_deals_query(v_q);

  select max(fetched_at) into v_newest
    from products_cache where client_id = p_client_id;

  if v_newest is null then
    return jsonb_build_object(
      'ok', false, 'error', 'catalog_not_synced',
      'message', 'No product data for this store yet. Do not tell the caller the item does not exist.');
  end if;

  v_age_min := round(extract(epoch from (now() - v_newest)) / 60.0, 1);
  v_within  := v_newest > now() - make_interval(mins => v_max_age);
  v_state   := (v_policy <> 'gated') or v_within;

  -- ===========================================================================
  -- DEALS PATH. A discount question is not a product-name question, so it does
  -- not go through the matcher at all — scoring "what's on sale" against product
  -- titles returns whichever product happens to be called something similar.
  -- ===========================================================================
  if v_deals then
    select count(*) into v_deal_total
      from products_cache
     where client_id = p_client_id
       and upper(coalesce(status, 'ACTIVE')) = 'ACTIVE'
       and on_sale
       -- An out-of-stock deal is not a deal. Offering one is the fastest way to
       -- turn an enthusiastic caller into a disappointed one.
       and (not tracks_inventory or coalesce(available, true));

    select coalesce(jsonb_agg(d order by d.discount_pct desc nulls last, d.title), '[]'::jsonb)
      into v_matches
      from (
        select
          p.title,
          catalog_type_of(p.product_type, p.tags, v_prefix) as product_type,
          p.vendor,
          p.currency,
          p.price_min,
          p.price_max,
          p.url,
          left(coalesce(p.description, ''), 400) as description,
          case when not p.tracks_inventory then null else p.available end as available,
          case
            when not p.tracks_inventory then 'none'
            when v_state then 'fresh'
            else 'stale'
          end as stock_confidence,
          p.variants,
          true as on_sale,
          p.compare_at_min as was_price,
          -- Only a real, higher reference price yields a percentage. A
          -- compare_at at or below the current price is a data error, and
          -- announcing "0% off" or a negative saving is worse than silence.
          case
            when p.compare_at_min is not null
             and p.price_min is not null
             and p.compare_at_min > p.price_min
            then round((1 - (p.price_min / p.compare_at_min)) * 100)
            else null
          end as discount_pct
        from products_cache p
        where p.client_id = p_client_id
          and upper(coalesce(p.status, 'ACTIVE')) = 'ACTIVE'
          and p.on_sale
          and (not p.tracks_inventory or coalesce(p.available, true))
        order by
          case
            when p.compare_at_min is not null and p.price_min is not null
             and p.compare_at_min > p.price_min
            then (1 - (p.price_min / p.compare_at_min))
            else 0
          end desc,
          p.title
        limit v_limit
      ) d;

    return jsonb_build_object(
      'ok',                true,
      'query',             v_raw,
      'resolved_query',    v_q,
      'intent',            'deals',
      'fresh',             v_state,
      'stock_policy',      v_policy,
      'cache_age_minutes', v_age_min,
      'stale_cache',       not v_within,
      'fetched_at',        v_newest,
      'match_count',       jsonb_array_length(v_matches),
      'total_matches',     coalesce(v_deal_total, 0),
      'broad',             coalesce(v_deal_total, 0) > v_limit,
      'matches',           v_matches,
      -- No deals at all is a real answer, and the agent must say so rather than
      -- inventing one. The catalogue is attached so it can pivot to what IS
      -- carried instead of ending the call.
      'catalog',           case when coalesce(v_deal_total, 0) = 0
                                then catalog_overview(p_client_id) else null end
    );
  end if;

  -- ===========================================================================
  -- NORMAL PATH — unchanged from 0021 except for the three new match fields.
  -- ===========================================================================
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

  -- Everything the response needs comes out of ONE statement: the match list,
  -- the pre-limit total, whether every hit is unavailable, and the dominant
  -- type for substitution. The function is STABLE, so no temp table and no
  -- second scoring pass — a second pass would also risk the two disagreeing
  -- about the floor, which is exactly the kind of drift that produces a
  -- "0 matches but broad = true" response.
  with base as (
    select
      p.*,
      catalog_type_of(p.product_type, p.tags, v_prefix) as derived_type,
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
        case when lower(b.derived_type) = v_q                   then 0.95 else 0 end,
        case
          when v_house is not null and lower(v_house) = v_q then 0
          when lower(coalesce(b.vendor, '')) = v_q          then 0.88
          else 0
        end,
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
  above as (
    select * from ranked r where r.score >= 0.30
  ),
  top as (
    select * from above order by score desc, title limit v_limit
  ),
  spoken as (
    select
      t.title,
      t.derived_type as product_type,
      t.vendor,
      t.currency,
      t.price_min,
      t.price_max,
      t.url,
      left(coalesce(t.description, ''), 400) as description,
      case when not t.tracks_inventory then null else t.available end as available,
      case
        when not t.tracks_inventory then 'none'
        when v_state then 'fresh'
        else 'stale'
      end as stock_confidence,
      case when v_state then t.total_inventory else null end as total_inventory,
      t.variants,
      t.on_sale,
      t.compare_at_min as was_price,
      case
        when t.on_sale and t.compare_at_min is not null and t.price_min is not null
         and t.compare_at_min > t.price_min
        then round((1 - (t.price_min / t.compare_at_min)) * 100)
        else null
      end as discount_pct,
      round(t.score::numeric, 3) as score
    from top t
  )
  select
    coalesce(jsonb_agg(to_jsonb(s) order by s.score desc, s.title), '[]'::jsonb),
    count(*),
    (select count(*) from above),
    -- "every hit is unavailable". `available` is null when a product isn't
    -- inventory-tracked; coalescing to TRUE means an untracked product is never
    -- counted as out of stock, so we never offer substitutes for something we
    -- simply don't count.
    (select bool_and(coalesce(sp.available, true) = false) from spoken sp),
    (select sp.product_type from spoken sp
      where sp.product_type is not null
      order by sp.score desc limit 1)
  into v_matches, v_count, v_total_matches, v_all_out, v_top_type
  from spoken s;

  v_broad := coalesce(v_total_matches, 0) > v_limit;

  -- ---------------------------------------------------------------------------
  -- ALTERNATIVES. Only when we found something AND every single hit is
  -- unavailable. Two guards worth keeping:
  --   • `v_state` — if stock is being withheld as stale we do not know anything
  --     is out of stock, so there is nothing to substitute for.
  --   • not `v_broad` — on a broad query the agent is being told to narrow, and
  --     substitutes on top of that is two instructions at once.
  -- ---------------------------------------------------------------------------
  if v_state and coalesce(v_count, 0) > 0 and coalesce(v_all_out, false) and not v_broad then
    select coalesce(jsonb_agg(a order by a.on_sale desc, a.title), '[]'::jsonb)
      into v_alts
      from (
        select
          p.title,
          p.price_min,
          p.price_max,
          p.currency,
          p.on_sale
        from products_cache p
        where p.client_id = p_client_id
          and upper(coalesce(p.status, 'ACTIVE')) = 'ACTIVE'
          and (not p.tracks_inventory or coalesce(p.available, false))
          and not exists (
            select 1 from jsonb_array_elements(v_matches) mm
             where mm ->> 'title' = p.title
          )
          -- Same kind of thing first; if the type is unknown, anything in stock
          -- beats nothing, because the alternative to a substitute here is the
          -- caller hanging up.
          and (
            v_top_type is null
            or catalog_type_of(p.product_type, p.tags, v_prefix) = v_top_type
          )
        order by p.on_sale desc, p.title
        limit 3
      ) a;
  end if;

  return jsonb_build_object(
    'ok',                true,
    'query',             v_raw,
    'resolved_query',    v_q,
    'intent',            'product',
    'fresh',             v_state,
    'stock_policy',      v_policy,
    'cache_age_minutes', v_age_min,
    'stale_cache',       not v_within,
    'fetched_at',        v_newest,
    'max_age_minutes',   v_max_age,
    'match_count',       coalesce(v_count, 0),
    'total_matches',     coalesce(v_total_matches, 0),
    'broad',             v_broad,
    'matches',           v_matches,
    'all_out_of_stock',  coalesce(v_all_out, false) and coalesce(v_count, 0) > 0,
    'alternatives',      v_alts,
    'catalog',           case
                           when coalesce(v_count, 0) = 0 or v_broad
                             then catalog_overview(p_client_id)
                           else null
                         end
  );
end;
$$;

revoke execute on function search_products(uuid, text, int) from public;
grant  execute on function search_products(uuid, text, int) to service_role, authenticated;

-- End of 0024.
