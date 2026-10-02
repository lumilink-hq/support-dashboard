-- =============================================================================
-- test_seo_ai_share_of_voice.sql — non-destructive test of 0065: tenant
-- isolation on seo_ai_share_of_voice (rule 4) and the seo_ai_responses
-- per-client scheduling.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_ai_share_of_voice.sql
-- Dispatch assertions need pg_net; without it they're skipped with a notice
-- (prepend a rolled-back stub to run them; see the repo memory note).
--
-- To see it FAIL:
--   * drop policy seo_ai_share_of_voice_tenant_select on seo_ai_share_of_voice;
--     → "rls: tenant A sees its own rows" fails.
--   * grant insert on seo_ai_share_of_voice to authenticated; plus a permissive
--     insert policy → "rls: share of voice is vendor-written" fails.
--   * alter view seo_ai_responses_targets set (security_invoker = false); grant
--     select on seo_ai_responses_targets to authenticated;
--     → "rule 4: the scheduling view is not readable by tenants" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client_a uuid;
  v_client_b uuid;
  v_client_c uuid;
  v_q_a      uuid;
  v_q_b      uuid;
  v_user_a   uuid;
  v_seen     int;
  v_denied   boolean;
  v_row      job_attempts%rowtype;
begin
  insert into clients (name, slug, is_active) values ('SoV Test A', 'sov-test-a', true) returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('SoV Test B', 'sov-test-b', true) returning id into v_client_b;
  insert into clients (name, slug, is_active) values ('SoV Test C', 'sov-test-c', true) returning id into v_client_c;
  insert into seo_locations (client_id, name, website_url) values (v_client_a, 'A', 'https://a.example.com');
  insert into seo_locations (client_id, name, website_url) values (v_client_b, 'B', 'https://b.example.com');
  insert into seo_locations (client_id, name) values (v_client_c, 'C no site');

  insert into seo_ai_queries (client_id, query) values (v_client_a, 'emergency plumber') returning id into v_q_a;
  insert into seo_ai_queries (client_id, query) values (v_client_b, 'roof repair') returning id into v_q_b;
  insert into seo_ai_queries (client_id, query) values (v_client_c, 'anything');

  insert into seo_ai_share_of_voice (client_id, query_id, platform, domain, is_client, cited_count, method)
  values (v_client_a, v_q_a, 'google', 'a.example.com', true, 3, 'mentions'),
         (v_client_a, v_q_a, 'google', 'rival.com', false, 5, 'mentions'),
         (v_client_a, v_q_a, 'perplexity', 'a.example.com', true, 1, 'response'),
         (v_client_b, v_q_b, 'google', 'b.example.com', true, 2, 'mentions');

  -- Schema guardrails.
  begin
    insert into seo_ai_share_of_voice (client_id, query_id, platform, domain, cited_count, method)
    values (v_client_a, v_q_a, 'google', 'rival.com', 1, 'mentions');
    v_denied := false;
  exception when unique_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: one row per (question, platform, domain, day)';

  begin
    insert into seo_ai_share_of_voice (client_id, query_id, platform, domain, cited_count, method)
    values (v_client_a, v_q_a, 'claude', 'x.com', 1, 'guess');
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: method is mentions or response';

  begin
    insert into seo_ai_share_of_voice (client_id, query_id, platform, domain, cited_count, method)
    values (v_client_a, v_q_a, 'claude', 'y.com', -1, 'response');
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: a count is never negative';

  -- Deleting a question removes its rows (on delete cascade).
  insert into seo_ai_queries (client_id, query) values (v_client_a, 'temporary question');
  insert into seo_ai_share_of_voice (client_id, query_id, platform, domain, cited_count, method)
  select v_client_a, id, 'gemini', 'a.example.com', 0, 'response' from seo_ai_queries where query = 'temporary question';
  delete from seo_ai_queries where query = 'temporary question';
  select count(*) into v_seen from seo_ai_share_of_voice where platform = 'gemini';
  assert v_seen = 0, 'schema: rows go with their question';

  -- ---------------------------------------------------------------------------
  -- Scheduling (as the owner).
  -- ---------------------------------------------------------------------------
  select count(*) into v_seen from seo_ai_responses_targets where client_id = v_client_a and is_due;
  assert v_seen = 1, 'targets: a client with a question and a website is due immediately';
  select count(*) into v_seen from seo_ai_responses_targets where client_id = v_client_c;
  assert v_seen = 0, 'targets: no website location, not a target';
  update seo_ai_queries set is_active = false where id = v_q_b;
  select count(*) into v_seen from seo_ai_responses_targets where client_id = v_client_b;
  assert v_seen = 0, 'targets: no active question, not a target';

  if to_regproc('net.http_post') is not null then
    perform vault.create_secret('https://example.supabase.co/functions/v1/seo-ai-responses', 'seo_ai_responses_url', '');
    perform vault.create_secret('unit-test-shared-secret', 'voice_tool_secret', '');
    assert request_seo_ai_responses(v_client_a) is not null, 'dispatch: succeeds with pg_net + vault secrets present';
    select * into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_ai_responses' and entity_id is null;
    assert v_row.status = 'running', 'dispatch: claimed before dispatching';
    assert request_seo_ai_responses(v_client_a) is null, 'dedup: a second dispatch while running is refused';
    -- An unfinished week comes back in 10 minutes; a finished one in a week.
    perform complete_job_attempt(v_client_a, 'seo_ai_responses', true, null, 10, 1440, null);
    select * into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_ai_responses' and entity_id is null;
    assert v_row.next_run_at between now() + interval '9 minutes' and now() + interval '11 minutes', 'continue: back in 10 minutes';
    assert request_seo_ai_responses(v_client_a) is null, 'continue: not due again before then';
  else
    raise notice 'pg_net not installed — dispatch assertions skipped';
  end if;

  -- ---------------------------------------------------------------------------
  -- As tenant A (authenticated, RLS in effect).
  -- ---------------------------------------------------------------------------
  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'seo-sov-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  select count(*) into v_seen from seo_ai_share_of_voice;
  assert v_seen = 3, format('rls: tenant A sees its own rows (got %s)', v_seen);
  select count(*) into v_seen from seo_ai_share_of_voice where client_id = v_client_b;
  assert v_seen = 0, 'rls: tenant A must not see tenant B''s rows';

  begin
    insert into seo_ai_share_of_voice (client_id, query_id, platform, domain, cited_count, method)
    values (v_client_a, v_q_a, 'claude', 'a.example.com', 9, 'response');
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: share of voice is vendor-written; a tenant cannot insert it';

  begin
    update seo_ai_share_of_voice set cited_count = 99 where client_id = v_client_a;
    get diagnostics v_seen = row_count;
    v_denied := v_seen = 0;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: a tenant cannot edit its numbers';

  begin
    select count(*) into v_seen from seo_ai_responses_targets;
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  assert v_denied, 'rule 4: the scheduling view is not readable by tenants';

  reset role;
  raise notice 'ALL 0065 AI SHARE OF VOICE TESTS PASSED';
end;
$$;

rollback;
