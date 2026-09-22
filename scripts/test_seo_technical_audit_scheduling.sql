-- =============================================================================
-- test_seo_technical_audit_scheduling.sql — non-destructive test of 0050's
-- scheduling wiring: a location gets its own seo_technical_audit job_attempts
-- row, independent of its seo_crawl row (same entity_id, different job_type
-- must not collide). Requires pg_net + Vault stubs — see this repo's Docker
-- validation bootstrap for local/CI runs.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_seo_technical_audit_scheduling.sql
--   or: supabase db execute --file scripts/test_seo_technical_audit_scheduling.sql
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_loc    uuid;
  v_req    bigint;
  v_row    job_attempts%rowtype;
  v_seen   int;
begin
  insert into clients (name, slug, is_active) values ('Tech Audit Test Co', 'tech-audit-test-co', true)
  returning id into v_client;
  insert into seo_locations (client_id, name, website_url) values (v_client, 'Loc A', 'https://a.example.com')
  returning id into v_loc;

  select count(*) into v_seen from seo_technical_audit_targets where location_id = v_loc and is_due;
  assert v_seen = 1, 'targets: a never-audited location is due immediately';

  perform vault.create_secret('https://example.supabase.co/functions/v1/seo-technical-audit', 'seo_technical_audit_url', '');
  perform vault.create_secret('unit-test-shared-secret', 'voice_tool_secret', '');

  v_req := request_seo_technical_audit(v_loc);
  assert v_req is not null, 'dispatch: request_seo_technical_audit succeeds with pg_net + vault secrets present';

  select * into v_row from job_attempts where client_id = v_client and job_type = 'seo_technical_audit' and entity_id = v_loc;
  assert v_row.status = 'running', 'dispatch: claimed before dispatching';

  -- Independent from seo_crawl's own job_attempts row for the SAME location —
  -- two different job_types must not collide even though entity_id matches.
  perform start_job_attempt(v_client, 'seo_crawl', v_loc);
  select count(*) into v_seen from job_attempts where client_id = v_client and entity_id = v_loc;
  assert v_seen = 2, format('independence: expected 2 distinct job_type rows for the same location, got %s', v_seen);

  perform complete_job_attempt(v_client, 'seo_technical_audit', true, null, 10080, 1440, v_loc);
  select status into v_row.status from job_attempts
   where client_id = v_client and job_type = 'seo_technical_audit' and entity_id = v_loc;
  assert v_row.status = 'idle', 'completion: seo_technical_audit settles independently of seo_crawl';
  select status into v_row.status from job_attempts
   where client_id = v_client and job_type = 'seo_crawl' and entity_id = v_loc;
  assert v_row.status = 'running', 'completion: seo_crawl''s own row is untouched';

  raise notice 'ALL 0050 TECHNICAL AUDIT SCHEDULING TESTS PASSED';
end;
$$;

rollback;
