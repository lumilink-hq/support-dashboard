-- =============================================================================
-- 0048_scheduling_backoff_vendor_budgets.sql
-- Module 14 (plan.md): "shared job runner on pg_cron + scheduled edge
-- functions. Per-vendor rate limits, exponential backoff, deduplication of
-- reruns. Every later job plugs into this."
--
-- WHAT ALREADY EXISTS AND WHAT'S ACTUALLY MISSING. 0023 (product-sync) and
-- 0046 (google-token-refresh) already both implement the pg_cron -> pg_net ->
-- edge function shape, each with its own "targets" view, "request_*"
-- function and "run_due_*" loop. That per-job shape is fine and is NOT being
-- replaced here. What neither one has, and what genuinely needs to be
-- SHARED rather than copy-pasted a fifth time when Phase 2 lands (crawl,
-- rank tracking, backlink pull, AI citation pull — modules 6/7/15/18/20, at
-- least three of which hit the SAME vendor, DataForSEO):
--
--   1. VENDOR RATE LIMITS. Three independent job types calling DataForSEO on
--      their own schedules can collectively blow through its rate limit even
--      though each one individually looks fine — none of them know about the
--      others. A budget has to live above any single job.
--   2. EXPONENTIAL BACKOFF. Both existing jobs retry a failure on the next
--      fixed tick (15 min), forever. A vendor having a bad hour gets hit
--      every 15 minutes for that whole hour, which is how you get rate-
--      limited by your OWN retries on top of whatever caused the first
--      failure.
--   3. DEDUPLICATION OF IN-FLIGHT RUNS. The existing "is_due" checks read
--      fresh domain state each tick, which is a reasonable proxy but not a
--      hard claim — two ticks close enough together, or one slow run still
--      in flight when the next tick fires, could both decide the same job is
--      due and dispatch it twice.
--
-- THIS IS A SCHEDULING LAYER, NOT A REPLACEMENT FOR DOMAIN STATE. job_attempts
-- tracks "when is this (client, job_type) allowed to run again and why" —
-- it does not replace google_oauth_connections.status or products_staleness,
-- which stay the actual record of what happened. A job's own request/run_due
-- functions call start_job_attempt() before dispatching and
-- complete_job_attempt() is called by the edge function when it finishes;
-- everything else about the job is unchanged.
--
-- PROOF OF CONCEPT: google-token-refresh (0046) is retrofitted below to use
-- both primitives, as the first real consumer — "every later job plugs into
-- this" needs one actual job plugged in, not just inert tables. product-sync
-- (0023) is NOT touched — it already works, retrofitting shipped, working
-- code is out of scope here and not worth the regression risk.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Vendor rate limits — a budget above any single job.
--
-- Seeded with CONSERVATIVE placeholder numbers from each vendor's published
-- defaults, not confirmed account-specific limits — plan.md's Phase 7 already
-- has "re-check every vendor rate against actual spend" on the list for
-- exactly this reason. Treat these as a safe starting point to tune down (or
-- up) once each account's real plan is confirmed, not as verified truth.
-- -----------------------------------------------------------------------------
create table if not exists vendor_budgets (
  vendor            text        primary key,
  max_requests      int         not null check (max_requests > 0),
  window_seconds    int         not null check (window_seconds > 0),
  note              text,
  updated_at        timestamptz not null default now()
);

drop trigger if exists trg_vendor_budgets_updated_at on vendor_budgets;
create trigger trg_vendor_budgets_updated_at
  before update on vendor_budgets
  for each row execute function set_updated_at();

insert into vendor_budgets (vendor, max_requests, window_seconds, note) values
  ('google',    500, 60,    'Search Console + Business Profile combined default quota is well above this; conservative placeholder pending real usage.'),
  ('dataforseo', 30, 60,    'Standard queue rate; DataForSEO''s own default concurrency is higher — this is deliberately conservative until Phase 2 jobs exist to tune against.'),
  ('replicate',  10, 60,    'Free/standard tier concurrency placeholder.'),
  ('openai',     20, 60,    'Placeholder pending the account''s actual rate-limit tier.'),
  ('seoestore',   5, 60,    'Order-and-poll client (module 19) — low volume by design, plan.md caps it at the team''s current baseline.')
on conflict (vendor) do nothing;

alter table vendor_budgets enable row level security;
-- No tenant relevance at all — operator config only.
revoke all on vendor_budgets from authenticated, anon;
grant select on vendor_budgets to service_role;
grant insert, update, delete on vendor_budgets to service_role;

-- Rolling fixed-window counter. One row per (vendor, window_start); a window
-- is `window_seconds`-wide, aligned to epoch so concurrent callers agree on
-- which window "now" falls in without coordinating.
create table if not exists vendor_usage_windows (
  vendor        text        not null references vendor_budgets(vendor) on delete cascade,
  window_start  timestamptz not null,
  request_count int         not null default 0,
  primary key (vendor, window_start)
);

alter table vendor_usage_windows enable row level security;
revoke all on vendor_usage_windows from authenticated, anon;
grant select, insert, update on vendor_usage_windows to service_role;

-- -----------------------------------------------------------------------------
-- check_and_reserve_vendor_budget — atomic check-and-increment. Called by a
-- job's request_* function BEFORE net.http_post, same position in the flow
-- where 0023/0046's request functions already check for their Vault secrets
-- — one more precondition, not a new call site pattern.
--
-- Returns true (and reserves the cost) when under budget, false when not —
-- false means "try again next tick", not an error. An unknown vendor (no
-- vendor_budgets row) is ALLOWED rather than blocked: a missing budget
-- config is an operator oversight to fix, not a reason to silently stop a
-- job that was working fine before this migration existed.
-- -----------------------------------------------------------------------------
create or replace function check_and_reserve_vendor_budget(p_vendor text, p_cost int default 1)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_budget vendor_budgets%rowtype;
  v_window timestamptz;
  v_count  int;
begin
  select * into v_budget from vendor_budgets where vendor = p_vendor;
  if not found then
    return true;  -- no budget configured for this vendor — see header note
  end if;

  -- Align the window to epoch so every caller computes the same boundary.
  v_window := to_timestamp(floor(extract(epoch from now()) / v_budget.window_seconds) * v_budget.window_seconds);

  insert into vendor_usage_windows (vendor, window_start, request_count)
  values (p_vendor, v_window, 0)
  on conflict (vendor, window_start) do nothing;

  update vendor_usage_windows
     set request_count = request_count + p_cost
   where vendor = p_vendor and window_start = v_window
  returning request_count into v_count;

  if v_count > v_budget.max_requests then
    -- Over budget: undo the reservation (this request didn't actually
    -- happen) and refuse.
    update vendor_usage_windows
       set request_count = greatest(request_count - p_cost, 0)
     where vendor = p_vendor and window_start = v_window;
    return false;
  end if;

  return true;
end;
$$;

revoke execute on function check_and_reserve_vendor_budget(text, int) from public, authenticated;
grant execute on function check_and_reserve_vendor_budget(text, int) to service_role;

-- Old windows accumulate forever otherwise. Not scheduled via cron here —
-- called opportunistically is enough; a stray extra day of tiny rows costs
-- nothing and this avoids one more moving scheduled part.
create or replace function prune_vendor_usage_windows(p_older_than interval default interval '7 days')
returns void
language sql
security definer
set search_path = public, extensions
as $$
  delete from vendor_usage_windows where window_start < now() - p_older_than;
$$;

revoke execute on function prune_vendor_usage_windows(interval) from public, authenticated;
grant execute on function prune_vendor_usage_windows(interval) to service_role;

-- =============================================================================
-- 2. Scheduling bookkeeping — exponential backoff + in-flight dedup, shared
--    across every (client, job_type). job_type is free text (evolving set,
--    same TEXT+CHECK-family reasoning as everywhere else) — 'google_token_
--    refresh' today, 'seo_crawl' / 'seo_rank_pull' / etc. once Phase 2 exists.
-- =============================================================================
create table if not exists job_attempts (
  client_id             uuid        not null references clients(id) on delete cascade,
  job_type              text        not null,
  status                text        not null default 'idle'
                        check (status in ('idle', 'running', 'failed')),
  attempt_count         int         not null default 0,   -- consecutive failures; drives backoff
  next_run_at           timestamptz not null default now(),
  last_run_at           timestamptz,
  last_success_at       timestamptz,
  last_error            text,
  dispatched_request_id bigint,                            -- pg_net request id, for observability
  dispatched_at         timestamptz,
  updated_at            timestamptz not null default now(),

  primary key (client_id, job_type)
);

create index if not exists idx_job_attempts_due
  on job_attempts(job_type, next_run_at) where status <> 'running';

drop trigger if exists trg_job_attempts_updated_at on job_attempts;
create trigger trg_job_attempts_updated_at
  before update on job_attempts
  for each row execute function set_updated_at();

alter table job_attempts enable row level security;
-- Pure scheduling internals, same posture as provisioning_tasks (0008): no
-- tenant relevance, service_role only.
revoke all on job_attempts from authenticated, anon;
grant select, insert, update on job_attempts to service_role;

-- -----------------------------------------------------------------------------
-- start_job_attempt — the dedup claim. Returns true and marks the row
-- 'running' when the caller may proceed; false means "someone else has this
-- in flight" or "it isn't due yet" — either way, skip it this tick.
--
-- p_max_inflight_minutes is the self-healing half of dedup: a run that never
-- calls complete_job_attempt (the edge function crashed, or pg_net's request
-- itself never got a response) would otherwise wedge that (client, job_type)
-- in 'running' forever. Past this window a stale 'running' row is treated as
-- abandoned and reclaimed rather than trusted.
-- -----------------------------------------------------------------------------
create or replace function start_job_attempt(
  p_client_id uuid,
  p_job_type  text,
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
  insert into job_attempts (client_id, job_type, status, next_run_at)
  values (p_client_id, p_job_type, 'idle', now())
  on conflict (client_id, job_type) do nothing;

  update job_attempts
     set status = 'running',
         dispatched_at = now(),
         last_run_at = now()
   where client_id = p_client_id
     and job_type = p_job_type
     and next_run_at <= now()
     and (
       status <> 'running'
       or dispatched_at < now() - make_interval(mins => p_max_inflight_minutes)
     );

  get diagnostics v_claimed = row_count;
  return coalesce(v_claimed, false) and v_claimed;
end;
$$;

revoke execute on function start_job_attempt(uuid, text, int) from public, authenticated;
grant execute on function start_job_attempt(uuid, text, int) to service_role;

-- -----------------------------------------------------------------------------
-- complete_job_attempt — called by the edge function when it finishes.
-- Success resets the backoff and schedules the NORMAL next run; failure
-- backs off exponentially, capped at p_max_backoff_minutes, so a vendor
-- outage degrades to occasional retries instead of every-tick hammering.
-- -----------------------------------------------------------------------------
create or replace function complete_job_attempt(
  p_client_id      uuid,
  p_job_type       text,
  p_success        boolean,
  p_error          text default null,
  p_base_interval_minutes int default 15,
  p_max_backoff_minutes   int default 240
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_attempts int;
begin
  if p_success then
    update job_attempts
       set status = 'idle',
           attempt_count = 0,
           last_success_at = now(),
           last_error = null,
           next_run_at = now() + make_interval(mins => p_base_interval_minutes)
     where client_id = p_client_id and job_type = p_job_type;
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
    returning attempt_count into v_attempts;
  end if;
end;
$$;

revoke execute on function complete_job_attempt(uuid, text, boolean, text, int, int) from public, authenticated;
grant execute on function complete_job_attempt(uuid, text, boolean, text, int, int) to service_role;

-- -----------------------------------------------------------------------------
-- Health view — the "who's stuck" question, generalized across every job
-- type instead of one health view per job (product_sync_health,
-- google_oauth_health) forever.
-- -----------------------------------------------------------------------------
create or replace view job_attempts_health with (security_invoker = true) as
select
  client_id,
  job_type,
  status,
  attempt_count,
  next_run_at,
  last_run_at,
  last_success_at,
  last_error,
  case
    when attempt_count >= 5 then 'failing'
    when status = 'running' and dispatched_at < now() - interval '30 minutes' then 'stuck'
    else 'ok'
  end as health
from job_attempts;

revoke all on job_attempts_health from authenticated, anon;
grant select on job_attempts_health to service_role;

comment on view job_attempts_health is
  'health: failing (5+ consecutive attempts) | stuck (running past the '
  'in-flight window, likely abandoned) | ok.';

-- =============================================================================
-- 3. Retrofit google-token-refresh (0046) onto the shared layer — proves the
--    primitives above are actually usable, not just inert tables.
--    google_oauth_connections/tokens are UNCHANGED; this only touches the
--    scheduling functions and the edge function's own callback.
-- =============================================================================

-- request_google_token_refresh: add the vendor-budget check ahead of the
-- existing pg_net dispatch. Same signature, same grants — create or replace
-- is safe here (unlike apply_billing_event's parameter-list change in 0031,
-- this function's argument list is untouched).
create or replace function request_google_token_refresh(p_client_id uuid)
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
    raise notice 'pg_net not installed — cannot request a refresh';
    return null;
  end if;

  if not start_job_attempt(p_client_id, 'google_token_refresh') then
    return null;  -- not due yet, or already in flight
  end if;

  if not check_and_reserve_vendor_budget('google') then
    -- Back off exactly as a real failure would, so this client isn't
    -- re-attempted again next tick while the vendor budget is still tight —
    -- error text is legible in job_attempts_health rather than silent.
    perform complete_job_attempt(p_client_id, 'google_token_refresh', false, 'vendor_budget_exceeded');
    return null;
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'google_token_refresh_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'google_token_refresh_url / voice_tool_secret not in Vault — cannot request a refresh';
    perform complete_job_attempt(p_client_id, 'google_token_refresh', false, 'missing_vault_secret');
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 20000)'
    into v_req
    using
      v_url,
      jsonb_build_object(
        'Content-Type', 'application/json',
        'x-voice-tool-secret', v_secret
      ),
      jsonb_build_object('client_id', p_client_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = p_client_id and job_type = 'google_token_refresh';

  return v_req;
end;
$$;

-- run_due_google_token_refreshes: unchanged in shape, but the underlying
-- request_google_token_refresh now does its own due/dedup/budget checks via
-- start_job_attempt/check_and_reserve_vendor_budget — so this loop no longer
-- needs to pre-filter on google_oauth_refresh_targets.is_due; every
-- connected client is offered every tick and the shared layer decides who's
-- actually due. Simpler, and the single source of truth for "is it due" is
-- now one place instead of two (this view AND job_attempts.next_run_at).
create or replace function run_due_google_token_refreshes(p_max_per_run int default 50)
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
    select client_id
      from google_oauth_connections
     where status <> 'revoked'
     order by last_refreshed_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_google_token_refresh(v_row.client_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  perform prune_vendor_usage_windows();

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

-- End of 0048.
