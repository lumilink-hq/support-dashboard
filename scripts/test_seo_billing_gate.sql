-- =============================================================================
-- test_seo_billing_gate.sql — 0092: scheduled SEO work only for clients with
-- an active or past_due 'seo' entitlement, and a paying client can't add more
-- active locations than greatest(seat_count, 1).
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_billing_gate.sql
--
-- The view sweep covers EVERY seo_%_targets view, so a later migration that
-- replaces one from a pre-0092 body (dropping the gate) fails here.
--
-- To see it FAIL: remove "and seo_billing_active(l.client_id)" from
-- seo_crawl_targets -> "unpaid: seo_crawl_targets lists the client" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;


do $$
declare
  v_client uuid;
  v_loc    uuid;
  v_loc2   uuid;
  v_view   text;
  v_col    text;
  v_seen   int;
  v_failed boolean;
  v_views  text[];
begin
  -- A client with everything every targets view looks for.
  insert into clients (name, slug, is_active) values ('Gate', 'gate-test', true) returning id into v_client;
  insert into seo_locations (client_id, name, website_url, search_console_site_url, address_line1, city, region, country_code)
  values (v_client, 'Store', 'https://gate.example', 'sc-domain:gate.example', '1 Main St', 'Austin', 'TX', 'US')
  returning id into v_loc;
  insert into seo_keywords (client_id, location_id, keyword) values (v_client, v_loc, 'gate widgets');
  insert into seo_competitors (client_id, location_id, domain) values (v_client, v_loc, 'rival.example');
  insert into seo_ai_queries (client_id, query) values (v_client, 'best gate widgets');
  insert into seo_findings (client_id, location_id, module, finding_type, title, status, target_url, severity)
  values (v_client, v_loc, 'crawl', 'missing_title', 'Missing title', 'open', 'https://gate.example/', 'warning');
  insert into seo_crawl_runs (client_id, location_id, site_host, root_url, page_limit, phase, finished_at)
  values (v_client, v_loc, 'gate.example', 'https://gate.example/', 100, 'done', now());
  insert into seo_actions (client_id, location_id, action_type, target_field, idempotency_key, status, proposed_value, finding_type, target_url)
  values (v_client, v_loc, 'page_meta', 'title', 'gate:publish', 'approved', '{}', 'missing_title', 'https://gate.example/about');
  insert into seo_site_connections (client_id, location_id, shop_domain)
  values (v_client, v_loc, 'gate.myshopify.com');

  select array_agg(c.relname order by c.relname) into v_views
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v' and c.relname like 'seo\_%\_targets';
  assert array_length(v_views, 1) >= 17, format('expected every targets view, found %s', array_length(v_views, 1));

  -- Paid: every view lists the client (proves the fixture is complete, so the
  -- unpaid check below means something).
  insert into entitlements (client_id, feature, status, seat_count) values (v_client, 'seo', 'active', 1);
  foreach v_view in array v_views loop
    execute format('select count(*) from %I where client_id = $1', v_view) into v_seen using v_client;
    assert v_seen > 0, format('paid: %s should list the client', v_view);
  end loop;

  -- past_due still works (Stripe is retrying the card).
  update entitlements set status = 'past_due' where client_id = v_client and feature = 'seo';
  select count(*) into v_seen from seo_crawl_targets where client_id = v_client;
  assert v_seen = 1, 'past_due: still crawled';

  -- pending / canceled / none: no view lists the client.
  foreach v_col in array array['pending', 'canceled', 'none'] loop
    if v_col = 'none' then
      delete from entitlements where client_id = v_client;
    else
      update entitlements set status = v_col where client_id = v_client and feature = 'seo';
    end if;
    foreach v_view in array v_views loop
      -- A rollback is allowed after cancelling; there is none queued here.
      execute format('select count(*) from %I where client_id = $1', v_view) into v_seen using v_client;
      assert v_seen = 0, format('unpaid (%s): %s lists the client', v_col, v_view);
    end loop;
  end loop;

  -- Another product's entitlement doesn't count.
  insert into entitlements (client_id, feature, status) values (v_client, 'voice', 'active');
  select count(*) into v_seen from seo_crawl_targets where client_id = v_client;
  assert v_seen = 0, 'a voice entitlement doesn''t pay for SEO';

  -- Unpaid, a rollback of something we published is still carried out.
  update seo_actions set status = 'rollback_requested' where idempotency_key = 'gate:publish';
  select count(*) into v_seen from seo_site_job_targets where client_id = v_client and task = 'publish';
  assert v_seen = 1, 'unpaid: a rollback still runs';

  -- ---------------------------------------------------------------------------
  -- Location cap
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);

  -- Not paid yet (onboarding): no cap.
  insert into seo_locations (client_id, name) values (v_client, 'Second') returning id into v_loc2;
  update seo_locations set is_active = false where id = v_loc2;

  -- Paid for 1: a second active location is refused, by insert or re-activation.
  insert into entitlements (client_id, feature, status, seat_count) values (v_client, 'seo', 'active', 1);
  v_failed := false;
  begin
    insert into seo_locations (client_id, name) values (v_client, 'Third');
  exception when others then
    v_failed := sqlerrm = 'seo_location_limit';
  end;
  assert v_failed, 'paid for 1: a second location is refused';
  v_failed := false;
  begin
    update seo_locations set is_active = true where id = v_loc2;
  exception when others then
    v_failed := sqlerrm = 'seo_location_limit';
  end;
  assert v_failed, 'paid for 1: re-activating a second location is refused';

  -- Inactive rows and edits to the existing one are fine.
  insert into seo_locations (client_id, name, is_active) values (v_client, 'Parked', false);
  update seo_locations set name = 'Store renamed' where id = v_loc;

  -- Website plan (seat_count 0) still gets its one website row.
  update entitlements set seat_count = 0 where client_id = v_client and feature = 'seo';
  v_failed := false;
  begin
    insert into seo_locations (client_id, name) values (v_client, 'Fourth');
  exception when others then
    v_failed := sqlerrm = 'seo_location_limit';
  end;
  assert v_failed, 'website plan: one location only';
  delete from seo_locations where id = v_loc;
  insert into seo_locations (client_id, name) values (v_client, 'Website') returning id into v_loc;

  -- Paid for 2: room for exactly one more.
  update entitlements set seat_count = 2 where client_id = v_client and feature = 'seo';
  update seo_locations set is_active = true where id = v_loc2;
  v_failed := false;
  begin
    insert into seo_locations (client_id, name) values (v_client, 'Fifth');
  exception when others then
    v_failed := sqlerrm = 'seo_location_limit';
  end;
  assert v_failed, 'paid for 2: a third is refused';

  -- A hand grant with no seat count is not capped.
  update entitlements set seat_count = null where client_id = v_client and feature = 'seo';
  insert into seo_locations (client_id, name) values (v_client, 'Hand grant');

  -- Operators (no signed-in user) are not capped.
  update entitlements set seat_count = 1 where client_id = v_client and feature = 'seo';
  perform set_config('request.jwt.claim.sub', '', true);
  insert into seo_locations (client_id, name) values (v_client, 'Operator');

  raise notice 'test_seo_billing_gate: all assertions passed';
end
$$;

rollback;
