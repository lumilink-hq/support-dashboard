-- =============================================================================
-- test_seo_ai_visibility.sql — non-destructive test of 0053: tenant isolation
-- on seo_ai_queries / seo_ai_mentions (rule 4) and the per-client scheduling
-- wiring (job_attempts with a NULL entity_id). Requires pg_net + Vault stubs —
-- see this repo's Docker validation bootstrap for local/CI runs.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_seo_ai_visibility.sql
--   or: supabase db execute --file scripts/test_seo_ai_visibility.sql
--
-- To see it FAIL (rule 4): drop policy seo_ai_mentions_tenant_select on
-- seo_ai_mentions; the "rls: seo_ai_mentions scoped" assertion then fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client_a uuid;
  v_client_b uuid;
  v_loc_a    uuid;
  v_q_a      uuid;
  v_q_b      uuid;
  v_user_a   uuid;
  v_seen     int;
  v_denied   boolean;
  v_req      bigint;
  v_row      job_attempts%rowtype;
begin
  insert into clients (name, slug, is_active) values ('AI Vis Test A', 'ai-vis-test-a', true) returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('AI Vis Test B', 'ai-vis-test-b', true) returning id into v_client_b;
  insert into seo_locations (client_id, name, website_url) values (v_client_a, 'Loc A', 'https://a.example.com')
  returning id into v_loc_a;

  insert into seo_ai_queries (client_id, query) values (v_client_a, 'emergency plumber') returning id into v_q_a;
  insert into seo_ai_queries (client_id, query) values (v_client_b, 'roof repair')       returning id into v_q_b;
  insert into seo_ai_mentions (client_id, query_id, platform, domain, cited_count)
  values (v_client_a, v_q_a, 'google', 'a.example.com', 3),
         (v_client_b, v_q_b, 'google', 'b.example.com', 9);

  -- Schema guardrail: a blank / one-character query is rejected.
  begin
    insert into seo_ai_queries (client_id, query) values (v_client_a, ' ');
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: a blank query must be rejected';

  begin
    insert into seo_ai_mentions (client_id, query_id, platform, domain) values (v_client_a, v_q_a, 'google', 'a.example.com');
    v_denied := false;
  exception when unique_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: one row per (query, platform, day)';

  -- ---------------------------------------------------------------------------
  -- Scheduling (as the owner role, before assuming a tenant).
  -- ---------------------------------------------------------------------------
  select count(*) into v_seen from seo_ai_visibility_targets where client_id = v_client_a and is_due;
  assert v_seen = 1, 'targets: a client with a query and a website is due immediately';
  select count(*) into v_seen from seo_ai_visibility_targets where client_id = v_client_b;
  assert v_seen = 0, 'targets: a client with a query but no website location is not a target';

  perform vault.create_secret('https://example.supabase.co/functions/v1/seo-ai-visibility', 'seo_ai_visibility_url', '');
  perform vault.create_secret('unit-test-shared-secret', 'voice_tool_secret', '');

  v_req := request_seo_ai_visibility(v_client_a);
  assert v_req is not null, 'dispatch: succeeds with pg_net + vault secrets present';
  select * into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_ai_visibility' and entity_id is null;
  assert v_row.status = 'running', 'dispatch: claimed before dispatching (NULL entity_id row)';
  assert request_seo_ai_visibility(v_client_a) is null, 'dedup: a second dispatch while running is refused';

  perform complete_job_attempt(v_client_a, 'seo_ai_visibility', true, null, 10080, 1440, null);
  select * into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_ai_visibility' and entity_id is null;
  assert v_row.status = 'idle' and v_row.next_run_at > now() + interval '6 days',
    format('completion: settles to idle, next run ~a week out, got %s / %s', v_row.status, v_row.next_run_at);

  -- ---------------------------------------------------------------------------
  -- As tenant A (authenticated, RLS in effect).
  -- ---------------------------------------------------------------------------
  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'seo-ai-vis-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  select count(*) into v_seen from seo_ai_queries;  assert v_seen = 1, 'rls: seo_ai_queries scoped';
  select count(*) into v_seen from seo_ai_mentions; assert v_seen = 1, 'rls: seo_ai_mentions scoped';
  select count(*) into v_seen from seo_ai_mentions where client_id = v_client_b;
  assert v_seen = 0, 'rls: tenant A must not see tenant B''s mentions';

  insert into seo_ai_queries (client_id, query) values (v_client_a, 'water heater repair');
  update seo_ai_queries set is_active = false where id = v_q_a;
  delete from seo_ai_queries where query = 'water heater repair';

  begin
    insert into seo_ai_queries (client_id, query) values (v_client_b, 'forged');
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: tenant A must not insert a query under tenant B';

  begin
    insert into seo_ai_mentions (client_id, query_id, platform, domain, cited_count)
    values (v_client_a, v_q_a, 'chat_gpt', 'a.example.com', 99);
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: mentions are vendor-written; a tenant cannot insert them, even for itself';

  reset role;
  raise notice 'ALL 0053 AI VISIBILITY TESTS PASSED';
end;
$$;

rollback;
