-- =============================================================================
-- test_scheduling_backoff_vendor_budgets.sql — non-destructive test of 0048's
-- shared scheduling layer: in-flight dedup (with self-healing past the
-- max-inflight window), exponential backoff with a cap, per-vendor budget
-- enforcement, and the google-token-refresh retrofit's wiring into all of it.
--
-- Requires pg_net and Vault stubs in this environment for the retrofit part
-- (Part 2) — see this repo's Docker validation bootstrap. Against a real
-- Supabase project both extensions are real; no stub needed there.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_scheduling_backoff_vendor_budgets.sql
--   or: supabase db execute --file scripts/test_scheduling_backoff_vendor_budgets.sql
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client  uuid;
  v_claimed boolean;
  v_row     job_attempts%rowtype;
  v_allowed boolean;
begin
  insert into clients (name, slug, is_active) values ('Sched Test Co', 'sched-test-co', true)
  returning id into v_client;

  -- 1) A brand-new (client, job_type) is immediately claimable.
  v_claimed := start_job_attempt(v_client, 'unit_test_job');
  assert v_claimed, 'dedup: a fresh job is claimable';

  select * into v_row from job_attempts where client_id = v_client and job_type = 'unit_test_job';
  assert v_row.status = 'running', 'dedup: claimed job marked running';

  -- 2) A second claim attempt while the first is still "running" must fail
  --    (this is the actual race the migration exists to close).
  v_claimed := start_job_attempt(v_client, 'unit_test_job');
  assert not v_claimed, 'dedup: a second claim on an in-flight job must be refused';

  -- 3) Success resets backoff and schedules the normal next run.
  perform complete_job_attempt(v_client, 'unit_test_job', true, null, 15, 240);
  select * into v_row from job_attempts where client_id = v_client and job_type = 'unit_test_job';
  assert v_row.status = 'idle', 'backoff: success returns to idle';
  assert v_row.attempt_count = 0, 'backoff: success resets attempt_count';
  assert v_row.next_run_at between now() + interval '14 minutes' and now() + interval '16 minutes',
    'backoff: success schedules the base interval';

  -- 4) Claim again (now due), then fail repeatedly — backoff must grow and
  --    cap, never exceeding p_max_backoff_minutes.
  perform start_job_attempt(v_client, 'unit_test_job');
  perform complete_job_attempt(v_client, 'unit_test_job', false, 'boom', 15, 240);
  select * into v_row from job_attempts where client_id = v_client and job_type = 'unit_test_job';
  assert v_row.status = 'failed', 'backoff: failure marks failed';
  assert v_row.attempt_count = 1, 'backoff: first failure -> attempt_count 1';
  -- 15 * 2^1 = 30 minutes
  assert v_row.next_run_at between now() + interval '29 minutes' and now() + interval '31 minutes',
    format('backoff: expected ~30min after 1st failure, next_run_at=%s', v_row.next_run_at);

  -- Force it due again (bypassing the real wait, this is a unit test) and
  -- fail several more times to prove the cap holds.
  update job_attempts set next_run_at = now() where client_id = v_client and job_type = 'unit_test_job';
  perform start_job_attempt(v_client, 'unit_test_job');
  perform complete_job_attempt(v_client, 'unit_test_job', false, 'boom again', 15, 240);
  select * into v_row from job_attempts where client_id = v_client and job_type = 'unit_test_job';
  assert v_row.attempt_count = 2, 'backoff: second consecutive failure -> attempt_count 2';
  -- 15 * 2^2 = 60 minutes
  assert v_row.next_run_at between now() + interval '59 minutes' and now() + interval '61 minutes',
    format('backoff: expected ~60min after 2nd failure, next_run_at=%s', v_row.next_run_at);

  -- Jump attempt_count way up by hand and confirm the cap (240min) holds
  -- rather than growing unbounded.
  update job_attempts set attempt_count = 8, next_run_at = now()
   where client_id = v_client and job_type = 'unit_test_job';
  perform start_job_attempt(v_client, 'unit_test_job');
  perform complete_job_attempt(v_client, 'unit_test_job', false, 'still boom', 15, 240);
  select * into v_row from job_attempts where client_id = v_client and job_type = 'unit_test_job';
  assert v_row.next_run_at <= now() + interval '241 minutes',
    format('backoff: must be capped at 240min, got next_run_at=%s', v_row.next_run_at);
  assert v_row.next_run_at >= now() + interval '239 minutes', 'backoff: cap should be hit, not below it';

  -- 5) In-flight dedup self-heals past the max-inflight window (simulating a
  --    run that crashed without ever calling complete_job_attempt).
  update job_attempts set status = 'running', dispatched_at = now() - interval '31 minutes',
         next_run_at = now() - interval '1 minute'
   where client_id = v_client and job_type = 'unit_test_job';
  -- 0049 widened this function's signature to (client_id, job_type,
  -- entity_id, max_inflight_minutes) for per-location jobs — entity_id is
  -- null here (this is a client-level job type, same as google_token_refresh).
  v_claimed := start_job_attempt(v_client, 'unit_test_job', null, 30);
  assert v_claimed, 'dedup: a stale in-flight run past the window must be reclaimable';

  -- 6) Vendor budget: exhaust a tiny budget and confirm it actually blocks.
  insert into vendor_budgets (vendor, max_requests, window_seconds)
  values ('unit_test_vendor', 2, 3600)
  on conflict (vendor) do update set max_requests = 2, window_seconds = 3600;

  v_allowed := check_and_reserve_vendor_budget('unit_test_vendor');
  assert v_allowed, 'vendor budget: 1st request allowed (budget 2)';
  v_allowed := check_and_reserve_vendor_budget('unit_test_vendor');
  assert v_allowed, 'vendor budget: 2nd request allowed (budget 2)';
  v_allowed := check_and_reserve_vendor_budget('unit_test_vendor');
  assert not v_allowed, 'vendor budget: 3rd request must be refused';

  -- An unconfigured vendor is allowed by design (missing config isn't a block).
  v_allowed := check_and_reserve_vendor_budget('totally_unconfigured_vendor_xyz');
  assert v_allowed, 'vendor budget: unconfigured vendor is allowed, not blocked';

  raise notice 'ALL 0048 SCHEDULING TESTS PASSED';
end;
$$;

-- -----------------------------------------------------------------------------
-- Part 2: the google-token-refresh retrofit actually wires into the shared
-- layer (start_job_attempt claims before dispatch, the pg_net request id
-- lands on job_attempts). Requires a pg_net stub in this environment — see
-- this repo's bootstrap script for local/CI runs; a real Supabase project
-- has the real extension.
-- -----------------------------------------------------------------------------
do $$
declare
  v_client uuid;
  v_user   uuid := gen_random_uuid();
  v_req    bigint;
  v_row    job_attempts%rowtype;
begin
  insert into clients (name, slug, is_active) values ('Sched Google Co', 'sched-google-co', true)
  returning id into v_client;
  insert into auth.users (id, email) values (v_user, 'sched-google@example.com');
  update users set client_id = v_client, role = 'admin' where id = v_user;

  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;
  perform store_google_oauth_tokens('rt-sched', 'at-sched', now() + interval '1 hour',
    array['https://www.googleapis.com/auth/webmasters.readonly'], 'sched@example.com');
  reset role;

  -- Mirrors 0046's own post-deploy setup instructions (Vault secrets for the
  -- function URL + shared admin secret) so the dispatch path fully succeeds
  -- against the stubbed net.http_post rather than dying earlier on a missing
  -- secret, which would prove nothing about the retrofit itself.
  perform vault.create_secret('https://example.supabase.co/functions/v1/google-token-refresh', 'google_token_refresh_url', '');
  perform vault.create_secret('unit-test-shared-secret', 'voice_tool_secret', '');

  v_req := request_google_token_refresh(v_client);
  assert v_req is not null, 'retrofit: with pg_net + vault secrets present, dispatch must return a request id';

  select * into v_row from job_attempts where client_id = v_client and job_type = 'google_token_refresh';
  assert v_row.status = 'running',
    'retrofit: request_google_token_refresh must claim via start_job_attempt before dispatching';
  assert v_row.dispatched_request_id = v_req,
    'retrofit: the pg_net request id must be recorded on the job_attempts row';

  raise notice 'GOOGLE RETROFIT WIRING CONFIRMED';
end;
$$;

rollback;
