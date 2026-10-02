-- =============================================================================
-- test_seo_location_details.sql — non-destructive test of 0067: the
-- self-service intake's RLS (own client AND own location), the confirmation
-- stamp, and the size limits.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_location_details.sql
--
-- To see it FAIL:
--   * drop the location clause from the policy's WITH CHECK
--     → "rls: not for another client's location, even under your own client_id" fails.
--   * drop trigger trg_seo_location_details_stamp on seo_location_details;
--     → "stamp: confirmed_by is the signed-in user" fails.
--   * alter table seo_location_details drop constraint
--     seo_location_details_service_areas_check;
--     → "limits: at most 20 service areas" fails.
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
  v_loc_b2   uuid;
  v_user_a   uuid;
  v_other    uuid := gen_random_uuid();  -- a real user of the same client, to forge
  v_seen     int;
  v_denied   boolean;
  v_row      seo_location_details%rowtype;
begin
  insert into clients (name, slug, is_active) values ('Details Test A', 'details-test-a', true) returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('Details Test B', 'details-test-b', true) returning id into v_client_b;
  insert into seo_locations (client_id, name, website_url) values (v_client_a, 'A', 'https://a.example.com') returning id into v_loc_a;
  insert into seo_locations (client_id, name, website_url) values (v_client_b, 'B', 'https://b.example.com') returning id into v_loc_b;
  -- B's second location has no intake row, so writing to it can only be
  -- stopped by the policy, not by the one-row-per-location key.
  insert into seo_locations (client_id, name, website_url) values (v_client_b, 'B2', 'https://b2.example.com') returning id into v_loc_b2;
  insert into seo_location_details (location_id, client_id, service_areas) values (v_loc_b, v_client_b, '{Uptown}');

  -- Limits (as the owner, so only the CHECKs stand in the way).
  begin
    insert into seo_location_details (location_id, client_id, service_areas)
    values (v_loc_a, v_client_a, array(select 'Area ' || g from generate_series(1, 21) g));
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'limits: at most 20 service areas';
  begin
    insert into seo_location_details (location_id, client_id, landmarks) values (v_loc_a, v_client_a, array[repeat('x', 81)]);
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'limits: a landmark is at most 80 characters';
  begin
    insert into seo_location_details (location_id, client_id, services) values (v_loc_a, v_client_a, array['x']);
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'limits: an item is at least 2 characters';
  begin
    insert into seo_location_details (location_id, client_id, year_founded) values (v_loc_a, v_client_a, 1700);
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'limits: year founded from 1800';
  begin
    insert into seo_location_details (location_id, client_id, guarantee) values (v_loc_a, v_client_a, repeat('g', 121));
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'limits: a guarantee is at most 120 characters';

  -- A service-role write keeps what it sets (no signed-in user to stamp).
  insert into seo_location_details (location_id, client_id, confirmed_at) values (v_loc_a, v_client_a, '2020-01-01');
  select * into v_row from seo_location_details where location_id = v_loc_a;
  assert v_row.confirmed_at = '2020-01-01'::timestamptz and v_row.confirmed_by is null, 'stamp: service-role writes are left alone';
  delete from seo_location_details where location_id = v_loc_a;

  -- ---------------------------------------------------------------------------
  -- As tenant A.
  -- ---------------------------------------------------------------------------
  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'seo-details-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;
  insert into auth.users (id, email) values (v_other, 'seo-details-other@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_other;
  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  insert into seo_location_details (location_id, client_id, service_areas, year_founded, insured, confirmed_by, confirmed_at)
  values (v_loc_a, v_client_a, '{Midtown,Oak Park}', 2004, true, v_other, '1999-01-01');
  select * into v_row from seo_location_details where location_id = v_loc_a;
  assert v_row.confirmed_by = v_user_a, 'stamp: confirmed_by is the signed-in user, whatever was sent';
  assert v_row.confirmed_at > now() - interval '1 minute', 'stamp: confirmed_at is now, whatever was sent';

  update seo_location_details set licensed = true where location_id = v_loc_a;
  get diagnostics v_seen = row_count;
  assert v_seen = 1, 'rls: a tenant can edit its own location''s details';

  select count(*) into v_seen from seo_location_details;
  assert v_seen = 1, 'rls: tenant A sees only its own row';

  begin
    insert into seo_location_details (location_id, client_id) values (v_loc_b2, v_client_b);
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: not for another client';

  begin
    insert into seo_location_details (location_id, client_id) values (v_loc_b2, v_client_a);
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: not for another client''s location, even under your own client_id';

  update seo_location_details set service_areas = '{Hijacked}' where location_id = v_loc_b;
  get diagnostics v_seen = row_count;
  assert v_seen = 0, 'rls: another client''s row can''t be edited';

  reset role;
  select count(*) into v_seen from seo_location_details where location_id = v_loc_b and service_areas = '{Uptown}';
  assert v_seen = 1, 'rls: tenant B''s row is untouched';

  raise notice 'ALL 0067 LOCATION DETAILS TESTS PASSED';
end;
$$;

rollback;
