-- =============================================================================
-- test_seo_run_now.sql — non-destructive test of 0073: seo_job_status() and
-- request_seo_run_now(), as a tenant.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_run_now.sql
--
-- To see it FAIL:
--   * drop the cooldown check from request_seo_run_now
--     → "cooldown: refused within 6 hours of the last crawl" fails.
--   * drop the client_id check in either function
--     → "isolation: ..." fails.
--   * use p_location_id instead of the primary for 'site' scope
--     → "site-wide jobs run on the primary" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client_a uuid;
  v_client_b uuid;
  v_primary  uuid;
  v_store    uuid;
  v_loc_b    uuid;
  v_user_a   uuid := gen_random_uuid();
  v_far      timestamptz := now() + interval '6 days';
  v_next     timestamptz;
  v_seen     int;
  v_status   text;
  v_denied   boolean;
begin
  insert into clients (name, slug, is_active) values ('Run Now A', 'run-now-a', true) returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('Run Now B', 'run-now-b', true) returning id into v_client_b;
  -- Two locations on one website (0070): the older is the primary.
  insert into seo_locations (client_id, name, website_url, created_at)
    values (v_client_a, 'Primary', 'https://runnow.example.com', now() - interval '60 days') returning id into v_primary;
  insert into seo_locations (client_id, name, website_url, created_at)
    values (v_client_a, 'Store', 'https://runnow.example.com/store', now() - interval '30 days') returning id into v_store;
  insert into seo_locations (client_id, name, website_url) values (v_client_b, 'B', 'https://b.example.com') returning id into v_loc_b;

  insert into job_attempts (client_id, job_type, entity_id, status, attempt_count, last_run_at, next_run_at) values
    (v_client_a, 'seo_crawl',      v_primary, 'idle', 0, now() - interval '2 days',  v_far),
    (v_client_a, 'seo_draft',      v_store,   'idle', 0, now() - interval '10 minutes', v_far),
    (v_client_a, 'seo_content',    null,      'idle', 0, now() - interval '3 days',  v_far),
    (v_client_a, 'seo_rank_submit', v_store,  'running', 0, now() - interval '5 minutes', v_far),
    (v_client_b, 'seo_crawl',      v_loc_b,   'idle', 0, now() - interval '2 days',  v_far);
  update job_attempts set dispatched_at = now() - interval '5 minutes' where job_type = 'seo_rank_submit' and entity_id = v_store;

  insert into auth.users (id, email) values (v_user_a, 'seo-run-now-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;
  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  -- ---------------------------------------------------------------------------
  -- Status
  -- ---------------------------------------------------------------------------
  select count(*) into v_seen from seo_job_status(v_store);
  assert v_seen = 10, format('status: one row per run-now job (got %s)', v_seen);
  select next_run_at into v_next from seo_job_status(v_store) where job_type = 'seo_crawl';
  assert v_next = v_far, 'site-wide jobs run on the primary: the store sees the primary''s crawl';
  select count(*) into v_seen from seo_job_status(v_loc_b);
  assert v_seen = 0, 'isolation: another client''s location returns nothing';

  begin
    select count(*) into v_seen from job_attempts;
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  assert v_denied, 'rule 4: job_attempts itself stays unreadable';

  -- ---------------------------------------------------------------------------
  -- Run now
  -- ---------------------------------------------------------------------------
  assert request_seo_run_now(v_store, 'seo_crawl') = 'ok', 'crawl two days old: ok';
  reset role;
  select next_run_at into v_next from job_attempts where client_id = v_client_a and job_type = 'seo_crawl' and entity_id = v_primary;
  assert v_next <= now(), 'site-wide jobs run on the primary: requesting from the store moved the primary''s crawl';
  update job_attempts set next_run_at = v_far, last_run_at = now() - interval '1 hour'
   where client_id = v_client_a and job_type = 'seo_crawl';
  set local role authenticated;

  assert request_seo_run_now(v_store, 'seo_crawl') = 'cooldown', 'cooldown: refused within 6 hours of the last crawl';
  assert request_seo_run_now(v_store, 'seo_draft') = 'cooldown', 'cooldown: drafts ran 10 minutes ago';
  assert request_seo_run_now(v_store, 'seo_rank_submit') = 'running', 'running: refused while in flight';
  assert request_seo_run_now(v_primary, 'seo_content') = 'ok', 'client-wide article job: ok';
  assert request_seo_run_now(v_primary, 'seo_content') = 'already_due', 'a second click: already due';
  assert request_seo_run_now(v_primary, 'seo_backlinks') = 'unknown_job', 'not on the allowlist';
  assert request_seo_run_now(v_primary, 'seo_ai_responses') = 'unknown_job', 'not on the allowlist (2)';
  assert request_seo_run_now(v_loc_b, 'seo_crawl') = 'not_found', 'isolation: another client''s location';
  assert request_seo_run_now(v_primary, 'seo_keyword_research') = 'already_due', 'never run: already due';

  reset role;
  select next_run_at into v_next from job_attempts where client_id = v_client_b and job_type = 'seo_crawl';
  assert v_next = v_far, 'isolation: client B''s crawl untouched';

  raise notice 'ALL 0073 RUN NOW TESTS PASSED';
end;
$$;

rollback;
