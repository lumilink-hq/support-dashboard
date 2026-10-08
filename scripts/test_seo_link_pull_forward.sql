-- =============================================================================
-- test_seo_link_pull_forward.sql — non-destructive test of 0072: a website's
-- link-opportunity job is pulled forward when a competitor is added after its
-- last run, and only then.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_link_pull_forward.sql
-- With or without pg_net: a pulled-forward job is dispatched in the same tick
-- (and, locally with no Vault secret, fails and backs off), so the asserts use
-- the function's own pulled_forward count and whether last_run_at moved.
--
-- To see it FAIL:
--   * drop the "c.created_at > ja.last_run_at" clause from 0072
--     → "no new competitor: not pulled" fails.
--   * drop the "count(distinct ...) >= 2" clause
--     → "one competitor: not pulled" fails.
--   * drop "p.is_primary"
--     → "new competitor on the site: primary pulled forward" fails
--       (pulled_forward 2: the store's row was pulled too).
--   * run it against 0066's run_due_seo_link_opportunities()
--     → the same assertion fails (pulled_forward is missing).
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client   uuid;
  v_primary  uuid;
  v_store    uuid;
  v_far      timestamptz := now() + interval '20 days';
  v_next     timestamptz;
  v_store_next timestamptz;
  v_result   jsonb;
  v_last     timestamptz;
begin
  -- Two locations on one website: the older one is the primary (0070).
  insert into clients (name, slug, is_active) values ('Link Pull Test', 'link-pull-test', true) returning id into v_client;
  insert into seo_locations (client_id, name, website_url, created_at)
    values (v_client, 'Primary', 'https://pull.example.com', now() - interval '60 days') returning id into v_primary;
  insert into seo_locations (client_id, name, website_url, created_at)
    values (v_client, 'Store', 'https://www.pull.example.com/store', now() - interval '30 days') returning id into v_store;

  -- Last link run 10 days ago, next one 20 days out.
  insert into job_attempts (client_id, job_type, entity_id, status, attempt_count, last_run_at, next_run_at)
    values (v_client, 'seo_link_opportunities', v_primary, 'idle', 0, now() - interval '10 days', v_far),
           (v_client, 'seo_link_opportunities', v_store,   'idle', 0, now() - interval '10 days', v_far);

  -- Two competitors, both older than the last run: nothing to do.
  insert into seo_competitors (client_id, location_id, domain, created_at)
    values (v_client, v_primary, 'old-rival.example', now() - interval '40 days'),
           (v_client, v_primary, 'older-rival.example', now() - interval '50 days');
  perform run_due_seo_link_opportunities();
  select next_run_at into v_next from job_attempts where entity_id = v_primary and job_type = 'seo_link_opportunities';
  assert v_next = v_far, 'no new competitor: not pulled';

  -- A single active competitor that is new: the gap part needs a pair, so no.
  update seo_competitors set is_active = false where client_id = v_client;
  insert into seo_competitors (client_id, location_id, domain) values (v_client, v_primary, 'new-rival.example');
  perform run_due_seo_link_opportunities();
  select next_run_at into v_next from job_attempts where entity_id = v_primary and job_type = 'seo_link_opportunities';
  assert v_next = v_far, 'one competitor: not pulled';

  -- Second active competitor, added on the OTHER location on the same site:
  -- the primary reads every location's competitors, so this counts.
  insert into seo_competitors (client_id, location_id, domain) values (v_client, v_store, 'store-rival.example');
  v_result := run_due_seo_link_opportunities();
  assert (v_result->>'pulled_forward')::int = 1, format('new competitor on the site: primary pulled forward (pulled_forward %s)', v_result->>'pulled_forward');
  select last_run_at into v_last from job_attempts where entity_id = v_primary and job_type = 'seo_link_opportunities';
  assert v_last > now() - interval '1 minute', 'the pulled job was dispatched in the same tick';
  select next_run_at into v_store_next from job_attempts where entity_id = v_store and job_type = 'seo_link_opportunities';
  assert v_store_next = v_far, 'a non-primary location''s row is left alone';

  -- Ran recently (< 6 hours): no pull even with a newer competitor.
  update job_attempts set status = 'idle', attempt_count = 0, last_run_at = now() - interval '1 hour', next_run_at = v_far
   where entity_id = v_primary and job_type = 'seo_link_opportunities';
  update seo_competitors set created_at = now() where domain = 'store-rival.example';
  perform run_due_seo_link_opportunities();
  select next_run_at into v_next from job_attempts where entity_id = v_primary and job_type = 'seo_link_opportunities';
  assert v_next = v_far, 'ran within 6 hours: not pulled';

  -- Backing off after a failure: left alone.
  update job_attempts set last_run_at = now() - interval '10 days', next_run_at = v_far, attempt_count = 2
   where entity_id = v_primary and job_type = 'seo_link_opportunities';
  perform run_due_seo_link_opportunities();
  select next_run_at into v_next from job_attempts where entity_id = v_primary and job_type = 'seo_link_opportunities';
  assert v_next = v_far, 'backing off: not pulled';

  raise notice 'ALL 0072 LINK PULL-FORWARD TESTS PASSED';
end;
$$;

rollback;
