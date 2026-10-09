-- =============================================================================
-- test_google_connect_pulls_jobs_forward.sql — 0078: adding a scope to a Google
-- connection (through store_google_oauth_tokens, as the real callback does)
-- moves seo_gbp_sync and seo_search_console to now(); unrelated changes and
-- other jobs/clients are left alone.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_google_connect_pulls_jobs_forward.sql
--
-- To see it FAIL: drop trigger trg_google_connection_pull_jobs_forward on
-- google_oauth_connections; -> "scope added: GBP sync is due now" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_a    uuid;
  v_b    uuid;
  v_user uuid;
  v_r    jsonb;
  v_seen int;
begin
  insert into clients (name, slug, is_active) values ('GC Pull A', 'gc-pull-a', true) returning id into v_a;
  insert into clients (name, slug, is_active) values ('GC Pull B', 'gc-pull-b', true) returning id into v_b;
  v_user := gen_random_uuid();
  insert into auth.users (id, email) values (v_user, 'gc-pull@example.com');
  update users set client_id = v_a, role = 'admin' where id = v_user;

  insert into job_attempts (client_id, job_type, status, next_run_at) values
    (v_a, 'seo_gbp_sync', 'idle', now() + interval '23 hours'),
    (v_a, 'seo_search_console', 'idle', now() + interval '20 hours'),
    (v_a, 'seo_content', 'idle', now() + interval '5 days'),
    (v_b, 'seo_gbp_sync', 'idle', now() + interval '23 hours');

  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;

  -- First connect: Search Console only.
  v_r := store_google_oauth_tokens('refresh-1', 'access-1', now() + interval '1 hour',
    array['https://www.googleapis.com/auth/webmasters.readonly'], 'a@example.com');
  assert (v_r->>'ok')::boolean, format('connect failed: %s', v_r);
  reset role;

  select count(*) into v_seen from job_attempts where client_id = v_a and job_type in ('seo_gbp_sync', 'seo_search_console') and next_run_at <= now();
  assert v_seen = 2, format('first connect: both Google syncs due now, saw %s', v_seen);

  -- Push them back out, as a run would.
  update job_attempts set next_run_at = now() + interval '23 hours' where client_id = v_a;

  -- Re-consent with the same scope: nothing new, nothing moves.
  set local role authenticated;
  perform store_google_oauth_tokens(null, 'access-2', now() + interval '1 hour',
    array['https://www.googleapis.com/auth/webmasters.readonly'], null);
  reset role;
  select count(*) into v_seen from job_attempts where client_id = v_a and next_run_at <= now();
  assert v_seen = 0, 'same scopes again: nothing pulled forward';

  -- Add Business Profile.
  set local role authenticated;
  perform store_google_oauth_tokens(null, 'access-3', now() + interval '1 hour',
    array['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/business.manage'], null);
  reset role;
  select count(*) into v_seen from job_attempts where client_id = v_a and job_type = 'seo_gbp_sync' and next_run_at <= now();
  assert v_seen = 1, 'scope added: GBP sync is due now';
  select count(*) into v_seen from job_attempts where client_id = v_a and job_type = 'seo_content' and next_run_at <= now();
  assert v_seen = 0, 'scope added: other jobs untouched';
  select count(*) into v_seen from job_attempts where client_id = v_b and next_run_at <= now();
  assert v_seen = 0, 'scope added: other clients untouched';

  -- A revoked connection coming back counts too.
  update job_attempts set next_run_at = now() + interval '23 hours' where client_id = v_a;
  update google_oauth_connections set status = 'revoked' where client_id = v_a;
  select count(*) into v_seen from job_attempts where client_id = v_a and next_run_at <= now();
  assert v_seen = 0, 'revoked: nothing pulled forward';
  update google_oauth_connections set status = 'connected' where client_id = v_a;
  select count(*) into v_seen from job_attempts where client_id = v_a and job_type = 'seo_gbp_sync' and next_run_at <= now();
  assert v_seen = 1, 'reconnected after a revoke: due now';

  raise notice 'test_google_connect_pulls_jobs_forward: all assertions passed';
end;
$$;

rollback;
