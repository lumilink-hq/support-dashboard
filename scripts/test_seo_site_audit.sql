-- =============================================================================
-- test_seo_site_audit.sql — non-destructive test of 0064: tenant isolation on
-- the crawl run / page / link-check tables (rule 4), the page-limit bounds,
-- and that seo_draft_targets now treats duplicate titles and descriptions as
-- draftable.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_site_audit.sql
--
-- To see it FAIL:
--   * drop policy seo_crawl_pages_tenant_select on seo_crawl_pages;
--     → "rls: tenant A sees its own pages" fails.
--   * grant insert on seo_crawl_runs to authenticated; plus a permissive insert
--     policy → "rls: a tenant cannot write crawl state" fails.
--   * drop 'duplicate_title' from seo_draft_targets' list
--     → "draft targets: a duplicate title makes the location due" fails.
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
  v_loc_a2   uuid;
  v_run_a    uuid := gen_random_uuid();
  v_run_b    uuid := gen_random_uuid();
  v_user_a   uuid;
  v_seen     int;
  v_denied   boolean;
begin
  insert into clients (name, slug, is_active) values ('Audit Test A', 'audit-test-a', true) returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('Audit Test B', 'audit-test-b', true) returning id into v_client_b;
  insert into seo_locations (client_id, name, website_url) values (v_client_a, 'A', 'https://a.example.com') returning id into v_loc_a;
  insert into seo_locations (client_id, name, website_url) values (v_client_b, 'B', 'https://b.example.com') returning id into v_loc_b;
  -- A second location of A with no run yet, so a tenant insert can only be
  -- stopped by RLS / grants, not by the one-run-per-location key.
  insert into seo_locations (client_id, name, website_url) values (v_client_a, 'A2', 'https://a2.example.com') returning id into v_loc_a2;

  insert into seo_crawl_runs (location_id, client_id, run_id, site_host, root_url, page_limit)
  values (v_loc_a, v_client_a, v_run_a, 'a.example.com', 'https://a.example.com/', 100),
         (v_loc_b, v_client_b, v_run_b, 'b.example.com', 'https://b.example.com/', 100);
  insert into seo_crawl_pages (location_id, client_id, run_id, url, status_code)
  values (v_loc_a, v_client_a, v_run_a, 'https://a.example.com/', 200),
         (v_loc_a, v_client_a, v_run_a, 'https://a.example.com/x', 404),
         (v_loc_b, v_client_b, v_run_b, 'https://b.example.com/', 200);
  insert into seo_crawl_link_checks (location_id, client_id, run_id, url, status_code, error)
  values (v_loc_a, v_client_a, v_run_a, 'https://gone.example/', 0, 'dns'),
         (v_loc_b, v_client_b, v_run_b, 'https://other.example/', 404, null);

  -- Schema guardrails.
  begin
    insert into seo_crawl_runs (location_id, client_id, site_host, root_url, page_limit, phase)
    values (v_loc_a, v_client_a, 'x', 'x', 100, 'pages');
    v_denied := false;
  exception when unique_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: one run row per location';

  begin
    update seo_crawl_runs set phase = 'paused' where location_id = v_loc_a;
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: phase is pages / links / done';

  insert into seo_client_settings (client_id) values (v_client_a);
  select crawl_page_limit into v_seen from seo_client_settings where client_id = v_client_a;
  assert v_seen = 100, 'settings: the page limit defaults to 100';
  begin
    update seo_client_settings set crawl_page_limit = 501 where client_id = v_client_a;
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'settings: the page limit is capped at 500';
  begin
    update seo_client_settings set crawl_page_limit = 19 where client_id = v_client_a;
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'settings: the page limit is at least 20';

  -- Draft targets: a duplicate title on an open crawl finding makes the
  -- location due for drafting (0064 added the type).
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc_a;
  assert v_seen = 0, 'draft targets: nothing to draft yet';
  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, target_url, details)
  values (v_client_a, v_loc_a, 'crawl', 'duplicate_title', 'warning', 'Title is the same as on 1 other page',
          'https://a.example.com/x', '{"title": "Acme"}');
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc_a;
  assert v_seen = 1, 'draft targets: a duplicate title makes the location due';
  delete from seo_findings where location_id = v_loc_a;
  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, target_url)
  values (v_client_a, v_loc_a, 'crawl', 'duplicate_meta_description', 'warning', 'dup', 'https://a.example.com/x');
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc_a;
  assert v_seen = 1, 'draft targets: a duplicate description makes the location due';
  delete from seo_findings where location_id = v_loc_a;
  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, target_url)
  values (v_client_a, v_loc_a, 'crawl', 'orphan_page', 'warning', 'orphan', 'https://a.example.com/x');
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc_a;
  assert v_seen = 0, 'draft targets: a non-copy finding (orphan page) is not draftable';

  -- ---------------------------------------------------------------------------
  -- As tenant A (authenticated, RLS in effect).
  -- ---------------------------------------------------------------------------
  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'seo-audit-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  select count(*) into v_seen from seo_crawl_runs;        assert v_seen = 1, 'rls: tenant A sees its own run only';
  select count(*) into v_seen from seo_crawl_pages;       assert v_seen = 2, 'rls: tenant A sees its own pages';
  select count(*) into v_seen from seo_crawl_link_checks; assert v_seen = 1, 'rls: tenant A sees its own link checks';
  select count(*) into v_seen from seo_crawl_pages where client_id = v_client_b;
  assert v_seen = 0, 'rls: tenant A must not see tenant B''s pages';

  begin
    insert into seo_crawl_runs (location_id, client_id, site_host, root_url, page_limit)
    values (v_loc_a2, v_client_a, 'x', 'x', 500);
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: a tenant cannot write crawl state';

  begin
    update seo_crawl_pages set status_code = 200 where url = 'https://a.example.com/x';
    get diagnostics v_seen = row_count;
    v_denied := v_seen = 0;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: a tenant cannot edit crawled pages, even its own';

  begin
    update seo_client_settings set crawl_page_limit = 500;
    get diagnostics v_seen = row_count;
    v_denied := v_seen = 0;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: a tenant cannot raise its own page limit';

  reset role;
  raise notice 'ALL 0064 SITE AUDIT TESTS PASSED';
end;
$$;

rollback;
