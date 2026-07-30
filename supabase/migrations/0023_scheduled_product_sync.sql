-- =============================================================================
-- 0023_scheduled_product_sync.sql
-- Run the catalog sync automatically, for every client, forever.
--
-- WHY THIS IS NOT OPTIONAL. Migration 0021 changed stock_policy to 'always':
-- the agent now states stock no matter how old the snapshot is. That was the
-- right call for caller experience, but it moved the risk rather than removing
-- it — under 'always', a sync that quietly stops does not degrade into "I can't
-- confirm", it degrades into the agent CONFIDENTLY quoting a dead snapshot for
-- as long as nobody notices. **Sync liveness is now the safety mechanism**, and
-- a safety mechanism that depends on someone remembering to run curl per client
-- is not a safety mechanism.
--
-- WHY pg_cron CALLS THE EDGE FUNCTION RATHER THAN THE FUNCTION LOOPING ITSELF:
--   • Per-client isolation. One client's dead store, expired key or rate-limited
--     host fails that client's row and nothing else. A single function looping
--     every tenant would let the slowest store consume the whole invocation
--     budget and starve the rest.
--   • Edge functions have a wall-clock limit. 200 clients x a paginated catalog
--     will exceed it; 200 independent short calls will not.
--   • The monitor already lives in SQL (products_staleness, 0021). Putting the
--     scheduler next to it means "is it running" and "is it fresh" are one query.
--
-- REQUIRES: pg_cron and pg_net. Both ship with Supabase but are OFF by default —
-- enable them in Dashboard → Database → Extensions, or let the guarded
-- `create extension` below do it. If either is missing this migration still
-- applies cleanly and simply schedules nothing, so `db push` never breaks on a
-- local Postgres that lacks them.
--
-- SETUP AFTER APPLYING (two Vault secrets, once per project):
--   select vault.create_secret(
--     'https://<ref>.functions.supabase.co/product-sync', 'product_sync_url', '');
--   select vault.create_secret('<VOICE_TOOL_SECRET>', 'voice_tool_secret', '');
-- Then verify with:  select * from product_sync_targets;
--                    select run_due_product_syncs();
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Per-client sync cadence.
--
-- settings.product_sync_interval_minutes, default 120. A store that restocks
-- constantly can tighten it without a deploy; -1 disables the client entirely
-- (for a client whose catalog is maintained by hand, or one that is paused).
--
-- The default is deliberately NOT tied to product_cache_max_age_minutes: that
-- one describes how old data may be before it is called stale, this one is how
-- often we go looking. Syncing exactly at the staleness boundary guarantees a
-- window where every answer is stale.
-- -----------------------------------------------------------------------------
create or replace view product_sync_targets with (security_invoker = true) as
select
  c.id                       as client_id,
  c.slug,
  c.store_platform,
  coalesce((c.settings ->> 'product_sync_interval_minutes')::int, 120) as interval_minutes,
  s.last_synced_at,
  s.products,
  s.age_minutes,
  -- Never synced counts as due: an empty catalog makes the agent answer "we
  -- don't sell that", which is worse than any staleness.
  (
    s.last_synced_at is null
    or s.last_synced_at
       < now() - make_interval(mins => coalesce((c.settings ->> 'product_sync_interval_minutes')::int, 120))
  ) as is_due
from clients c
left join products_staleness s on s.client_id = c.id
where c.is_active
  and c.store_platform is not null
  and c.store_base_url is not null
  and coalesce((c.settings ->> 'product_sync_interval_minutes')::int, 120) <> -1;

revoke insert, update, delete on product_sync_targets from authenticated;
grant  select on product_sync_targets to authenticated, service_role;

comment on view product_sync_targets is
  'Clients eligible for an automatic catalog sync, and whether each is due. '
  'settings.product_sync_interval_minutes (default 120, -1 disables).';

-- -----------------------------------------------------------------------------
-- 2. Fire one client's sync. Separated from the loop so it can be called by
--    hand for a single client ("resync Bud Club now") without touching cron.
--
-- Returns the pg_net request id, or null when the extension or the Vault
-- secrets are missing — null is a legible "not configured", not an exception
-- that would abort a whole scheduled run partway through.
-- -----------------------------------------------------------------------------
create or replace function request_product_sync(p_client_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url    text;
  v_secret text;
  v_req    bigint;
begin
  if to_regproc('net.http_post') is null then
    raise notice 'pg_net not installed — cannot request a sync';
    return null;
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'product_sync_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'product_sync_url / voice_tool_secret not in Vault — cannot request a sync';
    return null;
  end if;

  -- 90s: a large paginated catalog with per-product variation fetches is slow,
  -- and a timeout here would look like a failed sync when it is still running.
  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 90000)'
    into v_req
    using
      v_url,
      jsonb_build_object(
        'Content-Type', 'application/json',
        'x-voice-tool-secret', v_secret
      ),
      jsonb_build_object('client_id', p_client_id::text);

  return v_req;
end;
$$;

revoke execute on function request_product_sync(uuid) from public, authenticated;
grant  execute on function request_product_sync(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 3. The scheduled entry point. Fires every DUE client.
--
-- Deliberately fire-and-forget: pg_net queues the request and returns
-- immediately, so one unreachable store cannot block the others. The result is
-- observed through products_staleness on the next run, not by waiting here.
--
-- p_max_per_run caps the burst. Without it, the first run after a long outage
-- would post every client at once and rate-limit us against our own hosts.
-- Clients are ordered oldest-first, so a capped run always makes progress on
-- the most stale and the rest are picked up on the following tick.
-- -----------------------------------------------------------------------------
create or replace function run_due_product_syncs(p_max_per_run int default 25)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row       record;
  v_requested int := 0;
  v_skipped   int := 0;
  v_slugs     text[] := '{}';
begin
  for v_row in
    select client_id, slug
      from product_sync_targets
     where is_due
     order by last_synced_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_product_sync(v_row.client_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
      v_slugs := v_slugs || v_row.slug;
    end if;
  end loop;

  return jsonb_build_object(
    'requested', v_requested,
    'skipped',   v_skipped,
    'slugs',     to_jsonb(v_slugs),
    'ran_at',    now()
  );
end;
$$;

revoke execute on function run_due_product_syncs(int) from public, authenticated;
grant  execute on function run_due_product_syncs(int) to service_role;

-- -----------------------------------------------------------------------------
-- 4. Schedule it — every 15 minutes.
--
-- The TICK is 15 minutes; the per-client INTERVAL decides who actually gets
-- called. So a client on a 30-minute interval is served without every client
-- being hammered every 15. Guarded so this file applies on a Postgres without
-- pg_cron.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regproc('cron.schedule') is null then
    raise notice 'pg_cron not installed — automatic product sync NOT scheduled. '
                 'Enable the extension, then re-run this migration.';
    return;
  end if;

  -- Idempotent: unschedule first, since cron.schedule with the same name errors
  -- on some versions rather than replacing.
  begin
    perform cron.unschedule('product-sync-due');
  exception when others then
    null; -- not scheduled yet
  end;

  perform cron.schedule(
    'product-sync-due',
    '*/15 * * * *',
    $cron$select run_due_product_syncs();$cron$
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. The health view an operator actually looks at.
--
-- products_staleness (0021) answers "how old is this catalog". This answers the
-- question that matters once syncing is automatic: "is the scheduler doing its
-- job, and for whom is it not". A client that is `is_due` on consecutive checks
-- is a client whose sync is failing silently.
-- -----------------------------------------------------------------------------
create or replace view product_sync_health with (security_invoker = true) as
select
  t.client_id,
  t.slug,
  t.store_platform,
  t.products,
  t.last_synced_at,
  t.age_minutes,
  t.interval_minutes,
  t.is_due,
  case
    when t.products is null or t.products = 0 then 'never_synced'
    when t.age_minutes > t.interval_minutes * 3 then 'failing'
    when t.is_due                                then 'due'
    else                                              'ok'
  end as status
from product_sync_targets t;

revoke insert, update, delete on product_sync_health from authenticated;
grant  select on product_sync_health to authenticated, service_role;

comment on view product_sync_health is
  'Scheduler health per client. status: never_synced | failing | due | ok. '
  '"failing" means the catalog is more than 3 sync intervals old, i.e. the '
  'scheduled sync is erroring rather than merely pending.';

-- End of 0023.
