-- =============================================================================
-- test_seo_reporting.sql — non-destructive test of 0057 (Phase 6): the two
-- reporting views (rule 4: no cross-tenant leak, shown to fail without
-- security_invoker), the winnable-radius rule, seo_reports' read-only tenant
-- access, and the monthly scheduling.
-- Needs pg_net (request_seo_report); the Vault secrets are created here.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_seo_reporting.sql
--   (local stack: docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_reporting.sql)
--
-- To see it FAIL:
--   * alter view seo_rank_trend set (security_invoker = false);
--     -> "rule 4: seo_rank_trend leaked other tenants" fails.
--   * alter view seo_geo_radius set (security_invoker = false);
--     -> "rule 4: seo_geo_radius leaked other tenants" fails.
--   * grant insert on seo_reports to authenticated;
--     create policy tmp_w on seo_reports for insert with check (true);
--     -> "rule 4: a tenant must not write seo_reports" fails.
--   (seo_report_targets' revoke is belt and braces: its underlying job_attempts
--    table is also closed to tenants, so granting the view alone still errors.)
--   * drop policy seo_reports_tenant_select on seo_reports;
--     -> "rls: seo_reports scoped" fails (tenant A sees nothing).
--   * change `< 0.5` to `< 0.0` in seo_geo_radius's case
--     -> "radius: ring 0 under half means no winnable radius" fails.
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
  v_loc_c    uuid;
  v_kw_a     uuid;
  v_kw_b     uuid;
  v_kw_c     uuid;
  v_user_a   uuid;
  v_seen     int;
  v_km       int;
  v_denied   boolean;
  v_due      boolean;
  v_req      bigint;
  v_last     date := (date_trunc('month', now() at time zone 'utc') - interval '1 month')::date;
  r          int;
  c          int;
begin
  insert into clients (name, slug, is_active) values ('Report Test A', 'report-test-a', true) returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('Report Test B', 'report-test-b', true) returning id into v_client_b;
  insert into clients (name, slug, is_active) values ('Report Test C', 'report-test-c', true) returning id into v_client_c;
  insert into seo_locations (client_id, name) values (v_client_a, 'Loc A') returning id into v_loc_a;
  insert into seo_locations (client_id, name) values (v_client_b, 'Loc B') returning id into v_loc_b;
  insert into seo_locations (client_id, name) values (v_client_c, 'Loc C') returning id into v_loc_c;
  insert into seo_keywords (client_id, location_id, keyword, is_geo_grid_enabled) values (v_client_a, v_loc_a, 'plumber a', true) returning id into v_kw_a;
  insert into seo_keywords (client_id, location_id, keyword, is_geo_grid_enabled) values (v_client_b, v_loc_b, 'plumber b', true) returning id into v_kw_b;
  insert into seo_keywords (client_id, location_id, keyword, is_geo_grid_enabled) values (v_client_c, v_loc_c, 'plumber c', true) returning id into v_kw_c;

  -- Rank trend: A has organic 2 and NULL (not found) today, so 2 checked, 1 ranked.
  insert into seo_keywords (client_id, location_id, keyword) values (v_client_a, v_loc_a, 'drain a');
  insert into seo_rankings (client_id, location_id, keyword_id, rank_type, position)
  values (v_client_a, v_loc_a, v_kw_a, 'organic', 2),
         (v_client_a, v_loc_a, (select id from seo_keywords where keyword = 'drain a'), 'organic', null),
         (v_client_b, v_loc_b, v_kw_b, 'organic', 7);

  -- Geo grid. A: ring 0 and ring 1 won (position 2), ring 2 lost (null) -> 2 km.
  --             B: won everywhere -> 4 km.     C: nowhere -> no winnable radius.
  for r in 1..5 loop
    for c in 1..5 loop
      insert into seo_rankings (client_id, location_id, keyword_id, rank_type, grid_row, grid_col, position)
      values
        (v_client_a, v_loc_a, v_kw_a, 'geo_grid', r, c, case when greatest(abs(r - 3), abs(c - 3)) <= 1 then 2 else null end),
        (v_client_b, v_loc_b, v_kw_b, 'geo_grid', r, c, 1),
        (v_client_c, v_loc_c, v_kw_c, 'geo_grid', r, c, case when greatest(abs(r - 3), abs(c - 3)) = 0 then 9 else null end);
    end loop;
  end loop;

  insert into seo_reports (client_id, period_start, period_end, content)
  values (v_client_a, v_last, (v_last + interval '1 month - 1 day')::date, '{"a":1}'),
         (v_client_b, v_last, (v_last + interval '1 month - 1 day')::date, '{"b":1}');

  -- ---------------------------------------------------------------------------
  -- Radius rule, as the service role (RLS not in play)
  -- ---------------------------------------------------------------------------
  select winnable_radius_km into v_km from seo_geo_radius where location_id = v_loc_a;
  assert v_km = 2, format('radius: ring 0 and 1 won, ring 2 lost should give 2 km, got %s', v_km);
  select winnable_radius_km into v_km from seo_geo_radius where location_id = v_loc_b;
  assert v_km = 4, format('radius: a fully won grid should give 4 km, got %s', v_km);
  select count(*) into v_seen from seo_geo_radius where location_id = v_loc_c and winnable_radius_km is null;
  assert v_seen = 1, 'radius: ring 0 under half means no winnable radius';
  select keywords_checked into v_seen from seo_geo_radius where location_id = v_loc_a;
  assert v_seen = 1, 'radius: counts the geo-grid keywords checked';

  -- A location with no geo rows has no row at all ("not measured", never zero).
  insert into seo_locations (client_id, name) values (v_client_a, 'Loc A no grid');
  select count(*) into v_seen from seo_geo_radius where location_id = (select id from seo_locations where name = 'Loc A no grid');
  assert v_seen = 0, 'radius: an unmeasured location has no row';

  -- Rank trend numbers.
  select keywords_checked * 10 + keywords_ranked into v_seen
    from seo_rank_trend where location_id = v_loc_a and rank_type = 'organic';
  assert v_seen = 21, format('trend: 2 checked, 1 ranked (not-found excluded from the average), got %s', v_seen);
  select count(*) into v_seen from seo_rank_trend where rank_type = 'geo_grid';
  assert v_seen = 0, 'trend: geo grid cells are not keyword ranks';

  -- ---------------------------------------------------------------------------
  -- As tenant A (authenticated, RLS in effect)
  -- ---------------------------------------------------------------------------
  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'seo-reporting-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  select count(*) into v_seen from seo_rank_trend;
  assert v_seen = 1, format('rule 4: seo_rank_trend leaked other tenants — expected 1 row, saw %s', v_seen);
  select count(*) into v_seen from seo_geo_radius;
  assert v_seen = 1, format('rule 4: seo_geo_radius leaked other tenants — expected 1 row, saw %s', v_seen);
  select count(*) into v_seen from seo_geo_radius where location_id = v_loc_b;
  assert v_seen = 0, 'rule 4: tenant A must not see tenant B''s radius';

  select count(*) into v_seen from seo_reports;
  assert v_seen = 1, format('rls: seo_reports scoped — expected 1 row, saw %s', v_seen);
  select count(*) into v_seen from seo_reports where client_id = v_client_b;
  assert v_seen = 0, 'rls: tenant A must not see tenant B''s report';

  -- A tenant reads reports but never writes them.
  begin
    insert into seo_reports (client_id, period_start, period_end, content)
    values (v_client_a, (v_last - interval '1 month')::date, v_last - 1, '{}');
    v_denied := false;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'rule 4: a tenant must not write seo_reports';
  begin
    update seo_reports set content = '{"forged":true}' where client_id = v_client_a;
    v_denied := false;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'rule 4: a tenant must not edit seo_reports';

  begin
    perform 1 from seo_report_targets limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rule 4: authenticated must not read seo_report_targets';

  reset role;

  -- anon gets nothing at all.
  set local role anon;
  begin
    perform 1 from seo_geo_radius limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rule 4: anon must not read seo_geo_radius';
  reset role;

  -- ---------------------------------------------------------------------------
  -- Scheduling
  -- ---------------------------------------------------------------------------
  select count(*) into v_seen from seo_report_targets where client_id = v_client_a;
  assert v_seen = 0, 'schedule: a client without an active seo entitlement is never a target';

  insert into entitlements (client_id, feature, status)
  values (v_client_a, 'seo', 'active'), (v_client_b, 'seo', 'active'), (v_client_c, 'seo', 'active');

  -- A already has a report row for last month (email_status 'pending') -> still due (send not done).
  select is_due into v_due from seo_report_targets where client_id = v_client_a;
  assert v_due, 'schedule: a report whose email is still pending is due for another try';

  update seo_reports set email_status = 'sent' where client_id = v_client_a;
  select is_due into v_due from seo_report_targets where client_id = v_client_a;
  assert not v_due, 'schedule: a sent report is not due again';

  update seo_reports set email_status = 'skipped_no_sender' where client_id = v_client_b;
  select is_due into v_due from seo_report_targets where client_id = v_client_b;
  assert not v_due, 'schedule: a report skipped for want of a sender is final, not retried every hour';

  select is_due into v_due from seo_report_targets where client_id = v_client_c;
  assert v_due, 'schedule: no report for last month means due';

  -- Dispatch is gated by the job_attempts row and only fires with the Vault secrets.
  if to_regproc('net.http_post') is not null then
    perform vault.create_secret('http://localhost/seo-report', 'seo_report_url');
    if not exists (select 1 from vault.decrypted_secrets where name = 'voice_tool_secret') then
      perform vault.create_secret('test-secret', 'voice_tool_secret');
    end if;
    v_req := request_seo_report(v_client_c);
    assert v_req is not null, 'schedule: a due client is dispatched';
    v_req := request_seo_report(v_client_c);
    assert v_req is null, 'schedule: a second dispatch while in flight is refused';
  else
    raise notice 'pg_net not installed — dispatch assertions skipped';
  end if;

  raise notice 'test_seo_reporting: all assertions passed';
end;
$$;

rollback;
