-- =============================================================================
-- test_seo_crawl_scheduling.sql — non-destructive test of 0049: job_attempts'
-- entity_id widening (per-location scheduling) and the seo-crawl dispatch
-- path built on it. Requires pg_net + Vault stubs — see this repo's Docker
-- validation bootstrap for local/CI runs.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_seo_crawl_scheduling.sql
--   or: supabase db execute --file scripts/test_seo_crawl_scheduling.sql
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client   uuid;
  v_loc_a    uuid;
  v_loc_b    uuid;
  v_claimed  boolean;
  v_row      job_attempts%rowtype;
  v_seen     int;
  v_req      bigint;
begin
  insert into clients (name, slug, is_active) values ('Crawl Test Co', 'crawl-test-co', true)
  returning id into v_client;
  insert into seo_locations (client_id, name, website_url) values (v_client, 'Loc A', 'https://a.example.com')
  returning id into v_loc_a;
  insert into seo_locations (client_id, name, website_url) values (v_client, 'Loc B', 'https://b.example.com')
  returning id into v_loc_b;

  -- 1) Per-location independence: claiming location A must not affect B.
  v_claimed := start_job_attempt(v_client, 'seo_crawl', v_loc_a);
  assert v_claimed, 'entity: location A claimable';

  v_claimed := start_job_attempt(v_client, 'seo_crawl', v_loc_a);
  assert not v_claimed, 'entity: location A now in flight, second claim refused';

  v_claimed := start_job_attempt(v_client, 'seo_crawl', v_loc_b);
  assert v_claimed, 'entity: location B is INDEPENDENT of A''s in-flight state';

  -- 2) Two rows exist, correctly scoped by entity_id.
  select count(*) into v_seen from job_attempts where client_id = v_client and job_type = 'seo_crawl';
  assert v_seen = 2, format('entity: expected 2 job_attempts rows (one per location), got %s', v_seen);

  -- 3) complete_job_attempt targets the right entity.
  perform complete_job_attempt(v_client, 'seo_crawl', true, null, 10080, 1440, v_loc_a);
  select status into v_row.status from job_attempts
   where client_id = v_client and job_type = 'seo_crawl' and entity_id = v_loc_a;
  assert v_row.status = 'idle', 'entity: completing A does not touch B';
  select status into v_row.status from job_attempts
   where client_id = v_client and job_type = 'seo_crawl' and entity_id = v_loc_b;
  assert v_row.status = 'running', 'entity: B is untouched by A''s completion';

  -- 4) The existing client-level (entity_id NULL) job type still works
  --    unchanged — google_token_refresh's own call site never passes entity_id.
  v_claimed := start_job_attempt(v_client, 'google_token_refresh');
  assert v_claimed, 'regression: client-level (null entity_id) jobs still claimable';
  v_claimed := start_job_attempt(v_client, 'google_token_refresh');
  assert not v_claimed, 'regression: client-level dedup still works';
  perform complete_job_attempt(v_client, 'google_token_refresh', true);
  select status into v_row.status from job_attempts
   where client_id = v_client and job_type = 'google_token_refresh' and entity_id is null;
  assert v_row.status = 'idle', 'regression: client-level completion still works';

  -- 5) seo_crawl_targets: a fresh location (never crawled) is due; the one
  --    completed in step 3 is not due again for a week.
  select count(*) into v_seen from seo_crawl_targets where location_id = v_loc_a and is_due;
  assert v_seen = 0, 'targets: location A just completed, not due for another week';

  -- Location B never had complete_job_attempt called (still 'running' from
  -- step 1's claim) — force it back to a due state to test the view's
  -- "never run" -> due logic on a THIRD, completely fresh location instead.
  declare
    v_loc_c uuid;
  begin
    insert into seo_locations (client_id, name, website_url) values (v_client, 'Loc C', 'https://c.example.com')
    returning id into v_loc_c;
    select count(*) into v_seen from seo_crawl_targets where location_id = v_loc_c and is_due;
    assert v_seen = 1, 'targets: a never-crawled location is due immediately';

    -- 6) request_seo_crawl: no pg_net vendor budget check for crawling a
    --    client's own site (unlike a paid vendor) — but it DOES still claim
    --    via start_job_attempt and needs the seo_crawl_url Vault secret.
    perform vault.create_secret('https://example.supabase.co/functions/v1/seo-crawl', 'seo_crawl_url', '');
    perform vault.create_secret('unit-test-shared-secret', 'voice_tool_secret', '');

    v_req := request_seo_crawl(v_loc_c);
    assert v_req is not null, 'dispatch: request_seo_crawl succeeds with pg_net + vault secrets present';

    select status, entity_id into v_row.status, v_row.entity_id from job_attempts
     where client_id = v_client and job_type = 'seo_crawl' and entity_id = v_loc_c;
    assert v_row.status = 'running', 'dispatch: seo_crawl claimed location C before dispatching';
  end;

  raise notice 'ALL 0049 CRAWL SCHEDULING TESTS PASSED';
end;
$$;

rollback;
