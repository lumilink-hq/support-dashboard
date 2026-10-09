-- =============================================================================
-- test_seo_gbp_sync.sql — non-destructive test of 0076 (module 3): the three
-- new tables are tenant read-only and scoped to the tenant (rule 4), the
-- scheduling view is closed to tenants, link_seo_gbp_location keeps links
-- one-to-one and inside the caller's own client, and "Run now" knows the job.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_gbp_sync.sql
--
-- To see it FAIL:
--   * drop policy seo_gbp_reviews_tenant_select on seo_gbp_reviews;
--     create policy tmp_all on seo_gbp_reviews for select using (true);
--     -> "rule 4: seo_gbp_reviews leaked other tenants" fails.
--   * grant update on seo_gbp_locations to authenticated;
--     create policy tmp_u on seo_gbp_locations for update using (true);
--     -> "rule 4: a tenant must not update seo_gbp_locations directly" fails.
--   * in link_seo_gbp_location, drop the "and client_id = v_client" from the
--     seo_locations existence check
--     -> "link: another tenant's location is refused" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client_a uuid;
  v_client_b uuid;
  v_loc_a1   uuid;
  v_loc_a2   uuid;
  v_loc_b1   uuid;
  v_user_a   uuid;
  v_seen     int;
  v_denied   boolean;
  v_text     text;
  v_req      bigint;
  t          text;
begin
  insert into clients (name, slug, is_active) values ('GBP Test A', 'gbp-test-a', true) returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('GBP Test B', 'gbp-test-b', true) returning id into v_client_b;

  insert into seo_locations (client_id, name) values (v_client_a, 'A one') returning id into v_loc_a1;
  insert into seo_locations (client_id, name) values (v_client_a, 'A two') returning id into v_loc_a2;
  insert into seo_locations (client_id, name) values (v_client_b, 'B one') returning id into v_loc_b1;

  insert into seo_gbp_sync (client_id, status, locations_count) values (v_client_a, 'ok', 2), (v_client_b, 'ok', 1);
  insert into seo_gbp_locations (client_id, location_name, account_name, title, place_id, linked_location_id, link_source, metrics_through, metrics_backfilled_at) values
    (v_client_a, 'locations/1', 'accounts/9', 'A profile one', 'place-1', v_loc_a1, 'auto', '2026-10-01', now()),
    (v_client_a, 'locations/2', 'accounts/9', 'A profile two', 'place-2', null, null, null, null),
    (v_client_b, 'locations/3', 'accounts/8', 'B profile', null, v_loc_b1, 'auto', null, null);
  insert into seo_gbp_reviews (client_id, location_name, review_id, location_id, star_rating, comment) values
    (v_client_a, 'locations/1', 'r1', v_loc_a1, 5, 'great'),
    (v_client_b, 'locations/3', 'r2', v_loc_b1, 1, 'bad');

  -- Constraints.
  begin
    insert into seo_gbp_locations (client_id, location_name, account_name) values (v_client_a, 'accounts/9/locations/5', 'accounts/9');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'check: location_name must be locations/<id>';
  begin
    insert into seo_gbp_reviews (client_id, location_name, review_id, star_rating) values (v_client_a, 'locations/1', 'r9', 6);
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'check: star rating 1-5';
  begin
    update seo_gbp_locations set linked_location_id = v_loc_a1 where client_id = v_client_a and location_name = 'locations/2';
    v_denied := false;
  exception when unique_violation then v_denied := true;
  end;
  assert v_denied, 'unique: one profile per location';

  -- ---------------------------------------------------------------------------
  -- Scheduling, as the service role
  -- ---------------------------------------------------------------------------
  select count(*) into v_seen from seo_gbp_sync_targets where client_id = v_client_a;
  assert v_seen = 1, format('schedule: one target per client, saw %s', v_seen);
  select count(*) into v_seen from seo_gbp_sync_targets where client_id = v_client_b and is_due;
  assert v_seen = 1, 'schedule: never run means due';
  update seo_locations set is_active = false where client_id = v_client_b;
  select count(*) into v_seen from seo_gbp_sync_targets where client_id = v_client_b;
  assert v_seen = 0, 'schedule: no active location, not a target';
  update seo_locations set is_active = true where client_id = v_client_b;

  if to_regproc('net.http_post') is not null then
    perform vault.create_secret('http://localhost/seo-gbp-sync', 'seo_gbp_sync_url');
    if not exists (select 1 from vault.decrypted_secrets where name = 'voice_tool_secret') then
      perform vault.create_secret('test-secret', 'voice_tool_secret');
    end if;
    v_req := request_seo_gbp_sync(v_client_b);
    assert v_req is not null, 'schedule: a due client is dispatched';
    v_req := request_seo_gbp_sync(v_client_b);
    assert v_req is null, 'schedule: a second dispatch while in flight is refused';
  else
    raise notice 'pg_net not installed — dispatch assertions skipped';
  end if;

  select count(*) into v_seen from seo_run_now_jobs() where job_type = 'seo_gbp_sync' and scope = 'client';
  assert v_seen = 1, 'run now: seo_gbp_sync is on the allowlist';
  select count(*) into v_seen from seo_run_now_jobs();
  assert v_seen = 11, format('run now: 0073''s ten jobs kept, saw %s', v_seen);

  -- ---------------------------------------------------------------------------
  -- As tenant A
  -- ---------------------------------------------------------------------------
  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'seo-gbp-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  foreach t in array array['seo_gbp_sync', 'seo_gbp_locations', 'seo_gbp_reviews'] loop
    execute format('select count(*) from %I where client_id <> %L', t, v_client_a) into v_seen;
    assert v_seen = 0, format('rule 4: %s leaked other tenants — saw %s foreign rows', t, v_seen);
    execute format('select count(*) from %I', t) into v_seen;
    assert v_seen > 0, format('rls: %s should show tenant A its own rows', t);
  end loop;

  begin
    update seo_gbp_locations set linked_location_id = v_loc_a2 where location_name = 'locations/2';
    get diagnostics v_seen = row_count;
    v_denied := v_seen = 0;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'rule 4: a tenant must not update seo_gbp_locations directly';

  begin
    insert into seo_gbp_reviews (client_id, location_name, review_id) values (v_client_a, 'locations/1', 'forged');
    v_denied := false;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'rule 4: a tenant must not write reviews';

  begin
    perform 1 from seo_gbp_sync_targets limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rule 4: authenticated must not read seo_gbp_sync_targets';

  -- Linking through the RPC.
  v_text := link_seo_gbp_location('locations/3', v_loc_a2);
  assert v_text = 'not_found', format('link: another tenant''s profile is refused, got %s', v_text);
  v_text := link_seo_gbp_location('locations/2', v_loc_b1);
  assert v_text = 'location_not_found', format('link: another tenant''s location is refused, got %s', v_text);

  v_text := link_seo_gbp_location('locations/2', v_loc_a2);
  assert v_text = 'ok', format('link: own profile to own location, got %s', v_text);
  select count(*) into v_seen from seo_gbp_locations where location_name = 'locations/2' and linked_location_id = v_loc_a2 and link_source = 'manual';
  assert v_seen = 1, 'link: recorded as manual';
  select count(*) into v_seen from seo_locations where id = v_loc_a2 and gbp_location_name = 'locations/2' and google_place_id = 'place-2';
  assert v_seen = 1, 'link: mirrored onto seo_locations';

  -- Moving profile 2 onto location 1 takes it from profile 1 (one-to-one).
  v_text := link_seo_gbp_location('locations/2', v_loc_a1);
  assert v_text = 'ok', 'link: move';
  select count(*) into v_seen from seo_gbp_locations where location_name = 'locations/1' and linked_location_id is null;
  assert v_seen = 1, 'link: the previous holder of the location lets go';
  select count(*) into v_seen from seo_locations where id = v_loc_a2 and gbp_location_name is null;
  assert v_seen = 1, 'link: the location the profile left forgets it';
  select count(*) into v_seen from seo_gbp_locations where location_name = 'locations/2' and metrics_through is null and reviews_status = 'pending';
  assert v_seen = 1, 'link: a new link resets the sync state for its own backfill';

  v_text := link_seo_gbp_location('locations/1', v_loc_a1);
  assert v_text = 'ok', 'link: relink profile 1';
  select count(*) into v_seen from seo_gbp_reviews where location_name = 'locations/1' and location_id = v_loc_a1;
  assert v_seen = 1, 'link: reviews follow the profile''s location';

  v_text := link_seo_gbp_location('locations/1', null);
  assert v_text = 'ok', 'link: unlink';
  select count(*) into v_seen from seo_locations where id = v_loc_a1 and gbp_location_name is null;
  assert v_seen = 1, 'link: unlink clears the location';

  reset role;

  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  begin
    perform 1 from seo_gbp_reviews limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rule 4: anon must not read seo_gbp_reviews';
  begin
    perform link_seo_gbp_location('locations/1', null);
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rule 4: anon must not call link_seo_gbp_location';
  reset role;

  raise notice 'test_seo_gbp_sync: all assertions passed';
end;
$$;

rollback;
