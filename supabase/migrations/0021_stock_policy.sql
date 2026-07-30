-- =============================================================================
-- 0021_stock_policy.sql
-- Let the agent state stock regardless of cache age. Requested 2026-07-29.
--
-- WHAT CHANGES: 0018-0020 withheld stock once products_cache aged past
-- product_cache_max_age_minutes (60 for Tsunami). The agent then had to say it
-- couldn't confirm availability. That reads as a broken agent to a caller, and
-- every storefront on earth quotes stock that could be seconds out of date, so
-- the bar was set higher for the phone line than for the website.
--
-- HOW: settings.stock_policy, two values.
--   'always' (NEW DEFAULT) — state stock whenever inventory is tracked, no matter
--                            how old the snapshot is.
--   'gated'                — the 0018 behaviour, withheld once stale. Kept for
--                            any client who wants it; nothing sets it today.
--
-- ⚠️ THE RISK MOVES, IT DOESN'T DISAPPEAR. Under 'gated', a dead sync degraded
-- into "I can't confirm" — annoying but honest. Under 'always', a dead sync
-- degrades into the agent confidently quoting whatever it last saw, for as long
-- as nobody notices. Sync liveness IS the safety mechanism now.
-- Two things make that observable rather than silent:
--   • search_products returns cache_age_minutes and stale_cache on every call,
--     so the value is in the logs whether or not it changes the answer.
--   • products_staleness (below) is a one-row-per-client view for a monitor.
--
-- catalog_not_synced is UNCHANGED. A catalogue that never synced still refuses
-- to answer — that isn't staleness, it's absence, and telling a caller "we don't
-- sell that" because a table is empty is a different and worse failure.
--
-- Idempotent (create or replace).
-- =============================================================================

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
  v_within    boolean;   -- cache is inside the configured window
  v_state     boolean;   -- may the agent state stock at all
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

  select max(fetched_at) into v_newest
    from products_cache where client_id = p_client_id;

  if v_newest is null then
    -- Absence, not staleness. Unchanged from 0018.
    return jsonb_build_object(
      'ok', false, 'error', 'catalog_not_synced',
      'message', 'No product data for this store yet. Do not tell the caller the item does not exist.');
  end if;

  v_age_min := round(extract(epoch from (now() - v_newest)) / 60.0, 1);
  v_within  := v_newest > now() - make_interval(mins => v_max_age);
  -- Anything other than an explicit 'gated' states stock, so a typo in config
  -- fails toward answering rather than toward silence.
  v_state   := (v_policy <> 'gated') or v_within;

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
      -- House vendor excluded from the haystack, not just the boost: it sits on
      -- every product, so leaving it in made the store's own name match all of
      -- them (see 0020).
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
    select * from ranked r
    -- Floor tuned against the real 68-product catalogue (see 0020): exact word
    -- matches land at 0.90, fuzzy near-words at 0.24-0.28.
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
        when v_state then 'fresh'
        else 'stale'
      end as stock_confidence,
      case when v_state then r.total_inventory else null end as total_inventory,
      r.variants,
      round(r.score::numeric, 3) as score
    from above r
    order by r.score desc, r.title
    limit v_limit
  ) m;

  v_broad := coalesce(v_total_matches, 0) > v_limit;

  return jsonb_build_object(
    'ok',                true,
    'query',             v_raw,
    'resolved_query',    v_q,
    -- `fresh` keeps its old meaning for the tool: may stock be stated.
    'fresh',             v_state,
    -- Reported ALWAYS, even when it no longer gates the answer. This is what
    -- makes a dead sync visible in the logs instead of silent.
    'stock_policy',      v_policy,
    'cache_age_minutes', v_age_min,
    'stale_cache',       not v_within,
    'fetched_at',        v_newest,
    'max_age_minutes',   v_max_age,
    'match_count',       coalesce(v_count, 0),
    'total_matches',     coalesce(v_total_matches, 0),
    'broad',             v_broad,
    'matches',           v_matches,
    'catalog',           case
                           when coalesce(v_count, 0) = 0 or v_broad
                             then catalog_overview(p_client_id)
                           else null
                         end
  );
end;
$$;

revoke execute on function search_products(uuid, text, int) from public;
grant  execute on function search_products(uuid, text, int) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- products_staleness — the monitor that replaces the gate.
--
-- security_invoker is MANDATORY: 0001's default privileges auto-grant every new
-- view to `authenticated`, and a plain view runs with its OWNER's rights,
-- bypassing RLS. Without this a signed-in tenant would see every client's row.
-- -----------------------------------------------------------------------------
create or replace view products_staleness with (security_invoker = true) as
select
  p.client_id,
  count(*)                                                as products,
  count(*) filter (where upper(coalesce(p.status,'ACTIVE')) = 'ACTIVE') as active_products,
  max(p.fetched_at)                                       as last_synced_at,
  round(extract(epoch from (now() - max(p.fetched_at))) / 60.0, 1) as age_minutes,
  max(p.fetched_at) < now() - interval '6 hours'           as sync_probably_broken
from products_cache p
group by p.client_id;

-- 0001's `alter default privileges ... on tables` covers VIEWS too, so this was
-- auto-granted insert/update/delete to `authenticated` the moment it was created.
-- Postgres would reject a write to an aggregate view anyway, but the repo
-- convention (PROJECT-STATUS §3.4) is to revoke rather than rely on that.
revoke insert, update, delete on products_staleness from authenticated;
grant  select on products_staleness to authenticated, service_role;

comment on view products_staleness is
  'Per-client catalogue freshness. With stock_policy = always, a dead sync no longer degrades the answer, so this is the only thing that reveals it.';

-- End of 0021.
