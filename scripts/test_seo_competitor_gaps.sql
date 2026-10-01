-- =============================================================================
-- test_seo_competitor_gaps.sql — non-destructive test of 0063: tenant
-- isolation on the gap tables and the seo_competitor_gaps view (rule 4), what
-- the view leaves out (tracked phrases, dismissed phrases, inactive
-- competitors), the dismiss function, and per-location scheduling including
-- the pull-forward for a competitor that has never been fetched.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_competitor_gaps.sql
--
-- To see it FAIL:
--   * alter view seo_competitor_gaps set (security_invoker = false);
--     → "rls: the gap view is scoped" fails (the view runs as its owner).
--   * drop policy seo_competitor_keyword_gaps_tenant_select on seo_competitor_keyword_gaps;
--     → "rls: tenant A sees its own three gaps" fails (RLS with no policy hides all).
--   * remove the seo_competitor_gap_dismissals clause from the view
--     → "view: a dismissed phrase is gone" fails.
--   * remove the seo_keywords clause from the view
--     → "view: a phrase the location already tracks is left out" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client_a uuid;
  v_client_b uuid;
  v_loc_a    uuid;
  v_loc_a2   uuid;
  v_loc_b    uuid;
  v_comp_a1  uuid;
  v_comp_a2  uuid;
  v_comp_b   uuid;
  v_user_a   uuid;
  v_seen     int;
  v_denied   boolean;
  v_row      job_attempts%rowtype;
  v_gap      record;
begin
  insert into clients (name, slug, is_active) values ('Gap Test A', 'gap-test-a', true) returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('Gap Test B', 'gap-test-b', true) returning id into v_client_b;

  insert into seo_locations (client_id, name, website_url) values (v_client_a, 'A Main', 'https://a.example.com') returning id into v_loc_a;
  insert into seo_locations (client_id, name, website_url) values (v_client_a, 'A No Comps', 'https://a.example.com') returning id into v_loc_a2;
  insert into seo_locations (client_id, name, website_url) values (v_client_b, 'B Main', 'https://b.example.com') returning id into v_loc_b;

  insert into seo_competitors (client_id, location_id, domain) values (v_client_a, v_loc_a, 'rival.com') returning id into v_comp_a1;
  insert into seo_competitors (client_id, location_id, domain) values (v_client_a, v_loc_a, 'other.com') returning id into v_comp_a2;
  insert into seo_competitors (client_id, location_id, domain) values (v_client_b, v_loc_b, 'brival.com') returning id into v_comp_b;

  insert into seo_keywords (client_id, location_id, keyword) values (v_client_a, v_loc_a, 'plumber tulsa');

  insert into seo_competitor_keyword_gaps (client_id, location_id, competitor_id, keyword, competitor_position, search_volume, keyword_difficulty)
  values (v_client_a, v_loc_a, v_comp_a1, 'drain cleaning', 3, 900, 30),
         (v_client_a, v_loc_a, v_comp_a2, 'drain cleaning', 7, 900, 30),
         (v_client_a, v_loc_a, v_comp_a1, 'plumber tulsa', 2, 500, 20),    -- tracked here
         (v_client_a, v_loc_a, v_comp_a1, 'sump pump', 12, 300, 40),
         (v_client_a, v_loc_a, v_comp_a2, 'only other', 5, 100, 10),
         (v_client_b, v_loc_b, v_comp_b, 'roof leak', 4, 700, 25);

  -- Schema guardrails.
  begin
    insert into seo_competitor_keyword_gaps (client_id, location_id, competitor_id, keyword, competitor_position)
    values (v_client_a, v_loc_a, v_comp_a1, 'drain cleaning', 1);
    v_denied := false;
  exception when unique_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: one row per (location, competitor, phrase)';

  begin
    insert into seo_competitor_keyword_gaps (client_id, location_id, competitor_id, keyword, competitor_position)
    values (v_client_a, v_loc_a, v_comp_a1, 'bad position', 0);
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: a position must be 1-100';

  -- ---------------------------------------------------------------------------
  -- The view (as the owner).
  -- ---------------------------------------------------------------------------
  select * into v_gap from seo_competitor_gaps where location_id = v_loc_a and keyword = 'drain cleaning';
  assert v_gap.competitors_ranking = 2 and v_gap.best_competitor_position = 3,
    format('view: one row per phrase across competitors, best position kept (%s)', row_to_json(v_gap));
  assert v_gap.competitor_positions = array['rival.com #3', 'other.com #7'],
    format('view: competitor positions listed best first (%s)', v_gap.competitor_positions);
  select count(*) into v_seen from seo_competitor_gaps where location_id = v_loc_a and keyword = 'plumber tulsa';
  assert v_seen = 0, 'view: a phrase the location already tracks is left out';

  update seo_competitors set is_active = false where id = v_comp_a2;
  select count(*) into v_seen from seo_competitor_gaps where location_id = v_loc_a and keyword = 'only other';
  assert v_seen = 0, 'view: an inactive competitor''s gaps are left out';
  select competitors_ranking into v_seen from seo_competitor_gaps where location_id = v_loc_a and keyword = 'drain cleaning';
  assert v_seen = 1, 'view: an inactive competitor no longer counts';
  update seo_competitors set is_active = true where id = v_comp_a2;

  update seo_keywords set is_active = false where location_id = v_loc_a and keyword = 'plumber tulsa';
  select count(*) into v_seen from seo_competitor_gaps where location_id = v_loc_a and keyword = 'plumber tulsa';
  assert v_seen = 1, 'view: a keyword no longer tracked shows up as a gap again';
  update seo_keywords set is_active = true where location_id = v_loc_a and keyword = 'plumber tulsa';

  -- ---------------------------------------------------------------------------
  -- Scheduling (as the owner).
  -- ---------------------------------------------------------------------------
  select count(*) into v_seen from seo_competitor_gap_targets where location_id = v_loc_a and is_due;
  assert v_seen = 1, 'targets: a location with a website and a competitor is due immediately';
  select count(*) into v_seen from seo_competitor_gap_targets where location_id = v_loc_a2;
  assert v_seen = 0, 'targets: a location without competitors is not a target';

  insert into seo_competitor_gap_fetches (client_id, location_id, competitor_id, target_domain, competitor_domain)
  values (v_client_a, v_loc_a, v_comp_a1, 'a.example.com', 'rival.com'),
         (v_client_a, v_loc_a, v_comp_a2, 'a.example.com', 'other.com');
  insert into job_attempts (client_id, job_type, entity_id, status, attempt_count, next_run_at, last_run_at, last_success_at)
  values (v_client_a, 'seo_competitor_gaps', v_loc_a, 'idle', 0, now() + interval '29 days', now() - interval '1 day', now() - interval '1 day');

  perform run_due_seo_competitor_gaps(0);
  select * into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_competitor_gaps' and entity_id = v_loc_a;
  assert v_row.next_run_at > now() + interval '28 days', 'pull-forward: every competitor fetched, schedule left alone';

  insert into seo_competitors (client_id, location_id, domain) values (v_client_a, v_loc_a, 'newrival.com');
  perform run_due_seo_competitor_gaps(0);
  select * into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_competitor_gaps' and entity_id = v_loc_a;
  assert v_row.next_run_at <= now(), 'pull-forward: a never-fetched competitor makes the location due now';

  update job_attempts set next_run_at = now() + interval '1 hour', attempt_count = 1
   where client_id = v_client_a and job_type = 'seo_competitor_gaps' and entity_id = v_loc_a;
  perform run_due_seo_competitor_gaps(0);
  select * into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_competitor_gaps' and entity_id = v_loc_a;
  assert v_row.next_run_at > now(), 'pull-forward: never while backing off';

  update job_attempts set attempt_count = 0, last_run_at = now() - interval '1 hour', next_run_at = now() + interval '29 days'
   where client_id = v_client_a and job_type = 'seo_competitor_gaps' and entity_id = v_loc_a;
  perform run_due_seo_competitor_gaps(0);
  select * into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_competitor_gaps' and entity_id = v_loc_a;
  assert v_row.next_run_at > now(), 'pull-forward: not within 6 hours of the last run';

  if to_regproc('net.http_post') is not null then
    perform vault.create_secret('https://example.supabase.co/functions/v1/seo-competitor-gaps', 'seo_competitor_gaps_url', '');
    perform vault.create_secret('unit-test-shared-secret', 'voice_tool_secret', '');
    update job_attempts set next_run_at = now() where client_id = v_client_a and job_type = 'seo_competitor_gaps' and entity_id = v_loc_a;
    assert request_seo_competitor_gaps(v_loc_a) is not null, 'dispatch: succeeds with pg_net + vault secrets present';
    assert request_seo_competitor_gaps(v_loc_a) is null, 'dedup: a second dispatch while running is refused';
  else
    raise notice 'pg_net not installed — dispatch assertions skipped';
  end if;

  -- ---------------------------------------------------------------------------
  -- As tenant A (authenticated, RLS in effect).
  -- ---------------------------------------------------------------------------
  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'seo-gap-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  select count(*) into v_seen from seo_competitor_keyword_gaps where client_id = v_client_b;
  assert v_seen = 0, 'rls: gap rows scoped';
  select count(*) into v_seen from seo_competitor_gaps where client_id = v_client_b;
  assert v_seen = 0, 'rls: the gap view is scoped';
  select count(*) into v_seen from seo_competitor_gaps;
  assert v_seen = 3, format('rls: tenant A sees its own three gaps (got %s)', v_seen);
  select count(*) into v_seen from seo_competitor_gap_fetches;
  assert v_seen = 2, 'rls: fetches scoped';

  begin
    insert into seo_competitor_keyword_gaps (client_id, location_id, competitor_id, keyword, competitor_position)
    values (v_client_a, v_loc_a, v_comp_a1, 'forged', 1);
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: gaps are vendor-written; a tenant cannot insert them';

  begin
    insert into seo_competitor_gap_dismissals (client_id, keyword) values (v_client_b, 'roof leak');
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: a tenant cannot write dismissals directly (not even another tenant''s)';

  begin
    select count(*) into v_seen from seo_competitor_gap_targets;
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  assert v_denied, 'rule 4: the scheduling view is not readable by tenants';

  -- Dismiss.
  assert dismiss_seo_competitor_gap('  Drain   Cleaning '), 'dismiss: returns true';
  assert dismiss_seo_competitor_gap('drain cleaning'), 'dismiss: idempotent';
  assert not dismiss_seo_competitor_gap(' '), 'dismiss: a blank phrase is refused';
  select count(*) into v_seen from seo_competitor_gaps where keyword = 'drain cleaning';
  assert v_seen = 0, 'view: a dismissed phrase is gone';

  reset role;

  select count(*) into v_seen from seo_competitor_gap_dismissals where client_id = v_client_a and keyword = 'drain cleaning';
  assert v_seen = 1, 'dismiss: stored once, normalised, under the caller''s client';
  select count(*) into v_seen from seo_competitor_gap_dismissals where client_id = v_client_b;
  assert v_seen = 0, 'dismiss: tenant B untouched';

  raise notice 'ALL 0063 COMPETITOR GAP TESTS PASSED';
end;
$$;

rollback;
