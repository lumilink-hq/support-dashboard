-- =============================================================================
-- test_seo_search_console.sql — non-destructive test of 0061 (module 21): the
-- seven new tables are tenant read-only and scoped to the tenant (rule 4), the
-- scheduling view is closed to tenants, and who is a target.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_seo_search_console.sql
--   (local stack: docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_search_console.sql)
--
-- To see it FAIL:
--   * drop policy seo_search_daily_tenant_select on seo_search_daily;
--     create policy tmp_all on seo_search_daily for select using (true);
--     -> "rule 4: seo_search_daily leaked other tenants" fails.
--   * grant insert on seo_search_daily to authenticated;
--     create policy tmp_w on seo_search_daily for insert with check (true);
--     -> "rule 4: a tenant must not write seo_search_daily" fails.
--   * grant update on seo_client_settings to authenticated;
--     create policy tmp_u on seo_client_settings for update using (true);
--     -> "rule 4: a tenant must not change its own value per click" fails.
--   * grant select on seo_search_console_targets to authenticated;
--     alter view seo_search_console_targets set (security_invoker = false);
--     -> "rule 4: authenticated must not read seo_search_console_targets" fails.
--   * grant select on seo_search_daily to anon;
--     -> "rule 4: anon must not read seo_search_daily" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client_a uuid;
  v_client_b uuid;
  v_client_c uuid;
  v_user_a   uuid;
  v_seen     int;
  v_denied   boolean;
  v_req      bigint;
  t          text;
begin
  insert into clients (name, slug, is_active) values ('GSC Test A', 'gsc-test-a', true) returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('GSC Test B', 'gsc-test-b', true) returning id into v_client_b;
  insert into clients (name, slug, is_active) values ('GSC Test C', 'gsc-test-c', true) returning id into v_client_c;

  -- A: two locations on one property. B: one property. C: no property set.
  insert into seo_locations (client_id, name, search_console_site_url) values
    (v_client_a, 'A one', 'sc-domain:a.example'),
    (v_client_a, 'A two', 'sc-domain:a.example'),
    (v_client_b, 'B one', 'https://b.example/');
  insert into seo_locations (client_id, name, search_console_site_url) values (v_client_c, 'C one', '  ');

  -- Every table gets a row for A and for B, as the service role.
  insert into seo_search_properties (client_id, site_url, status, data_through) values
    (v_client_a, 'sc-domain:a.example', 'ok', '2026-09-28'),
    (v_client_b, 'https://b.example/', 'ok', '2026-09-28');
  insert into seo_search_daily (client_id, site_url, date, device, clicks, impressions) values
    (v_client_a, 'sc-domain:a.example', '2026-09-01', 'all', 10, 100),
    (v_client_a, 'sc-domain:a.example', '2026-09-01', 'mobile', 9, 80),
    (v_client_b, 'https://b.example/', '2026-09-01', 'all', 99, 999);
  insert into seo_search_monthly_pages (client_id, site_url, month, page, clicks, impressions) values
    (v_client_a, 'sc-domain:a.example', '2026-09-01', 'a.example/x', 1, 1),
    (v_client_b, 'https://b.example/', '2026-09-01', 'b.example/x', 1, 1);
  insert into seo_search_monthly_queries (client_id, site_url, month, query, clicks, impressions) values
    (v_client_a, 'sc-domain:a.example', '2026-09-01', 'a q', 1, 1),
    (v_client_b, 'https://b.example/', '2026-09-01', 'b q', 1, 1);
  insert into seo_search_keyword_counts (client_id, site_url, month, total) values
    (v_client_a, 'sc-domain:a.example', '2026-09-01', 5),
    (v_client_b, 'https://b.example/', '2026-09-01', 7);
  insert into seo_client_settings (client_id, value_per_click_cents) values (v_client_a, 250), (v_client_b, 100);
  insert into seo_milestones (client_id, occurred_on, label) values
    (v_client_a, '2026-04-01', 'Site migration'),
    (v_client_b, '2026-05-01', 'B event');

  -- Constraints.
  begin
    insert into seo_search_keyword_counts (client_id, site_url, month) values (v_client_a, 'sc-domain:a.example', '2026-09-15');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'check: a month must be the first of the month';
  begin
    insert into seo_search_daily (client_id, site_url, date, device) values (v_client_a, 'sc-domain:a.example', '2026-09-02', 'tv');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'check: unknown device rejected';

  -- ---------------------------------------------------------------------------
  -- Scheduling targets, as the service role
  -- ---------------------------------------------------------------------------
  select count(*) into v_seen from seo_search_console_targets where client_id = v_client_a;
  assert v_seen = 1, format('schedule: one target per client however many locations share the property, saw %s', v_seen);
  select count(*) into v_seen from seo_search_console_targets where client_id = v_client_c;
  assert v_seen = 0, 'schedule: a blank property is not a target';
  select count(*) into v_seen from seo_search_console_targets where client_id = v_client_b and is_due;
  assert v_seen = 1, 'schedule: never run means due';

  update seo_locations set is_active = false where client_id = v_client_b;
  select count(*) into v_seen from seo_search_console_targets where client_id = v_client_b;
  assert v_seen = 0, 'schedule: an inactive location is not a target';
  update seo_locations set is_active = true where client_id = v_client_b;

  if to_regproc('net.http_post') is not null then
    perform vault.create_secret('http://localhost/seo-search-console', 'seo_search_console_url');
    if not exists (select 1 from vault.decrypted_secrets where name = 'voice_tool_secret') then
      perform vault.create_secret('test-secret', 'voice_tool_secret');
    end if;
    v_req := request_seo_search_console(v_client_b);
    assert v_req is not null, 'schedule: a due client is dispatched';
    v_req := request_seo_search_console(v_client_b);
    assert v_req is null, 'schedule: a second dispatch while in flight is refused';
  else
    raise notice 'pg_net not installed — dispatch assertions skipped';
  end if;

  -- ---------------------------------------------------------------------------
  -- As tenant A (authenticated, RLS in effect)
  -- ---------------------------------------------------------------------------
  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'seo-gsc-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  foreach t in array array[
    'seo_search_properties', 'seo_search_daily', 'seo_search_monthly_pages',
    'seo_search_monthly_queries', 'seo_search_keyword_counts',
    'seo_client_settings', 'seo_milestones'
  ] loop
    execute format('select count(*) from %I where client_id <> %L', t, v_client_a) into v_seen;
    assert v_seen = 0, format('rule 4: %s leaked other tenants — saw %s foreign rows', t, v_seen);
    execute format('select count(*) from %I', t) into v_seen;
    assert v_seen > 0, format('rls: %s should show tenant A its own rows', t);
  end loop;

  select count(*) into v_seen from seo_search_daily;
  assert v_seen = 2, format('rls: tenant A sees its two daily rows, saw %s', v_seen);

  begin
    insert into seo_search_daily (client_id, site_url, date, clicks) values (v_client_a, 'sc-domain:a.example', '2026-09-03', 1000000);
    v_denied := false;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'rule 4: a tenant must not write seo_search_daily';

  begin
    update seo_client_settings set value_per_click_cents = 99999 where client_id = v_client_a;
    get diagnostics v_seen = row_count;
    v_denied := v_seen = 0;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'rule 4: a tenant must not change its own value per click';

  begin
    insert into seo_milestones (client_id, occurred_on, label) values (v_client_a, '2026-01-01', 'forged');
    v_denied := false;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'rule 4: a tenant must not add milestones';

  begin
    delete from seo_search_properties where client_id = v_client_a;
    get diagnostics v_seen = row_count;
    v_denied := v_seen = 0;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'rule 4: a tenant must not delete its property state';

  begin
    perform 1 from seo_search_console_targets limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rule 4: authenticated must not read seo_search_console_targets';

  begin
    perform request_seo_search_console(v_client_a);
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rule 4: authenticated must not dispatch a pull';

  reset role;

  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  begin
    perform 1 from seo_search_daily limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rule 4: anon must not read seo_search_daily';
  reset role;

  raise notice 'test_seo_search_console: all assertions passed';
end;
$$;

rollback;
