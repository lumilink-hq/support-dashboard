-- =============================================================================
-- test_seo_gbp_categories.sql — 0081: propose_seo_gbp_categories is
-- self-scoped, enforces Google's 9-category limit, never accepts the primary,
-- refuses forged ids and duplicates, records the pick as the approval, and
-- the allowlist now admits 'gbp_additional_categories' and nothing else new.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_gbp_categories.sql
--
-- To see it FAIL:
--   * in propose_seo_gbp_categories drop the "v_primary = any(v_names)" check
--     -> "rule 2: the primary can't be added as an additional" fails.
--   * drop "and client_id = v_client" from the location check
--     -> "self-scoped: another tenant's location" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_a    uuid;
  v_b    uuid;
  v_la   uuid;
  v_la2  uuid;
  v_lb   uuid;
  v_user uuid;
  v_r    text;
  v_seen int;
  v_row  record;
  v_nine jsonb;
  v_denied boolean;
begin
  insert into clients (name, slug, is_active) values ('Cat A', 'cat-test-a', true) returning id into v_a;
  insert into clients (name, slug, is_active) values ('Cat B', 'cat-test-b', true) returning id into v_b;
  insert into seo_locations (client_id, name) values (v_a, 'A one') returning id into v_la;
  insert into seo_locations (client_id, name) values (v_a, 'A unlinked') returning id into v_la2;
  insert into seo_locations (client_id, name) values (v_b, 'B one') returning id into v_lb;
  insert into seo_gbp_locations (client_id, location_name, account_name, maps_uri, linked_location_id, profile) values
    (v_a, 'locations/1', 'accounts/1', 'https://maps.google.com/?cid=1', v_la,
     '{"categories":{"primaryCategory":{"name":"categories/gcid:cannabis_store","displayName":"Cannabis store"},"additionalCategories":[]}}'),
    (v_b, 'locations/2', 'accounts/2', 'https://maps.google.com/?cid=2', v_lb, '{}');
  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, target_url)
  values (v_a, v_la, 'gbp_profile', 'gbp_no_additional_categories', 'info', 'One category', 'https://maps.google.com/?cid=1');

  -- The allowlist admits categories now, and still nothing else.
  begin
    insert into seo_actions (client_id, location_id, action_type, target_field, idempotency_key, status)
    values (v_a, v_la, 'gbp_field_update', 'gbp_primary_category', 'k1', 'approved');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'rule 2: the allowlist still refuses other profile fields';

  v_user := gen_random_uuid();
  insert into auth.users (id, email) values (v_user, 'cat-test@example.com');
  update users set client_id = v_a, role = 'admin' where id = v_user;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_r := propose_seo_gbp_categories(v_lb, '[]');
  assert v_r = 'not_found', format('self-scoped: another tenant''s location, got %s', v_r);
  v_r := propose_seo_gbp_categories(v_la2, '[{"name":"categories/gcid:atm","displayName":"ATM"}]');
  assert v_r = 'not_linked', format('a location with no profile, got %s', v_r);
  v_r := propose_seo_gbp_categories(v_la, '[{"name":"categories/gcid:cannabis_store","displayName":"Cannabis store"}]');
  assert v_r = 'invalid', format('rule 2: the primary can''t be added as an additional, got %s', v_r);
  v_r := propose_seo_gbp_categories(v_la, '[{"name":"gcid:atm","displayName":"ATM"}]');
  assert v_r = 'invalid', 'a forged id is refused';
  v_r := propose_seo_gbp_categories(v_la, '[{"name":"categories/gcid:atm","displayName":"ATM"},{"name":"categories/gcid:atm","displayName":"ATM"}]');
  assert v_r = 'invalid', 'duplicates are refused';
  select jsonb_agg(jsonb_build_object('name', 'categories/gcid:c' || g, 'displayName', 'C' || g)) into v_nine from generate_series(1, 10) g;
  v_r := propose_seo_gbp_categories(v_la, v_nine);
  assert v_r = 'invalid', 'more than 9 is refused';
  v_r := propose_seo_gbp_categories(v_la, '[]');
  assert v_r = 'unchanged', format('nothing to change, got %s', v_r);

  v_r := propose_seo_gbp_categories(v_la, '[{"name":"categories/gcid:cannabis_delivery","displayName":"Cannabis delivery"},{"name":"categories/gcid:medical_marijuana_dispensary","displayName":"Medical marijuana dispensary"}]');
  assert v_r = 'ok', format('a valid pick, got %s', v_r);
  v_r := propose_seo_gbp_categories(v_la, '[{"name":"categories/gcid:atm","displayName":"ATM"}]');
  assert v_r = 'already_pending', format('one live change at a time, got %s', v_r);
  reset role;

  select * into v_row from seo_actions where location_id = v_la and target_field = 'gbp_additional_categories';
  assert v_row.status = 'approved' and v_row.approved_by = v_user and v_row.approved_at is not null, 'the pick is the approval, stamped with who';
  assert v_row.proposed_value->>'value' = '["categories/gcid:cannabis_delivery", "categories/gcid:medical_marijuana_dispensary"]', format('ids sorted for the publisher: %s', v_row.proposed_value->>'value');
  assert v_row.diff->>'after' = 'Cannabis delivery, Medical marijuana dispensary', 'labels for the approvals page';
  assert v_row.diff->>'before' is null, 'nothing before';
  assert v_row.finding_id is not null, 'linked to the one-category finding';
  select count(*) into v_seen from seo_findings where location_id = v_la and status = 'actioned';
  assert v_seen = 1, 'the finding is actioned';

  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  begin
    perform propose_seo_gbp_categories(v_la, '[]');
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rule 4: anon can''t call it';
  reset role;

  raise notice 'test_seo_gbp_categories: all assertions passed';
end;
$$;

rollback;
