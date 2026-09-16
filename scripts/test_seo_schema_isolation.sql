-- =============================================================================
-- test_seo_schema_isolation.sql — non-destructive isolation test for 0042's
-- SEO schema. Wraps everything in a transaction and ROLLS BACK, so it's safe
-- to run against any environment with migrations 0001..0042 applied.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_seo_schema_isolation.sql
--   or: supabase db execute --file scripts/test_seo_schema_isolation.sql
--
-- This is rule 4's "isolation test ... shown to fail when the protection is
-- removed": drop `security_invoker = true` from seo_location_overview, or
-- delete any RLS policy below, and the corresponding assertion here fails.
-- =============================================================================

begin;

do $$
declare
  v_client_a  uuid;
  v_client_b  uuid;
  v_loc_a     uuid;
  v_loc_b     uuid;
  v_kw_a      uuid;
  v_kw_b      uuid;
  v_comp_a    uuid;
  v_finding_a uuid;
  v_action_a  uuid;
  v_user_a    uuid;
  v_seen      int;
  v_status    text;
  v_denied    boolean;
begin
  -- ---------------------------------------------------------------------------
  -- Setup: two tenants, one location + keyword + competitor each, plus one
  -- finding and one draft action for tenant A to exercise the constrained
  -- update policies against.
  -- ---------------------------------------------------------------------------
  insert into clients (name, slug, is_active) values ('SEO Tenant A', 'seo-tenant-a', true)
  returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('SEO Tenant B', 'seo-tenant-b', true)
  returning id into v_client_b;

  insert into seo_locations (client_id, name, city, region, country_code)
  values (v_client_a, 'A Downtown', 'Springfield', 'IL', 'US') returning id into v_loc_a;
  insert into seo_locations (client_id, name, city, region, country_code)
  values (v_client_b, 'B Downtown', 'Shelbyville', 'IL', 'US') returning id into v_loc_b;

  insert into seo_keywords (client_id, location_id, keyword)
  values (v_client_a, v_loc_a, 'plumber springfield') returning id into v_kw_a;
  insert into seo_keywords (client_id, location_id, keyword)
  values (v_client_b, v_loc_b, 'plumber shelbyville') returning id into v_kw_b;

  insert into seo_competitors (client_id, location_id, domain)
  values (v_client_a, v_loc_a, 'competitor-a.example') returning id into v_comp_a;
  insert into seo_competitors (client_id, location_id, domain)
  values (v_client_b, v_loc_b, 'competitor-b.example');

  -- Vendor-collected data: only service_role writes, in this transaction that's us.
  insert into seo_rankings (client_id, location_id, keyword_id, rank_type, position)
  values (v_client_a, v_loc_a, v_kw_a, 'organic', 4);
  insert into seo_rankings (client_id, location_id, keyword_id, rank_type,
                             grid_row, grid_col, position)
  values (v_client_a, v_loc_a, v_kw_a, 'geo_grid', 3, 3, 2);
  insert into seo_rankings (client_id, location_id, keyword_id, rank_type, position)
  values (v_client_b, v_loc_b, v_kw_b, 'organic', 1);

  insert into seo_metrics_daily (client_id, location_id, metric_date, metrics)
  values (v_client_a, v_loc_a, current_date, '{"calls": 5}'::jsonb);
  insert into seo_metrics_daily (client_id, location_id, metric_date, metrics)
  values (v_client_b, v_loc_b, current_date, '{"calls": 9}'::jsonb);

  insert into seo_citations (client_id, location_id, source, match_status)
  values (v_client_a, v_loc_a, 'google', 'match');
  insert into seo_citations (client_id, location_id, source, match_status)
  values (v_client_b, v_loc_b, 'google', 'mismatch');

  insert into seo_competitor_rankings (client_id, location_id, competitor_id, keyword_id,
                                        rank_type, position)
  values (v_client_a, v_loc_a, v_comp_a, v_kw_a, 'organic', 6);

  insert into seo_backlink_snapshots (client_id, location_id, snapshot_date, total_backlinks)
  values (v_client_a, v_loc_a, current_date, 120);
  insert into seo_backlink_snapshots (client_id, location_id, snapshot_date, total_backlinks)
  values (v_client_b, v_loc_b, current_date, 340);

  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, status)
  values (v_client_a, v_loc_a, 'crawl', 'thin_content', 'warning', 'Thin location page', 'open')
  returning id into v_finding_a;
  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, status)
  values (v_client_b, v_loc_b, 'crawl', 'thin_content', 'warning', 'Thin location page', 'open');

  insert into seo_actions (client_id, location_id, finding_id, action_type, target_field,
                            previous_value, proposed_value, status, idempotency_key)
  values (v_client_a, v_loc_a, v_finding_a, 'onpage_fix', 'meta_description',
          '{"meta_description": "old"}'::jsonb, '{"meta_description": "new"}'::jsonb,
          'pending_approval', 'test-action-a-1')
  returning id into v_action_a;
  insert into seo_actions (client_id, location_id, action_type, proposed_value, status,
                            idempotency_key)
  values (v_client_b, v_loc_b, 'onpage_fix', '{"meta_description": "new"}'::jsonb,
          'pending_approval', 'test-action-b-1');

  -- ---------------------------------------------------------------------------
  -- Schema-level guardrails, checked before we ever assume a signed-in role.
  -- ---------------------------------------------------------------------------
  begin
    insert into seo_actions (client_id, location_id, action_type, target_field,
                              proposed_value, status, idempotency_key)
    values (v_client_a, v_loc_a, 'gbp_field_update', 'name', '{}'::jsonb, 'draft',
            'test-action-a-name-writeattempt');
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'schema: target_field must reject the NAP/category allowlist (rule 2)';

  -- ---------------------------------------------------------------------------
  -- As tenant A (authenticated, RLS in effect).
  -- ---------------------------------------------------------------------------
  v_user_a := gen_random_uuid();
  -- handle_new_user (0004/0034) fires on this insert and self-provisions a
  -- throwaway client from `email` — give it one so that trigger succeeds, then
  -- repoint this user's row at the tenant this test actually needs. The
  -- trigger's own throwaway client is harmless clutter (no seo_* rows), left
  -- in place rather than chased down.
  insert into auth.users (id, email) values (v_user_a, 'seo-isolation-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  -- 1) Every new table is filtered to tenant A's own rows.
  select count(*) into v_seen from seo_locations; assert v_seen = 1, 'rls: seo_locations scoped';
  select count(*) into v_seen from seo_keywords;  assert v_seen = 1, 'rls: seo_keywords scoped';
  select count(*) into v_seen from seo_competitors; assert v_seen = 1, 'rls: seo_competitors scoped';
  select count(*) into v_seen from seo_rankings;  assert v_seen = 2, 'rls: seo_rankings scoped';
  select count(*) into v_seen from seo_metrics_daily; assert v_seen = 1, 'rls: seo_metrics_daily scoped';
  select count(*) into v_seen from seo_citations; assert v_seen = 1, 'rls: seo_citations scoped';
  select count(*) into v_seen from seo_competitor_rankings;
  assert v_seen = 1, 'rls: seo_competitor_rankings scoped';
  select count(*) into v_seen from seo_backlink_snapshots;
  assert v_seen = 1, 'rls: seo_backlink_snapshots scoped';
  select count(*) into v_seen from seo_findings; assert v_seen = 1, 'rls: seo_findings scoped';
  select count(*) into v_seen from seo_actions;  assert v_seen = 1, 'rls: seo_actions scoped';

  select count(*) into v_seen from seo_locations where client_id = v_client_b;
  assert v_seen = 0, 'rls: tenant A must not see tenant B''s location';

  -- 2) The reporting view must not leak past RLS (security_invoker).
  select count(*) into v_seen from seo_location_overview;
  assert v_seen = 1, format('rls: view leaked other tenants — expected 1 row, saw %s', v_seen);

  select open_findings_count into v_seen
    from seo_location_overview where location_id = v_loc_a;
  assert v_seen = 1, 'rls: view resolves tenant A''s own open_findings_count';

  select count(*) into v_seen from seo_location_overview where location_id = v_loc_b;
  assert v_seen = 0, 'rls: view must not expose another tenant''s location row';

  -- 3) Self-service tables: tenant A can create, edit and delete its own setup data.
  insert into seo_keywords (client_id, location_id, keyword)
  values (v_client_a, v_loc_a, 'emergency plumber springfield');
  update seo_keywords set is_geo_grid_enabled = true where id = v_kw_a;
  delete from seo_competitors where id = v_comp_a;

  -- ...but not under another tenant's client_id.
  begin
    insert into seo_locations (client_id, name) values (v_client_b, 'Forged');
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: tenant A must not be able to insert a location under tenant B';

  -- 4) Vendor-collected tables are read-only for tenants, even for their own rows.
  begin
    insert into seo_rankings (client_id, location_id, keyword_id, rank_type, position)
    values (v_client_a, v_loc_a, v_kw_a, 'organic', 1);
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: tenant must NOT be able to insert seo_rankings';

  begin
    update seo_metrics_daily set metrics = '{"calls": 999}'::jsonb where location_id = v_loc_a;
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: tenant must NOT be able to edit seo_metrics_daily';

  begin
    delete from seo_citations where location_id = v_loc_a;
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: tenant must NOT be able to delete seo_citations';

  -- 5) seo_findings: tenant may dismiss an open finding, nothing else.
  update seo_findings set status = 'dismissed' where id = v_finding_a;
  select status into v_status from seo_findings where id = v_finding_a;
  assert v_status = 'dismissed', 'rls: tenant dismissing an open finding must succeed';

  begin
    update seo_findings set status = 'resolved' where id = v_finding_a;
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  -- The dismiss above already moved status to 'dismissed', so USING no longer
  -- matches (requires status = 'open') — this update affects 0 rows rather than
  -- raising, which is RLS's normal (silent, no-op) behavior for a non-matching
  -- USING clause. Confirm it truly did nothing.
  assert (select status from seo_findings where id = v_finding_a) = 'dismissed',
    'rls: a dismissed finding must not be re-openable to resolved by a tenant';

  begin
    insert into seo_findings (client_id, location_id, module, finding_type, title)
    values (v_client_a, v_loc_a, 'crawl', 'forged', 'Forged finding');
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: tenant must NOT be able to insert seo_findings';

  -- 6) seo_actions: tenant may move pending_approval -> approved, nothing else.
  update seo_actions set status = 'approved' where id = v_action_a;
  assert (select status from seo_actions where id = v_action_a) = 'approved',
    'rls: tenant approving a pending action must succeed';

  begin
    update seo_actions set status = 'published' where id = v_action_a;
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  -- Same reasoning as (5): USING requires status = 'pending_approval', which no
  -- longer holds after the approve above, so this affects 0 rows.
  assert (select status from seo_actions where id = v_action_a) = 'approved',
    'rls: tenant must NOT be able to move an action straight to published';

  begin
    insert into seo_actions (client_id, location_id, action_type, proposed_value, status,
                              idempotency_key)
    values (v_client_a, v_loc_a, 'onpage_fix', '{}'::jsonb, 'draft', 'forged-action');
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: tenant must NOT be able to insert seo_actions (drafting is backend-only)';

  reset role;
  raise notice 'ALL SEO SCHEMA ISOLATION TESTS PASSED';
end;
$$;

rollback;
