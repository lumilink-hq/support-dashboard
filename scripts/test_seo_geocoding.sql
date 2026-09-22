-- =============================================================================
-- test_seo_geocoding.sql — non-destructive test of 0058: which locations the
-- geocoding scheduling view selects, that it is service-only (rule 4), and
-- dispatch.
-- Needs pg_net (request_seo_geocode); the Vault secrets are created here.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_seo_geocoding.sql
--   (local stack: docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_geocoding.sql)
--
-- To see it FAIL:
--   * grant select on seo_geocode_targets to authenticated;
--     grant select on job_attempts to authenticated;
--     -> "rule 4: authenticated must not read seo_geocode_targets" fails.
--     (granting only the view isn't enough to see this fail: job_attempts has
--     no grant to authenticated at all, so that alone is already a second,
--     independent barrier — which is exactly what rule 4 wants to prove.)
--   * change `l.lat is null and l.lng is null` to `true` in the view
--     -> "targets: a location with coordinates is never a target" fails.
--   * drop the country_code filter from the view
--     -> "targets: a non-US location is never a target" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client    uuid;
  v_complete  uuid;
  v_has_coords uuid;
  v_no_region uuid;
  v_no_street uuid;
  v_non_us    uuid;
  v_usa_text  uuid;
  v_inactive  uuid;
  v_seen      int;
  v_denied    boolean;
  v_due       boolean;
  v_req       bigint;
  v_user      uuid;
begin
  insert into clients (name, slug, is_active) values ('Geocode Test', 'geocode-test', true) returning id into v_client;

  insert into seo_locations (client_id, name, address_line1, city, region, postal_code, country_code)
  values (v_client, 'Complete US', '100 Main St', 'Springfield', 'IL', '62701', 'US') returning id into v_complete;
  insert into seo_locations (client_id, name, address_line1, city, region, postal_code, country_code, lat, lng)
  values (v_client, 'Already geocoded', '200 Elm St', 'Springfield', 'IL', '62701', 'US', 39.78, -89.65) returning id into v_has_coords;
  insert into seo_locations (client_id, name, address_line1, city, postal_code, country_code)
  values (v_client, 'No state', '300 Oak St', 'Springfield', '62701', 'US') returning id into v_no_region;
  insert into seo_locations (client_id, name, city, region, country_code)
  values (v_client, 'No street', 'Springfield', 'IL', 'US') returning id into v_no_street;
  insert into seo_locations (client_id, name, address_line1, city, region, country_code)
  values (v_client, 'Canada', '400 Maple Ave', 'Toronto', 'ON', 'CA') returning id into v_non_us;
  insert into seo_locations (client_id, name, address_line1, city, region, country_code)
  values (v_client, 'lowercase usa', '500 Pine St', 'Springfield', 'IL', 'usa') returning id into v_usa_text;
  insert into seo_locations (client_id, name, address_line1, city, region, country_code, is_active)
  values (v_client, 'Inactive', '600 Birch St', 'Springfield', 'IL', 'US', false) returning id into v_inactive;

  -- ---------------------------------------------------------------------------
  -- As the service role: which locations are targets.
  -- ---------------------------------------------------------------------------
  select count(*) into v_seen from seo_geocode_targets where client_id = v_client;
  assert v_seen = 2, format('targets: only the two geocodable locations should appear, saw %s', v_seen);

  select is_due into v_due from seo_geocode_targets where location_id = v_complete;
  assert v_due, 'targets: a complete address with no coordinates is due';
  select is_due into v_due from seo_geocode_targets where location_id = v_usa_text;
  assert v_due, 'targets: country_code is case-insensitive and accepts "usa"';

  select count(*) into v_seen from seo_geocode_targets where location_id = v_has_coords;
  assert v_seen = 0, 'targets: a location with coordinates is never a target';
  select count(*) into v_seen from seo_geocode_targets where location_id = v_no_region;
  assert v_seen = 0, 'targets: a missing state/region is never a target';
  select count(*) into v_seen from seo_geocode_targets where location_id = v_no_street;
  assert v_seen = 0, 'targets: a missing street is never a target';
  select count(*) into v_seen from seo_geocode_targets where location_id = v_non_us;
  assert v_seen = 0, 'targets: a non-US location is never a target';
  select count(*) into v_seen from seo_geocode_targets where location_id = v_inactive;
  assert v_seen = 0, 'targets: an inactive location is never a target';

  -- ---------------------------------------------------------------------------
  -- Rule 4: service-only.
  -- ---------------------------------------------------------------------------
  begin
    perform 1 from seo_geocode_targets limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert not v_denied, 'sanity: service role (this test) can read seo_geocode_targets';

  v_user := gen_random_uuid();
  insert into auth.users (id, email) values (v_user, 'seo-geocode-test@example.com');
  update users set client_id = v_client, role = 'admin' where id = v_user;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;
  begin
    perform 1 from seo_geocode_targets limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rule 4: authenticated must not read seo_geocode_targets';
  reset role;

  -- ---------------------------------------------------------------------------
  -- Dispatch (needs pg_net).
  -- ---------------------------------------------------------------------------
  if to_regproc('net.http_post') is not null then
    perform vault.create_secret('http://localhost/seo-geocode', 'seo_geocode_url');
    if not exists (select 1 from vault.decrypted_secrets where name = 'voice_tool_secret') then
      perform vault.create_secret('test-secret', 'voice_tool_secret');
    end if;
    v_req := request_seo_geocode(v_complete);
    assert v_req is not null, 'dispatch: a due, complete-address location is dispatched';
    v_req := request_seo_geocode(v_complete);
    assert v_req is null, 'dispatch: a second dispatch while in flight is refused';
    -- request_seo_geocode itself doesn't re-check coordinates (only the
    -- scheduling view does, by never selecting such a location) — the
    -- "never overwrites" guarantee for a direct call is the function's own
    -- UPDATE ... WHERE lat IS NULL AND lng IS NULL, which is Deno code and
    -- covered by scripts/test-seo-geocode.ts / a live function call, not here.
  else
    raise notice 'pg_net not installed — dispatch assertions skipped';
  end if;

  raise notice 'test_seo_geocoding: all assertions passed';
end;
$$;

rollback;
