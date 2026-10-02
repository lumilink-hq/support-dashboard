-- =============================================================================
-- test_seo_link_opportunities.sql — non-destructive test of 0066: the new
-- 'backlinks' findings module, tenant isolation on the opportunity tables and
-- view (rule 4), dismissals, and per-location scheduling.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_link_opportunities.sql
-- Dispatch assertions need pg_net (prepend a rolled-back stub; see the repo memory note).
--
-- To see it FAIL:
--   * alter view seo_link_opportunities_open set (security_invoker = false);
--     → "rls: the open view is scoped" fails.
--   * remove the dismissals clause from seo_link_opportunities_open
--     → "view: a dismissed site is gone" fails.
--   * recreate dismiss_seo_link_opportunity to record the dismissal under
--     another client → "view: a dismissed site is gone" fails (the caller's
--     view still shows it).
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client_a uuid;
  v_client_b uuid;
  v_loc_a    uuid;
  v_loc_b    uuid;
  v_loc_c    uuid;
  v_user_a   uuid;
  v_seen     int;
  v_denied   boolean;
  v_row      job_attempts%rowtype;
begin
  insert into clients (name, slug, is_active) values ('Links Test A', 'links-test-a', true) returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('Links Test B', 'links-test-b', true) returning id into v_client_b;
  insert into seo_locations (client_id, name, website_url) values (v_client_a, 'A', 'https://a.example.com') returning id into v_loc_a;
  insert into seo_locations (client_id, name, website_url) values (v_client_b, 'B', 'https://b.example.com') returning id into v_loc_b;
  insert into seo_locations (client_id, name) values (v_client_a, 'A no site') returning id into v_loc_c;

  insert into seo_link_opportunities (client_id, location_id, kind, referring_domain, competitors, domain_rank)
  values (v_client_a, v_loc_a, 'gap', 'news.example', '{rival.com,other.com}', 300),
         (v_client_a, v_loc_a, 'gap', 'dir.example', '{rival.com,other.com}', 100),
         (v_client_b, v_loc_b, 'gap', 'b-news.example', '{x.com,y.com}', 200);
  insert into seo_link_opportunities (client_id, location_id, kind, referring_domain, url_from, url_to, lost_date)
  values (v_client_a, v_loc_a, 'lost', 'blog.example', 'https://blog.example/p', 'https://a.example.com/x', current_date - 10);

  -- Findings: the new module is accepted, an unknown one still isn't.
  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, target_url)
  values (v_client_a, v_loc_a, 'backlinks', 'backlinks_to_broken_page', 'warning', '3 other sites link to this page', 'https://a.example.com/old');
  begin
    insert into seo_findings (client_id, location_id, module, finding_type, title) values (v_client_a, v_loc_a, 'nonsense', 'x', 'x');
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: the findings module list is still enforced';

  -- Schema guardrails.
  begin
    insert into seo_link_opportunities (client_id, location_id, kind, referring_domain) values (v_client_a, v_loc_a, 'gap', 'news.example');
    v_denied := false;
  exception when unique_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: one row per (location, kind, site, page)';
  begin
    insert into seo_link_opportunities (client_id, location_id, kind, referring_domain) values (v_client_a, v_loc_a, 'bought', 'z.example');
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: kind is gap or lost';

  -- Scheduling (as the owner).
  select count(*) into v_seen from seo_link_opportunity_targets where location_id = v_loc_a and is_due;
  assert v_seen = 1, 'targets: a location with a website is due immediately';
  select count(*) into v_seen from seo_link_opportunity_targets where location_id = v_loc_c;
  assert v_seen = 0, 'targets: a location without a website is not a target';

  if to_regproc('net.http_post') is not null then
    perform vault.create_secret('https://example.supabase.co/functions/v1/seo-link-opportunities', 'seo_link_opportunities_url', '');
    perform vault.create_secret('unit-test-shared-secret', 'voice_tool_secret', '');
    assert request_seo_link_opportunities(v_loc_a) is not null, 'dispatch: succeeds with pg_net + vault secrets present';
    assert request_seo_link_opportunities(v_loc_a) is null, 'dedup: a second dispatch while running is refused';
    perform complete_job_attempt(v_client_a, 'seo_link_opportunities', true, null, 43200, 1440, v_loc_a);
    select * into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_link_opportunities' and entity_id = v_loc_a;
    assert v_row.next_run_at > now() + interval '29 days', 'completion: next run a month out';
  else
    raise notice 'pg_net not installed — dispatch assertions skipped';
  end if;

  -- ---------------------------------------------------------------------------
  -- As tenant A.
  -- ---------------------------------------------------------------------------
  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'seo-links-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;
  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  select count(*) into v_seen from seo_link_opportunities_open;
  assert v_seen = 3, format('rls: the open view is scoped (got %s)', v_seen);
  select count(*) into v_seen from seo_link_opportunities where client_id = v_client_b;
  assert v_seen = 0, 'rls: tenant A must not see tenant B''s rows';
  select count(*) into v_seen from seo_findings where module = 'backlinks';
  assert v_seen = 1, 'rls: tenant A sees its backlinks finding';

  begin
    insert into seo_link_opportunities (client_id, location_id, kind, referring_domain) values (v_client_a, v_loc_a, 'gap', 'forged.example');
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: opportunities are vendor-written';

  begin
    insert into seo_link_dismissals (client_id, referring_domain) values (v_client_a, 'news.example');
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: dismissals only through the function';

  begin
    select count(*) into v_seen from seo_link_opportunity_targets;
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  assert v_denied, 'rule 4: the scheduling view is not readable by tenants';

  assert dismiss_seo_link_opportunity(' NEWS.example '), 'dismiss: returns true';
  assert dismiss_seo_link_opportunity('news.example'), 'dismiss: idempotent';
  assert not dismiss_seo_link_opportunity('not a domain'), 'dismiss: refuses something that is not a domain';
  select count(*) into v_seen from seo_link_opportunities_open where referring_domain = 'news.example';
  assert v_seen = 0, 'view: a dismissed site is gone';
  select count(*) into v_seen from seo_link_opportunities_open;
  assert v_seen = 2, 'view: the others stay';

  reset role;
  select count(*) into v_seen from seo_link_dismissals where client_id = v_client_a and referring_domain = 'news.example';
  assert v_seen = 1, 'dismiss: under the caller''s client, normalised';
  select count(*) into v_seen from seo_link_dismissals where client_id = v_client_b;
  assert v_seen = 0, 'dismiss: tenant B untouched';

  raise notice 'ALL 0066 LINK OPPORTUNITY TESTS PASSED';
end;
$$;

rollback;
