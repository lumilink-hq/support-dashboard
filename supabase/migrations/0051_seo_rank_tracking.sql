-- =============================================================================
-- 0051_seo_rank_tracking.sql
-- Module 7 (plan.md): DataForSEO rank tracking — 30 keywords (organic + local
-- pack) weekly, plus a 5x5 geo grid on priority keywords.
--
-- ASYNC, UNLIKE EVERY VENDOR CALL SO FAR. DataForSEO's "standard queue" (what
-- plan.md specs, cheaper than "live") is submit-now/collect-later: POST a
-- task, get a task id back, the result isn't ready for minutes. Every other
-- integration this build has done (Google, PageSpeed, Search Console) is a
-- single request/response. That needs a table job_attempts was never meant
-- to hold — job_attempts tracks "is (client, job_type, entity) due", not
-- "here are 30 individual DataForSEO task ids in flight and which keyword
-- each belongs to" — so seo_rank_tasks exists alongside it, not instead of
-- it: job_attempts still governs SUBMIT scheduling (weekly, per location,
-- same shape as crawl/technical-audit); seo_rank_tasks is what COLLECT reads.
--
-- COLLECT IS DELIBERATELY NOT ON job_attempts. It's a single global sweep —
-- "check every task across every client that DataForSEO says is ready" — not
-- a per-tenant operation, so the (client_id, job_type, entity_id) claim model
-- doesn't fit it and isn't forced onto it. It's naturally idempotent (a task
-- already collected is skipped), so a plain frequent pg_cron entry calling
-- the edge function directly is the right amount of machinery, not less
-- correct than wrapping it in scheduling state it doesn't need.
--
-- ORGANIC + LOCAL PACK COME FROM ONE TASK, NOT TWO. Confirmed against
-- DataForSEO's own docs before writing any code: a single google/organic
-- Advanced task's result `items` array can contain both organic entries and
-- a local_pack entry for the same query, when Google shows one. One task per
-- (keyword, grid point) covers both rank_types; there's no separate "local
-- pack API" to call.
--
-- GEO GRID NEEDS seo_locations.lat/lng (0042), NOT YET POPULATED BY ANY UI.
-- Nothing in this build geocodes an address into coordinates yet. A location
-- without lat/lng simply gets standard tracking (via a location_code
-- fallback) and no geo grid, rather than blocking on it — grid tracking
-- already requires a person to opt a keyword in (plan.md's own rule), so
-- "also requires lat/lng to be set" is one more precondition of the same
-- kind, not a new category of gap.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

create table if not exists seo_rank_tasks (
  id                  uuid        primary key default gen_random_uuid(),
  client_id           uuid        not null references clients(id) on delete cascade,
  location_id         uuid        not null references seo_locations(id) on delete cascade,
  keyword_id          uuid        not null references seo_keywords(id) on delete cascade,
  is_geo_grid         boolean     not null default false,
  -- 0 for a standard (non-grid) task — same "default 0, not null" reasoning
  -- 0042 uses on seo_rankings.grid_row/grid_col, so a plain unique index
  -- actually dedupes (Postgres treats NULL <> NULL).
  grid_row            int         not null default 0,
  grid_col            int         not null default 0,
  dataforseo_task_id  text        not null,
  status              text        not null default 'submitted'
                      check (status in ('submitted', 'collected', 'failed')),
  submitted_at        timestamptz not null default now(),
  collected_at        timestamptz,
  last_error          text,

  unique (dataforseo_task_id)
);

create index if not exists idx_seo_rank_tasks_pending
  on seo_rank_tasks(status) where status = 'submitted';
create index if not exists idx_seo_rank_tasks_location on seo_rank_tasks(location_id);

alter table seo_rank_tasks enable row level security;
-- Internal bookkeeping only, same posture as job_attempts/google_oauth_tokens
-- — never tenant-relevant, service_role only.
revoke all on seo_rank_tasks from authenticated, anon;
grant select, insert, update on seo_rank_tasks to service_role;

-- -----------------------------------------------------------------------------
-- Submit scheduling — same shape as seo_crawl/seo_technical_audit: weekly,
-- per location, via job_attempts.
-- -----------------------------------------------------------------------------
create or replace view seo_rank_submit_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  ja.next_run_at,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from seo_locations l
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_rank_submit' and ja.entity_id = l.id
where l.is_active
  and exists (select 1 from seo_keywords k where k.location_id = l.id);

revoke all on seo_rank_submit_targets from authenticated, anon;
grant select on seo_rank_submit_targets to service_role;

create or replace function request_seo_rank_submit(p_location_id uuid)
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
    raise notice 'pg_net not installed — cannot request a rank submit';
    return null;
  end if;

  if not start_job_attempt(v_client_id, 'seo_rank_submit', p_location_id) then
    return null;
  end if;

  -- Vendor budget is reserved INSIDE the edge function, per DataForSEO API
  -- call (not here) — a location's whole keyword set batches into as few
  -- task_post calls as the 100-tasks-per-call limit allows, so the true
  -- number of API calls isn't known until the edge function has counted
  -- keywords and chunked them.

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_rank_tracking_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_rank_tracking_url / voice_tool_secret not in Vault — cannot request a rank submit';
    perform complete_job_attempt(v_client_id, 'seo_rank_submit', false, 'missing_vault_secret',
                                  10080, 1440, p_location_id);
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 60000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('action', 'submit', 'location_id', p_location_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = v_client_id and job_type = 'seo_rank_submit' and entity_id = p_location_id;

  return v_req;
end;
$$;

revoke execute on function request_seo_rank_submit(uuid) from public, authenticated;
grant execute on function request_seo_rank_submit(uuid) to service_role;

create or replace function run_due_seo_rank_submits(p_max_per_run int default 25)
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
    select location_id from seo_rank_submit_targets
     where is_due
     order by next_run_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_rank_submit(v_row.location_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_rank_submits(int) from public, authenticated;
grant execute on function run_due_seo_rank_submits(int) to service_role;

-- -----------------------------------------------------------------------------
-- Collect — a global, dedup-free-by-construction sweep. Dispatched directly
-- by pg_cron/pg_net, not through job_attempts (see migration header).
-- -----------------------------------------------------------------------------
create or replace function request_seo_rank_collect()
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
    return null;
  end if;

  -- Nothing to do — skip the call outright rather than spending an
  -- invocation checking an empty table every 10 minutes forever.
  if not exists (select 1 from seo_rank_tasks where status = 'submitted') then
    return null;
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_rank_tracking_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';
  if v_url is null or v_secret is null then
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 60000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('action', 'collect');

  return v_req;
end;
$$;

revoke execute on function request_seo_rank_collect() from public, authenticated;
grant execute on function request_seo_rank_collect() to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic rank submit/collect NOT scheduled.';
    return;
  end if;

  begin perform cron.unschedule('seo-rank-submit-due'); exception when others then null; end;
  begin perform cron.unschedule('seo-rank-collect-due'); exception when others then null; end;

  -- Submit: weekly per location, same hourly-tick shape as crawl/technical-audit.
  perform cron.schedule('seo-rank-submit-due', '40 * * * *',
    $cron$select run_due_seo_rank_submits();$cron$);

  -- Collect: every 10 minutes — DataForSEO's standard queue typically
  -- finishes within minutes, and an empty-table check makes an off-cycle
  -- tick cheap rather than skipping ahead to a longer interval.
  perform cron.schedule('seo-rank-collect-due', '*/10 * * * *',
    $cron$select request_seo_rank_collect();$cron$);
end;
$$;

-- SETUP AFTER APPLYING (once per project):
--   supabase secrets set DATAFORSEO_LOGIN=<email> DATAFORSEO_PASSWORD=<api-password>
--   select vault.create_secret(
--     'https://<ref>.functions.supabase.co/seo-rank-tracking',
--     'seo_rank_tracking_url', '');
--   Deploy with --no-verify-jwt.
-- Then verify with:  select * from seo_rank_submit_targets;
--                    select run_due_seo_rank_submits();
--                    select request_seo_rank_collect();

-- End of 0051.
