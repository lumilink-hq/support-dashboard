-- =============================================================================
-- test_seo_backlinks_scheduling.sql — non-destructive test of 0052's
-- scheduling wiring: a location gets its own seo_backlinks job_attempts row,
-- independent of its other SEO job rows, and a monthly completion pushes the
-- next run ~30 days out. Requires pg_net + Vault stubs — see this repo's
-- Docker validation bootstrap for local/CI runs.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_seo_backlinks_scheduling.sql
--   or: supabase db execute --file scripts/test_seo_backlinks_scheduling.sql
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_loc    uuid;
  v_loc2   uuid;
  v_req    bigint;
  v_row    job_attempts%rowtype;
  v_seen   int;
begin
  insert into clients (name, slug, is_active) values ('Backlinks Test Co', 'backlinks-test-co', true)
  returning id into v_client;
  insert into seo_locations (client_id, name, website_url) values (v_client, 'Loc A', 'https://a.example.com')
  returning id into v_loc;
  insert into seo_locations (client_id, name) values (v_client, 'Loc No Site')
  returning id into v_loc2;

  select count(*) into v_seen from seo_backlink_targets where location_id = v_loc and is_due;
  assert v_seen = 1, 'targets: a never-pulled location with a website is due immediately';
  select count(*) into v_seen from seo_backlink_targets where location_id = v_loc2;
  assert v_seen = 0, 'targets: a location without a website is not a target';

  perform vault.create_secret('https://example.supabase.co/functions/v1/seo-backlinks', 'seo_backlinks_url', '');
  perform vault.create_secret('unit-test-shared-secret', 'voice_tool_secret', '');

  v_req := request_seo_backlinks(v_loc);
  assert v_req is not null, 'dispatch: request_seo_backlinks succeeds with pg_net + vault secrets present';

  select * into v_row from job_attempts where client_id = v_client and job_type = 'seo_backlinks' and entity_id = v_loc;
  assert v_row.status = 'running', 'dispatch: claimed before dispatching';

  assert request_seo_backlinks(v_loc) is null, 'dedup: a second dispatch while running is refused';

  perform start_job_attempt(v_client, 'seo_technical_audit', v_loc);
  select count(*) into v_seen from job_attempts where client_id = v_client and entity_id = v_loc;
  assert v_seen = 2, format('independence: expected 2 distinct job_type rows for the same location, got %s', v_seen);

  perform complete_job_attempt(v_client, 'seo_backlinks', true, null, 43200, 1440, v_loc);
  select * into v_row from job_attempts where client_id = v_client and job_type = 'seo_backlinks' and entity_id = v_loc;
  assert v_row.status = 'idle', 'completion: settles to idle';
  assert v_row.next_run_at > now() + interval '29 days' and v_row.next_run_at < now() + interval '31 days',
    format('completion: next run is ~30 days out, got %s', v_row.next_run_at);

  select count(*) into v_seen from seo_backlink_targets where location_id = v_loc and is_due;
  assert v_seen = 0, 'targets: not due again until the month is up';

  -- A failed run backs off, capped, rather than waiting a month.
  perform start_job_attempt(v_client, 'seo_backlinks', v_loc);
  perform complete_job_attempt(v_client, 'seo_backlinks', false, 'dataforseo_backlinks_not_subscribed', 43200, 1440, v_loc);
  select * into v_row from job_attempts where client_id = v_client and job_type = 'seo_backlinks' and entity_id = v_loc;
  assert v_row.status = 'failed' and v_row.last_error = 'dataforseo_backlinks_not_subscribed',
    'failure: status and the distinct error are recorded';

  raise notice 'ALL 0052 BACKLINKS SCHEDULING TESTS PASSED';
end;
$$;

rollback;
