-- =============================================================================
-- 0018_products_cache.sql
-- Product catalog snapshot, so the voice agent can answer "do you carry X?"
-- and "is X in stock?" without a mid-call Shopify round trip.
--
-- SHAPED DELIBERATELY LIKE orders_cache (0001): client_id on every row, a
-- fetched_at for staleness, normalized before Claude ever reasons over it. Same
-- reasoning as the order path — the agent must never hold a live store API in
-- its latency budget, and both channels should read one shared snapshot.
--
-- WHY A CACHE AND NOT A LIVE CALL: voice latency is the product. Shopify's
-- GraphQL costs a few hundred ms mid-conversation; this table answers in tens.
-- The tradeoff is staleness, and staleness on STOCK is dangerous in a way that
-- staleness on a price band is not — a confidently spoken "yes, in stock" for
-- something sold out an hour ago is worse than declining to answer. So
-- search_products reports freshness explicitly (see stock_confidence) and the
-- agent prompt is required to branch on it.
--
-- Requires read_products on the Shopify custom app, and read_inventory for
-- variant-level quantities. The existing token is read_orders +
-- read_fulfillments only, so it must be re-scoped before the sync returns rows.
--
-- Safe to re-run.
-- =============================================================================

-- Trigram matching: callers say "gummies", the catalog says "Watermelon Gummies
-- 25mg". Exact and prefix matching both miss that; similarity does not.
create extension if not exists pg_trgm;

-- -----------------------------------------------------------------------------
-- 1. The snapshot.
-- -----------------------------------------------------------------------------
create table if not exists products_cache (
  id               uuid        primary key default gen_random_uuid(),
  client_id        uuid        not null references clients(id) on delete cascade,
  -- Shopify product gid, or the numeric id as text for Woo. Stable across
  -- renames, which `handle` and `title` are not.
  product_ref      text        not null,
  handle           text,
  title            text        not null,
  product_type     text,
  vendor           text,
  -- ACTIVE | ARCHIVED | DRAFT. Only ACTIVE is ever surfaced to a caller.
  status           text,
  tags             text[]      not null default '{}',
  -- Plain text, already stripped of HTML and truncated by the sync. A full
  -- product body is thousands of words; a voice answer wants two sentences.
  description      text,
  url              text,
  currency         text,
  price_min        numeric(12,2),
  price_max        numeric(12,2),
  tracks_inventory boolean     not null default true,
  total_inventory  int,
  -- Derived by the sync: any variant purchasable right now.
  available        boolean,
  -- [{ title, price, available, inventory }] — needed because "is the 25mg in
  -- stock" is a variant question, not a product question.
  variants         jsonb       not null default '[]'::jsonb,
  fetched_at       timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists uq_products_client_ref
  on products_cache (client_id, product_ref);
create index if not exists idx_products_client_handle
  on products_cache (client_id, handle);
create index if not exists idx_products_client_type
  on products_cache (client_id, product_type);
create index if not exists idx_products_title_trgm
  on products_cache using gin (title gin_trgm_ops);

drop trigger if exists trg_products_cache_updated_at on products_cache;
create trigger trg_products_cache_updated_at
  before update on products_cache
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Tenant isolation.
--
--    0001 ends with `alter default privileges ... grant select, insert, update,
--    delete on tables`, so this table was auto-granted to `authenticated` the
--    moment it was created. RLS scopes the rows, but the dashboard has no
--    business WRITING a store snapshot, so the write grants come back off.
-- -----------------------------------------------------------------------------
alter table products_cache enable row level security;

drop policy if exists products_cache_tenant on products_cache;
create policy products_cache_tenant on products_cache
  for all using (client_id = current_client_id())
  with check (client_id = current_client_id());

revoke insert, update, delete on products_cache from authenticated;
grant select on products_cache to authenticated;
grant select, insert, update, delete on products_cache to service_role;

-- -----------------------------------------------------------------------------
-- 3. upsert_products — bulk write from the sync.
--
--    Takes the whole catalog page as one jsonb array rather than a row per call:
--    a 200-SKU store is 200 round trips otherwise. Returns counts so the sync
--    can log something meaningful instead of assuming success.
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
    total_inventory, available, variants, fetched_at
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
        fetched_at       = excluded.fetched_at,
        updated_at       = now();

  get diagnostics v_count = row_count;

  return jsonb_build_object('ok', true, 'upserted', v_count);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. prune_products — drop rows the last sync didn't touch.
--
--    Without this, a product deleted or archived in Shopify lingers forever and
--    the agent keeps offering it. Called by the sync AFTER a successful full
--    pass, never on a partial one.
-- -----------------------------------------------------------------------------
create or replace function prune_products(
  p_client_id  uuid,
  p_synced_before timestamptz
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
  if p_client_id is null or p_synced_before is null then
    return jsonb_build_object('ok', false, 'error', 'client_id and synced_before are required');
  end if;

  delete from products_cache
   where client_id = p_client_id
     and fetched_at < p_synced_before;

  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'pruned', v_count);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. search_products — what the agent tool calls.
--
--    Returns at most p_limit ACTIVE matches, plus an explicit freshness verdict.
--
--    stock_confidence:
--      'fresh' -> cache is within the client's max age; stock may be stated.
--      'stale' -> cache is older; the agent must NOT assert stock. Price bands
--                 and descriptions are still fine, they barely move.
--      'none'  -> the client doesn't track inventory on this product.
--
--    Threshold is per-client: settings.product_cache_max_age_minutes, default
--    120. A store that restocks constantly can tighten it without a deploy.
--
--    Matching is layered, cheapest first: exact handle, then exact-ish title,
--    then trigram similarity, then product_type. The similarity floor (0.25)
--    keeps "do you sell televisions" from returning a random gummy.
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
  v_q         text := nullif(trim(coalesce(p_query, '')), '');
  v_limit     int  := least(greatest(coalesce(p_limit, 3), 1), 10);
  v_max_age   int;
  v_newest    timestamptz;
  v_fresh     boolean;
  v_matches   jsonb;
begin
  if p_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'client_id is required');
  end if;
  if v_q is null then
    return jsonb_build_object('ok', false, 'error', 'need_product_name');
  end if;

  select coalesce((settings ->> 'product_cache_max_age_minutes')::int, 120)
    into v_max_age
    from clients where id = p_client_id;

  if v_max_age is null then
    return jsonb_build_object('ok', false, 'error', 'unknown_client');
  end if;

  select max(fetched_at) into v_newest
    from products_cache where client_id = p_client_id;

  if v_newest is null then
    -- Never synced. Say so plainly rather than returning an empty match set,
    -- which the agent would otherwise read as "we don't sell that".
    return jsonb_build_object(
      'ok', false, 'error', 'catalog_not_synced',
      'message', 'No product data for this store yet. Do not tell the caller the item does not exist.');
  end if;

  v_fresh := v_newest > now() - make_interval(mins => v_max_age);

  select coalesce(jsonb_agg(row_to_json(m)::jsonb order by m.rank), '[]'::jsonb)
    into v_matches
    from (
      select
        p.title,
        p.product_type,
        p.vendor,
        p.currency,
        p.price_min,
        p.price_max,
        p.url,
        -- Trimmed hard: this is read out loud.
        left(coalesce(p.description, ''), 400) as description,
        case
          when not p.tracks_inventory then null
          else p.available
        end as available,
        case
          when not p.tracks_inventory then 'none'
          when v_fresh then 'fresh'
          else 'stale'
        end as stock_confidence,
        case when v_fresh then p.total_inventory else null end as total_inventory,
        p.variants,
        greatest(
          case when lower(p.handle) = lower(v_q) then 1.0 else 0 end,
          case when lower(p.title)  = lower(v_q) then 1.0 else 0 end,
          similarity(p.title, v_q),
          case when lower(coalesce(p.product_type, '')) = lower(v_q) then 0.9 else 0 end
        ) as score,
        row_number() over (
          order by greatest(
            case when lower(p.handle) = lower(v_q) then 1.0 else 0 end,
            case when lower(p.title)  = lower(v_q) then 1.0 else 0 end,
            similarity(p.title, v_q),
            case when lower(coalesce(p.product_type, '')) = lower(v_q) then 0.9 else 0 end
          ) desc, p.title
        ) as rank
      from products_cache p
      where p.client_id = p_client_id
        and coalesce(p.status, 'ACTIVE') = 'ACTIVE'
        and (
          lower(p.handle) = lower(v_q)
          or lower(p.title) = lower(v_q)
          or lower(coalesce(p.product_type, '')) = lower(v_q)
          or p.title % v_q
          or p.title ilike '%' || v_q || '%'
        )
      order by score desc, p.title
      limit v_limit
    ) m;

  return jsonb_build_object(
    'ok',               true,
    'query',            v_q,
    'fresh',            v_fresh,
    'fetched_at',       v_newest,
    'max_age_minutes',  v_max_age,
    'match_count',      jsonb_array_length(v_matches),
    'matches',          v_matches
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Grants. The writers are service_role only; search is readable by the
--    dashboard too (it passes its own client_id and RLS backs it up).
-- -----------------------------------------------------------------------------
revoke execute on function upsert_products(uuid, jsonb) from public;
grant  execute on function upsert_products(uuid, jsonb) to service_role;

revoke execute on function prune_products(uuid, timestamptz) from public;
grant  execute on function prune_products(uuid, timestamptz) to service_role;

revoke execute on function search_products(uuid, text, int) from public;
grant  execute on function search_products(uuid, text, int) to authenticated, service_role;

comment on table products_cache is
  'Catalog snapshot per client. Written only by the product sync; read by the voice/email agents and the dashboard.';
comment on column products_cache.fetched_at is
  'Drives search_products.stock_confidence. Stale stock must never be asserted to a caller.';

-- End of 0018.
