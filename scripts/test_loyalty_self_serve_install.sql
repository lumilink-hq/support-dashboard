-- =============================================================================
-- test_loyalty_self_serve_install.sql — non-destructive test of 0222 (Phase 2
-- P1): loyalty_install on registered and unregistered stores, the default
-- program, app/uninstalled pausing, reinstall resuming.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_self_serve_install.sql
--
-- To see it FAIL:
--   * drop the "and self_serve" filter in loyalty_install
--     -> "unregistered store on a custom app is refused" fails.
--   * drop "and paused_by_uninstall" from the reinstall update
--     -> "a program staff switched off stays off" fails.
--   * drop the "token_ref is not null" check in loyalty_mark_uninstalled
--     -> "uninstalling one of two apps keeps the program on" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client  uuid;
  v_staff   uuid;
  v_r       jsonb;
  v_prog    uuid;
  v_p       loyalty_programs%rowtype;
  v_n       int;
  v_ok      boolean;
  v_err     text;
begin
  -- Apps: a custom one (like Tsunami's) and a self-serve one.
  perform vault.create_secret('{"client_id":"custom-app-1","client_secret":"s1"}', 'test-ll-custom');
  perform vault.create_secret('{"client_id":"selfserve-app-1","client_secret":"s2"}', 'test-ll-self');
  insert into loyalty_apps (app_client_id, label, distribution, self_serve, app_secret_ref, scopes) values
    ('custom-app-1',    'LL Loyalty (test custom)', 'custom', false, 'test-ll-custom', 'read_orders'),
    ('selfserve-app-1', 'LL Loyalty (test self)',   'custom', true,  'test-ll-self',   'read_orders,write_customers');

  -- 1. A staff-provisioned store installs as before.
  insert into clients (name, slug) values ('Staff Store', 'test-staff-store') returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name) values (v_client, 'staff-store.myshopify.com', 'Staff Rewards')
  returning id into v_staff;
  insert into loyalty_shopify_apps (shop_domain, app_client_id, program_id, app_secret_ref)
  values ('staff-store.myshopify.com', 'custom-app-1', v_staff, 'test-ll-custom');
  v_r := loyalty_install('staff-store.myshopify.com', 'custom-app-1', 'shpat_staff_000000', array['read_orders']);
  if (v_r->>'program_id')::uuid <> v_staff or (v_r->>'created')::boolean or v_r->>'created_via' <> 'staff' then
    raise exception 'FAIL registered store: %', v_r;
  end if;
  if exists (select 1 from loyalty_backfills where program_id = v_staff) then
    raise exception 'FAIL registered store: backfill started by itself (staff start it)';
  end if;
  raise notice 'ok  registered store installs, no new program, no auto backfill';

  -- 2. Unknown store on the custom app: refused, nothing created.
  begin
    perform loyalty_install('stranger.myshopify.com', 'custom-app-1', 'shpat_x_0000000000', array['read_orders']);
    v_ok := false;
  exception when others then
    v_ok := true; v_err := sqlerrm;
  end;
  if not v_ok or exists (select 1 from loyalty_programs where shop_domain = 'stranger.myshopify.com') then
    raise exception 'FAIL unregistered store on a custom app is refused';
  end if;
  raise notice 'ok  unregistered store on a custom app is refused (%)', v_err;

  -- 3. Unknown store on the self-serve app: everything is created.
  v_r := loyalty_install('new-shop.myshopify.com', 'selfserve-app-1', 'shpat_new_00000000', array['read_orders', 'write_customers'],
                         'New Shop Co', 'America/New_York');
  v_prog := (v_r->>'program_id')::uuid;
  if not (v_r->>'created')::boolean or v_r->>'created_via' <> 'self_serve' then
    raise exception 'FAIL self-serve install: %', v_r;
  end if;
  select * into v_p from loyalty_programs where id = v_prog;
  if v_p.name <> 'New Shop Co Rewards' or v_p.timezone <> 'America/New_York' or not v_p.enroll_guests
     or v_p.live_since is null or not v_p.is_active or v_p.points_per_dollar <> 1 or v_p.discount_code_prefix <> 'LL-' then
    raise exception 'FAIL default program: %', row_to_json(v_p);
  end if;
  if (select name from clients where id = v_p.client_id) <> 'New Shop Co'
     or (select slug from clients where id = v_p.client_id) <> 'loyalty-new-shop' then
    raise exception 'FAIL workspace for the store';
  end if;
  if (select count(*) from loyalty_tiers where program_id = v_prog) <> 3
     or (select count(*) from loyalty_earn_rules where program_id = v_prog) <> 5
     or (select points_cost from loyalty_rewards where program_id = v_prog and key = 'five_off') <> 200
     or (select count(*) from loyalty_badges where program_id = v_prog) = 0 then
    raise exception 'FAIL default config';
  end if;
  if (select status from loyalty_backfills where program_id = v_prog) <> 'pending' then
    raise exception 'FAIL backfill not started';
  end if;
  if (select (decrypted_secret::jsonb)->>'access_token' from vault.decrypted_secrets
       where name = (select token_ref from loyalty_shopify_apps where shop_domain = 'new-shop.myshopify.com')) <> 'shpat_new_00000000' then
    raise exception 'FAIL token not stored';
  end if;
  if (select scopes from loyalty_shopify_apps where shop_domain = 'new-shop.myshopify.com') <> 'read_orders,write_customers' then
    raise exception 'FAIL scopes not recorded';
  end if;
  raise notice 'ok  self-serve install creates workspace, program, config, token, backfill';

  -- 4. Same install again (Shopify re-opens the flow): no second program.
  v_r := loyalty_install('new-shop.myshopify.com', 'selfserve-app-1', 'shpat_new_11111111', array['read_orders']);
  if (v_r->>'created')::boolean or (v_r->>'program_id')::uuid <> v_prog
     or (select count(*) from loyalty_programs where shop_domain = 'new-shop.myshopify.com') <> 1 then
    raise exception 'FAIL repeat install: %', v_r;
  end if;
  raise notice 'ok  repeat install reuses the program';

  -- 5. Bad time zone and slug collision.
  insert into clients (name, slug) values ('Taken', 'loyalty-tz-shop');
  v_r := loyalty_install('tz-shop.myshopify.com', 'selfserve-app-1', 'shpat_tz_000000000', array['read_orders'], null, 'Mars/Olympus');
  select * into v_p from loyalty_programs where id = (v_r->>'program_id')::uuid;
  if v_p.timezone <> 'UTC' or v_p.name <> 'tz-shop Rewards'
     or (select slug from clients where id = v_p.client_id) <> 'loyalty-tz-shop-2' then
    raise exception 'FAIL fallbacks: % %', v_p.timezone, v_p.name;
  end if;
  raise notice 'ok  unknown time zone -> UTC, no shop name -> subdomain, slug collision -> -2';

  -- 6. Uninstall pauses, reinstall resumes.
  v_ok := loyalty_mark_uninstalled('new-shop.myshopify.com', 'selfserve-app-1');
  select * into v_p from loyalty_programs where id = v_prog;
  if not v_ok or v_p.is_active or not v_p.paused_by_uninstall then
    raise exception 'FAIL uninstall did not pause';
  end if;
  if exists (select 1 from vault.secrets where name = 'loyalty-shopify-token:new-shop.myshopify.com:selfserve-app-1')
     or (select token_ref from loyalty_shopify_apps where shop_domain = 'new-shop.myshopify.com') is not null
     or (select uninstalled_at from loyalty_shopify_apps where shop_domain = 'new-shop.myshopify.com') is null then
    raise exception 'FAIL uninstall left the token';
  end if;
  if jsonb_array_length(get_loyalty_shopify_apps('new-shop.myshopify.com')) <> 1 then
    raise exception 'FAIL uninstall removed the app row (shop/redact still needs its secret)';
  end if;
  v_r := loyalty_install('new-shop.myshopify.com', 'selfserve-app-1', 'shpat_new_22222222', array['read_orders']);
  select * into v_p from loyalty_programs where id = v_prog;
  if not v_p.is_active or v_p.paused_by_uninstall
     or (select uninstalled_at from loyalty_shopify_apps where shop_domain = 'new-shop.myshopify.com') is not null then
    raise exception 'FAIL reinstall did not resume';
  end if;
  raise notice 'ok  uninstall pauses + drops token, reinstall resumes';

  -- 7. A program staff switched off stays off through uninstall + reinstall.
  update loyalty_programs set is_active = false where id = v_staff;
  v_ok := loyalty_mark_uninstalled('staff-store.myshopify.com', 'custom-app-1');
  perform loyalty_install('staff-store.myshopify.com', 'custom-app-1', 'shpat_staff_111111', array['read_orders']);
  if (select is_active from loyalty_programs where id = v_staff) then
    raise exception 'FAIL a program staff switched off stays off';
  end if;
  raise notice 'ok  a program staff switched off stays off';

  -- 8. Two apps on one store: uninstalling one keeps the program on.
  update loyalty_programs set is_active = true where id = v_staff;
  insert into loyalty_shopify_apps (shop_domain, app_client_id, program_id, app_secret_ref)
  values ('staff-store.myshopify.com', 'selfserve-app-1', v_staff, 'test-ll-self');
  perform loyalty_install('staff-store.myshopify.com', 'selfserve-app-1', 'shpat_staff_222222', array['read_orders']);
  v_ok := loyalty_mark_uninstalled('staff-store.myshopify.com', 'custom-app-1');
  if v_ok or not (select is_active from loyalty_programs where id = v_staff) then
    raise exception 'FAIL uninstalling one of two apps keeps the program on';
  end if;
  raise notice 'ok  uninstalling one of two apps keeps the program on';

  -- 9. Unknown store/app uninstall is a no-op.
  if loyalty_mark_uninstalled('nobody.myshopify.com', 'selfserve-app-1') then
    raise exception 'FAIL unknown uninstall';
  end if;

  -- 10. Self-serve credentials list.
  v_r := get_loyalty_self_serve_apps();
  select count(*) into v_n from jsonb_array_elements(v_r) e where e->>'app_client_id' = 'custom-app-1';
  if v_n <> 0 or not exists (select 1 from jsonb_array_elements(v_r) e
                              where e->>'app_client_id' = 'selfserve-app-1' and e->>'credentials' like '%"s2"%') then
    raise exception 'FAIL self-serve app list: %', v_r;
  end if;
  raise notice 'ok  self-serve app list has only self-serve apps, with credentials';

  -- 11. Not callable by signed-in users or anon.
  if has_function_privilege('authenticated', 'loyalty_install(text, text, text, text[], text, text)', 'execute')
     or has_function_privilege('anon', 'get_loyalty_self_serve_apps()', 'execute')
     or has_function_privilege('authenticated', 'loyalty_mark_uninstalled(text, text)', 'execute')
     or has_table_privilege('authenticated', 'loyalty_apps', 'select') then
    raise exception 'FAIL privileges';
  end if;
  raise notice 'ok  service role only';
end $$;

rollback;
