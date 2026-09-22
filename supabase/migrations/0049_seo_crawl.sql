-- =============================================================================
-- 0049_seo_crawl.sql
-- Module 6 (plan.md): crawl and on-page audit. Also widens job_attempts
-- (0048) to support PER-LOCATION scheduling, which every remaining Phase 2
-- job needs (crawl and rank tracking are per-location; a client with 5
-- locations needs 5 independent backoff/dedup states, not one shared one).
--
-- WHY THE job_attempts WIDENING HAPPENS HERE, NOT AS ITS OWN MIGRATION. It's
-- only needed because of what this migration adds (seo_crawl as a job type),
-- and bundling it with the first real consumer is the same reasoning 0048
-- gave for retrofitting google-token-refresh rather than shipping the shared
-- layer with zero consumers.
--
-- entity_id IS DELIBERATELY UNTYPED (no FK). What it points at depends on
-- job_type — seo_locations.id for 'seo_crawl', a keyword id for a future
-- rank-tracking job type, null for a client-level job like
-- 'google_token_refresh'. Same free-text-by-design reasoning as
-- billing_events.feature or seo_findings.finding_type: the set of job types
-- is expected to grow through Phase 2, and a FK would need to point at a
-- different table per row, which Postgres can't express.
--
-- start_job_attempt/complete_job_attempt are DROPPED FIRST before being
-- recreated with the new trailing parameter — same reason 0031/0044 do this
-- for apply_billing_event: adding a parameter via a bare CREATE OR REPLACE
-- changes the argument-type signature, which creates a SECOND overloaded
-- function rather than replacing the first, and complete_job_attempt is
-- called via PostgREST .rpc() (from google-token-refresh), so an ambiguous
-- overload would 500 every call.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. job_attempts: surrogate PK + entity_id, so client_id+job_type is no
--    longer forced to be unique on its own.
-- -----------------------------------------------------------------------------
alter table job_attempts add column if not exists id uuid default gen_random_uuid();
update job_attempts set id = gen_random_uuid() where id is null;
alter table job_attempts alter column id set not null;
alter table job_attempts add column if not exists entity_id uuid;

do $$ begin
  alter table job_attempts drop constraint job_attempts_pkey;
exception when undefined_object then null; end $$;

do $$ begin
  alter table job_attempts add constraint job_attempts_pkey primary key (id);
exception when duplicate_object then null; end $$;

-- NULL entity_id means "client-level job" (google_token_refresh today).
-- Postgres treats NULL <> NULL in a plain unique index, which would let
-- duplicate (client_id, job_type, null) rows through — coalesce to a sentinel
-- so client-level jobs are still deduped correctly, same fix 0042's
-- seo_rankings grid_row/grid_col defaulting to 0 (not null) already used for
-- an identical reason.
drop index if exists idx_job_attempts_unique;
create unique index idx_job_attempts_unique
  on job_attempts (client_id, job_type, coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid));

drop index if exists idx_job_attempts_due;
create index idx_job_attempts_due
  on job_attempts(job_type, next_run_at) where status <> 'running';

drop function if exists start_job_attempt(uuid, text, int);

create or replace function start_job_attempt(
  p_client_id uuid,
  p_job_type  text,
  p_entity_id uuid default null,
  p_max_inflight_minutes int default 30
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_claimed boolean;
begin
  insert into job_attempts (client_id, job_type, entity_id, status, next_run_at)
  values (p_client_id, p_job_type, p_entity_id, 'idle', now())
  on conflict (client_id, job_type, coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do nothing;

  update job_attempts
     set status = 'running',
         dispatched_at = now(),
         last_run_at = now()
   where client_id = p_client_id
     and job_type = p_job_type
     and entity_id is not distinct from p_entity_id
     and next_run_at <= now()
     and (
       status <> 'running'
       or dispatched_at < now() - make_interval(mins => p_max_inflight_minutes)
     );

  get diagnostics v_claimed = row_count;
  return coalesce(v_claimed, false) and v_claimed;
end;
$$;

revoke execute on function start_job_attempt(uuid, text, uuid, int) from public, authenticated;
grant execute on function start_job_attempt(uuid, text, uuid, int) to service_role;

drop function if exists complete_job_attempt(uuid, text, boolean, text, int, int);

create or replace function complete_job_attempt(
  p_client_id      uuid,
  p_job_type       text,
  p_success        boolean,
  p_error          text default null,
  p_base_interval_minutes int default 15,
  p_max_backoff_minutes   int default 240,
  p_entity_id      uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_success then
    update job_attempts
       set status = 'idle',
           attempt_count = 0,
           last_success_at = now(),
           last_error = null,
           next_run_at = now() + make_interval(mins => p_base_interval_minutes)
     where client_id = p_client_id and job_type = p_job_type
       and entity_id is not distinct from p_entity_id;
  else
    update job_attempts
       set status = 'failed',
           attempt_count = attempt_count + 1,
           last_error = p_error,
           next_run_at = now() + least(
             make_interval(mins => p_base_interval_minutes) * (2 ^ least(attempt_count + 1, 10)),
             make_interval(mins => p_max_backoff_minutes)
           )
     where client_id = p_client_id and job_type = p_job_type
       and entity_id is not distinct from p_entity_id;
  end if;
end;
$$;

revoke execute on function complete_job_attempt(uuid, text, boolean, text, int, int, uuid) from public, authenticated;
grant execute on function complete_job_attempt(uuid, text, boolean, text, int, int, uuid) to service_role;

-- DROP FIRST: entity_id is inserted before columns that already exist in the
-- shipped 0048 view (status, attempt_count, ...), and CREATE OR REPLACE VIEW
-- can only APPEND trailing columns, not change existing column positions.
drop view if exists job_attempts_health;
create view job_attempts_health with (security_invoker = true) as
select
  client_id, job_type, entity_id, status, attempt_count, next_run_at,
  last_run_at, last_success_at, last_error,
  case
    when attempt_count >= 5 then 'failing'
    when status = 'running' and dispatched_at < now() - interval '30 minutes' then 'stuck'
    else 'ok'
  end as health
from job_attempts;

revoke all on job_attempts_health from authenticated, anon;
grant select on job_attempts_health to service_role;

-- =============================================================================
-- 2. Crawl status on seo_locations — the "fail clearly instead of returning
--    empty results" requirement needs somewhere machine-readable to live,
--    separate from the individual findings (which are the human-visible
--    signal; this is what the scheduler/health view reads).
-- =============================================================================
alter table seo_locations
  add column if not exists last_crawled_at timestamptz,
  add column if not exists crawl_status text
      check (crawl_status is null or crawl_status in ('ok', 'js_rendered', 'fetch_failed', 'robots_disallowed')),
  add column if not exists crawl_error text;

comment on column seo_locations.crawl_status is
  'Last seo-crawl outcome. js_rendered/fetch_failed/robots_disallowed all also '
  'write a critical seo_findings row (module=crawl) — this column is the '
  'machine-readable mirror for the scheduler/health view, not a substitute '
  'for the human-visible finding.';

-- -----------------------------------------------------------------------------
-- 3. Scheduling: same pg_cron -> pg_net -> edge function shape as 0023/0046,
--    now per-LOCATION via job_attempts.entity_id.
-- -----------------------------------------------------------------------------
create or replace view seo_crawl_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  l.website_url,
  l.last_crawled_at,
  l.crawl_status,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from seo_locations l
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_crawl' and ja.entity_id = l.id
where l.is_active
  and l.website_url is not null;

revoke all on seo_crawl_targets from authenticated, anon;
grant select on seo_crawl_targets to service_role;

create or replace function request_seo_crawl(p_location_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client_id uuid;
  v_url    text;
  v_secret text;
  v_req    bigint;
begin
  select client_id into v_client_id from seo_locations where id = p_location_id;
  if v_client_id is null then
    return null;
  end if;

  if to_regproc('net.http_post') is null then
    raise notice 'pg_net not installed — cannot request a crawl';
    return null;
  end if;

  if not start_job_attempt(v_client_id, 'seo_crawl', p_location_id) then
    return null;  -- not due yet, or already in flight
  end if;

  -- Crawling a client's OWN site has no third-party rate-limit concern
  -- (unlike DataForSEO/Google/etc, module 7/15/18/20's vendor), so no
  -- check_and_reserve_vendor_budget call here — this fetches the client's
  -- own server, politely (robots.txt + a sequential gap), same as kb-ingest.

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_crawl_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_crawl_url / voice_tool_secret not in Vault — cannot request a crawl';
    perform complete_job_attempt(v_client_id, 'seo_crawl', false, 'missing_vault_secret',
                                  10080, 1440, p_location_id);  -- weekly base, 1-day cap
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 60000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('location_id', p_location_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = v_client_id and job_type = 'seo_crawl' and entity_id = p_location_id;

  return v_req;
end;
$$;

revoke execute on function request_seo_crawl(uuid) from public, authenticated;
grant execute on function request_seo_crawl(uuid) to service_role;

create or replace function run_due_seo_crawls(p_max_per_run int default 25)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row       record;
  v_requested int := 0;
  v_skipped   int := 0;
begin
  for v_row in
    select location_id from seo_crawl_targets
     where is_due
     order by last_crawled_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_crawl(v_row.location_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_crawls(int) from public, authenticated;
grant execute on function run_due_seo_crawls(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic SEO crawl NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-crawl-due');
  exception when others then null;
  end;
  -- Weekly per plan.md's scheduled-jobs table (§4: "Site crawl + technical
  -- audit | Weekly, per site"). Hourly tick, like the others — the weekly
  -- cadence lives in complete_job_attempt's base interval (10080 min), not
  -- the cron tick itself, so a client added mid-week is picked up within the
  -- hour rather than waiting for a fixed weekly cron slot.
  perform cron.schedule('seo-crawl-due', '0 * * * *', $cron$select run_due_seo_crawls();$cron$);
end;
$$;

-- End of 0049.
