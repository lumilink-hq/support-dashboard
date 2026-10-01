-- =============================================================================
-- test_seo_keyword_research.sql — non-destructive test of 0062: tenant
-- isolation on seo_keyword_metrics / seo_keyword_suggestions (rule 4), the
-- dismiss function, and the per-client scheduling wiring including the
-- pull-forward for keywords that have never been measured.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_keyword_research.sql
--
-- Dispatch assertions need pg_net + Vault; without pg_net they are skipped
-- with a notice (the local Supabase image has neither pg_cron nor pg_net).
--
-- To see it FAIL:
--   * drop policy seo_keyword_suggestions_tenant_select on seo_keyword_suggestions;
--     → "rls: suggestions scoped" fails (tenant sees nothing at all).
--   * grant update on seo_keyword_suggestions to authenticated; plus a
--     permissive update policy → "rls: a tenant cannot edit a suggestion" fails.
--   * remove "and client_id = v_client" from dismiss_seo_keyword_suggestion
--     → "dismiss: another tenant's suggestion is refused" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client_a uuid;
  v_client_b uuid;
  v_client_c uuid;
  v_loc_a    uuid;
  v_loc_b    uuid;
  v_sug_a    uuid;
  v_sug_b    uuid;
  v_user_a   uuid;
  v_seen     int;
  v_denied   boolean;
  v_ok       boolean;
  v_res      jsonb;
  v_row      job_attempts%rowtype;
begin
  insert into clients (name, slug, is_active) values ('KW Test A', 'kw-test-a', true) returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('KW Test B', 'kw-test-b', true) returning id into v_client_b;
  insert into clients (name, slug, is_active) values ('KW Test C', 'kw-test-c', true) returning id into v_client_c;

  insert into seo_locations (client_id, name, website_url) values (v_client_a, 'Loc A', 'https://a.example.com')
  returning id into v_loc_a;
  insert into seo_locations (client_id, name, website_url, search_console_site_url)
  values (v_client_b, 'Loc B', 'https://b.example.com', 'sc-domain:b.example.com')
  returning id into v_loc_b;
  -- C: a location with a keyword but no website — never a target.
  insert into seo_locations (client_id, name) values (v_client_c, 'Loc C');

  insert into seo_keywords (client_id, location_id, keyword) values (v_client_a, v_loc_a, 'plumber tulsa');

  insert into seo_keyword_metrics (client_id, keyword, search_volume, keyword_difficulty, location_code, language_code)
  values (v_client_a, 'plumber tulsa', 880, 34, 2840, 'en'),
         (v_client_b, 'roof repair', 5000, 61, 2840, 'en');
  insert into seo_keyword_suggestions (client_id, keyword, source, search_volume)
  values (v_client_a, 'emergency plumber', 'related', 1200) returning id into v_sug_a;
  insert into seo_keyword_suggestions (client_id, keyword, source, gsc_impressions, gsc_position)
  values (v_client_b, 'roof leak', 'search_console', 300, 11.2) returning id into v_sug_b;

  -- Schema guardrails.
  begin
    insert into seo_keyword_suggestions (client_id, keyword, source) values (v_client_a, 'emergency plumber', 'related');
    v_denied := false;
  exception when unique_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: one suggestion per (client, keyword)';

  begin
    insert into seo_keyword_suggestions (client_id, keyword, source) values (v_client_a, 'x', 'guess');
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: unknown source / too-short keyword rejected';

  begin
    insert into seo_keyword_metrics (client_id, keyword, keyword_difficulty, location_code, language_code)
    values (v_client_a, 'kd too high', 140, 2840, 'en');
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: keyword difficulty outside 0-100 rejected';

  -- ---------------------------------------------------------------------------
  -- Scheduling (as the owner role).
  -- ---------------------------------------------------------------------------
  select count(*) into v_seen from seo_keyword_research_targets where client_id = v_client_a and is_due;
  assert v_seen = 1, 'targets: a client with a keyword and a website is due immediately';
  select count(*) into v_seen from seo_keyword_research_targets where client_id = v_client_b and is_due;
  assert v_seen = 1, 'targets: a client with only a Search Console property is a target';
  select count(*) into v_seen from seo_keyword_research_targets where client_id = v_client_c;
  assert v_seen = 0, 'targets: no website location, not a target';

  -- Pull-forward. Settle A as if it ran successfully a day ago, next run in a month.
  insert into job_attempts (client_id, job_type, entity_id, status, attempt_count, next_run_at, last_run_at, last_success_at)
  values (v_client_a, 'seo_keyword_research', null, 'idle', 0, now() + interval '29 days', now() - interval '1 day', now() - interval '1 day');

  -- Every active keyword has metrics → nothing to pull forward.
  perform run_due_seo_keyword_research(0);
  select * into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_keyword_research' and entity_id is null;
  assert v_row.next_run_at > now() + interval '28 days', 'pull-forward: measured keywords leave the monthly schedule alone';

  -- A new, never-measured keyword → pulled forward.
  insert into seo_keywords (client_id, location_id, keyword) values (v_client_a, v_loc_a, 'drain cleaning tulsa');
  v_res := run_due_seo_keyword_research(0);
  select * into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_keyword_research' and entity_id is null;
  assert v_row.next_run_at <= now(), format('pull-forward: a never-measured keyword makes the client due now (%s)', v_res);

  -- Not while backing off.
  update job_attempts set next_run_at = now() + interval '1 hour', attempt_count = 2
   where client_id = v_client_a and job_type = 'seo_keyword_research' and entity_id is null;
  perform run_due_seo_keyword_research(0);
  select * into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_keyword_research' and entity_id is null;
  assert v_row.next_run_at > now(), 'pull-forward: never while the job is backing off';

  -- Not within 6 hours of the last run.
  update job_attempts set attempt_count = 0, last_run_at = now() - interval '1 hour', next_run_at = now() + interval '29 days'
   where client_id = v_client_a and job_type = 'seo_keyword_research' and entity_id is null;
  perform run_due_seo_keyword_research(0);
  select * into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_keyword_research' and entity_id is null;
  assert v_row.next_run_at > now(), 'pull-forward: not within 6 hours of the last run';

  -- An inactive keyword never pulls forward.
  update seo_keywords set is_active = false where client_id = v_client_a and keyword = 'drain cleaning tulsa';
  update job_attempts set last_run_at = now() - interval '1 day'
   where client_id = v_client_a and job_type = 'seo_keyword_research' and entity_id is null;
  perform run_due_seo_keyword_research(0);
  select * into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_keyword_research' and entity_id is null;
  assert v_row.next_run_at > now(), 'pull-forward: an inactive keyword is ignored';

  -- Search Console backfill finished after the last good run → pulled forward.
  insert into job_attempts (client_id, job_type, entity_id, status, attempt_count, next_run_at, last_run_at, last_success_at)
  values (v_client_b, 'seo_keyword_research', null, 'idle', 0, now() + interval '29 days', now() - interval '2 days', now() - interval '2 days');
  insert into seo_search_properties (client_id, site_url, status, backfilled_at)
  values (v_client_b, 'sc-domain:b.example.com', 'ok', now() - interval '1 day');
  perform run_due_seo_keyword_research(0);
  select * into v_row from job_attempts where client_id = v_client_b and job_type = 'seo_keyword_research' and entity_id is null;
  assert v_row.next_run_at <= now(), 'pull-forward: a newly finished Search Console backfill makes the client due';

  -- Dispatch, when pg_net is present.
  if to_regproc('net.http_post') is not null then
    perform vault.create_secret('https://example.supabase.co/functions/v1/seo-keyword-research', 'seo_keyword_research_url', '');
    perform vault.create_secret('unit-test-shared-secret', 'voice_tool_secret', '');
    assert request_seo_keyword_research(v_client_b) is not null, 'dispatch: succeeds with pg_net + vault secrets present';
    assert request_seo_keyword_research(v_client_b) is null, 'dedup: a second dispatch while running is refused';
  else
    raise notice 'pg_net not installed — dispatch assertions skipped';
  end if;

  perform complete_job_attempt(v_client_b, 'seo_keyword_research', true, null, 43200, 1440, null);
  select * into v_row from job_attempts where client_id = v_client_b and job_type = 'seo_keyword_research' and entity_id is null;
  assert v_row.status = 'idle' and v_row.next_run_at > now() + interval '29 days',
    format('completion: settles to idle, next run ~a month out, got %s / %s', v_row.status, v_row.next_run_at);

  -- ---------------------------------------------------------------------------
  -- As tenant A (authenticated, RLS in effect).
  -- ---------------------------------------------------------------------------
  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'seo-kw-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  select count(*) into v_seen from seo_keyword_metrics;     assert v_seen = 1, 'rls: metrics scoped';
  select count(*) into v_seen from seo_keyword_suggestions; assert v_seen = 1, 'rls: suggestions scoped';
  select count(*) into v_seen from seo_keyword_suggestions where client_id = v_client_b;
  assert v_seen = 0, 'rls: tenant A must not see tenant B''s suggestions';

  begin
    update seo_keyword_suggestions set search_volume = 999999 where id = v_sug_a;
    get diagnostics v_seen = row_count;
    v_denied := v_seen = 0;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: a tenant cannot edit a suggestion, even its own';

  begin
    insert into seo_keyword_metrics (client_id, keyword, search_volume, location_code, language_code)
    values (v_client_a, 'forged', 1, 2840, 'en');
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: metrics are vendor-written; a tenant cannot insert them';

  begin
    select count(*) into v_seen from seo_keyword_research_targets;
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  assert v_denied, 'rule 4: the scheduling view is not readable by tenants';

  -- Dismiss.
  v_ok := dismiss_seo_keyword_suggestion(v_sug_b);
  assert not v_ok, 'dismiss: another tenant''s suggestion is refused';
  v_ok := dismiss_seo_keyword_suggestion(v_sug_a);
  assert v_ok, 'dismiss: own open suggestion is dismissed';
  v_ok := dismiss_seo_keyword_suggestion(v_sug_a);
  assert not v_ok, 'dismiss: dismissing twice reports nothing to do';

  reset role;

  select count(*) into v_seen from seo_keyword_suggestions where id = v_sug_b and status = 'open';
  assert v_seen = 1, 'dismiss: tenant B''s suggestion is untouched';
  select count(*) into v_seen from seo_keyword_suggestions where id = v_sug_a and status = 'dismissed' and dismissed_at is not null;
  assert v_seen = 1, 'dismiss: status and time recorded';

  raise notice 'ALL 0062 KEYWORD RESEARCH TESTS PASSED';
end;
$$;

rollback;
