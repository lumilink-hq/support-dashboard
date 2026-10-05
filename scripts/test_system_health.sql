-- =============================================================================
-- test_system_health.sql — non-destructive test of 0068: the snapshot reports
-- a missing Vault secret and stops once it exists, reports failing jobs, flags
-- a location whose drafting has paused at 10 waiting page fixes (and not at
-- 9), and none of it is reachable by a signed-in tenant.
--
-- Run:  npm run test:sql -- system_health   (local stack only)
-- To see it FAIL:
--   * drop the `having count(*) >= 10` line in system_health_snapshot()
--     → "drafting_paused: 9 waiting is not flagged" fails.
--   * grant execute on function system_health_snapshot() to authenticated;
--     → "isolation: a tenant can't run the snapshot" fails.
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client  uuid;
  v_loc     uuid;
  v_user    uuid := gen_random_uuid();
  v_issues  jsonb;
  v_denied  boolean;
  i         int;
begin
  -- A known-missing Vault secret is reported, then isn't once it exists.
  delete from vault.secrets where name = 'seo_geocode_url';
  v_issues := system_health_snapshot();
  assert v_issues @> '[{"check":"vault_secret","subject":"seo_geocode_url","severity":"critical"}]',
    'vault: a missing secret is reported as critical';
  perform vault.create_secret('https://example.supabase.co/functions/v1/seo-geocode', 'seo_geocode_url', '');
  v_issues := system_health_snapshot();
  assert not v_issues @> '[{"check":"vault_secret","subject":"seo_geocode_url"}]',
    'vault: a secret that exists is not reported';

  -- A job failing 5 times in a row is reported, with its last error.
  insert into clients (name, slug, is_active) values ('Health Test Co', 'health-test-co', true) returning id into v_client;
  insert into job_attempts (client_id, job_type, entity_id, status, attempt_count, next_run_at, last_error)
  values (v_client, 'seo_health_test', null, 'failed', 5, now() + interval '1 hour', 'HTTP 402 from vendor');
  v_issues := system_health_snapshot();
  assert v_issues @> '[{"check":"job_failing","subject":"seo_health_test"}]', 'jobs: a failing job type is reported';
  assert exists (select 1 from jsonb_array_elements(v_issues) e
                  where e->>'subject' = 'seo_health_test' and e->>'detail' like '%HTTP 402 from vendor%'),
    'jobs: the report carries the last error';

  -- Drafting pauses at 10 waiting page fixes: 9 is fine, 10 is flagged.
  insert into seo_locations (client_id, name, website_url) values (v_client, 'Main St', 'https://health.example.com')
  returning id into v_loc;
  for i in 1..9 loop
    insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url,
                             proposed_value, status, idempotency_key)
    values (v_client, v_loc, 'onpage_fix', 'title_tag', 'missing_title', 'https://health.example.com/p' || i,
            '{"value":"x"}', 'pending_approval', 'health-test:' || i);
  end loop;
  v_issues := system_health_snapshot();
  assert not v_issues @> '[{"check":"drafting_paused"}]', 'drafting_paused: 9 waiting is not flagged';

  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url,
                           proposed_value, status, idempotency_key)
  values (v_client, v_loc, 'onpage_fix', 'title_tag', 'missing_title', 'https://health.example.com/p10',
          '{"value":"x"}', 'manual_required', 'health-test:10');
  v_issues := system_health_snapshot();
  assert v_issues @> '[{"check":"drafting_paused","subject":"Health Test Co / Main St"}]',
    'drafting_paused: 10 waiting (any waiting status) is flagged';

  -- Isolation: none of this is tenant-reachable.
  insert into system_health_runs (ok, issues) values (false, v_issues);
  insert into auth.users (id, email) values (v_user, 'health-tenant@example.com');
  update users set client_id = v_client, role = 'admin' where id = v_user;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;

  v_denied := false;
  begin
    perform system_health_snapshot();
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a tenant can''t run the snapshot';

  v_denied := false;
  begin
    perform count(*) from system_health_runs;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a tenant can''t read health runs';

  v_denied := false;
  begin
    perform request_system_health_check();
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a tenant can''t trigger a health check';

  reset role;
  raise notice 'ALL SYSTEM HEALTH TESTS PASSED';
end $$;

rollback;
