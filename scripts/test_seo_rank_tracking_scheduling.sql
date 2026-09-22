-- =============================================================================
-- test_seo_rank_tracking_scheduling.sql — non-destructive test of 0051's
-- scheduling wiring: submit targets follow keyword existence, collect skips
-- when nothing is pending and dispatches once a task is. Requires pg_net +
-- Vault stubs — see this repo's Docker validation bootstrap for local/CI runs.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_seo_rank_tracking_scheduling.sql
--   or: supabase db execute --file scripts/test_seo_rank_tracking_scheduling.sql
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_loc    uuid;
  v_kw     uuid;
  v_req    bigint;
begin
  insert into clients (name, slug, is_active) values ('Rank Test Co', 'rank-test-co', true)
  returning id into v_client;
  insert into seo_locations (client_id, name) values (v_client, 'Loc A')
  returning id into v_loc;

  -- A location with no keywords is not a submit target at all.
  perform 1 from seo_rank_submit_targets where location_id = v_loc;
  assert not found, 'targets: a location with no keywords is not a target';

  insert into seo_keywords (client_id, location_id, keyword) values (v_client, v_loc, 'plumber springfield')
  returning id into v_kw;

  perform 1 from seo_rank_submit_targets where location_id = v_loc and is_due;
  assert found, 'targets: a location with a keyword and no prior submit is due';

  -- collect skips outright when there's nothing pending (no pg_net call needed).
  v_req := request_seo_rank_collect();
  assert v_req is null, 'collect: skips when seo_rank_tasks has no submitted rows';

  perform vault.create_secret('https://example.supabase.co/functions/v1/seo-rank-tracking', 'seo_rank_tracking_url', '');
  perform vault.create_secret('unit-test-shared-secret', 'voice_tool_secret', '');

  v_req := request_seo_rank_submit(v_loc);
  assert v_req is not null, 'dispatch: submit succeeds with pg_net + vault secrets present';

  -- Once a task exists (submitted), collect DOES dispatch.
  insert into seo_rank_tasks (client_id, location_id, keyword_id, dataforseo_task_id)
  values (v_client, v_loc, v_kw, 'fake-task-id-1');
  v_req := request_seo_rank_collect();
  assert v_req is not null, 'collect: dispatches once a submitted task exists';

  raise notice 'ALL 0051 RANK TRACKING SCHEDULING TESTS PASSED';
end;
$$;

rollback;
