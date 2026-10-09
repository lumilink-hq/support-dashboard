-- =============================================================================
-- test_seo_shopify_oauth.sql — non-destructive test of 0077 (Connect Shopify):
-- seo_shopify_apps is service-role only, store_seo_shopify_token wires the
-- token to every active location of the shop's client (and never touches a
-- GitHub connection), and seo_shopify_connect_info is self-scoped.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_shopify_oauth.sql
--
-- To see it FAIL:
--   * grant select on seo_shopify_apps to authenticated;
--     create policy tmp on seo_shopify_apps for select using (true);
--     -> "rule 4: a tenant must not read seo_shopify_apps" fails.
--   * in store_seo_shopify_token drop the platform <> 'shopify' guard
--     -> "token: a GitHub connection is left alone" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_a      uuid;
  v_b      uuid;
  v_a1     uuid;
  v_a2     uuid;
  v_a3     uuid;
  v_b1     uuid;
  v_user_a uuid;
  v_n      int;
  v_seen   int;
  v_text   text;
  v_denied boolean;
begin
  insert into clients (name, slug, is_active) values ('Shopify OAuth A', 'shop-oauth-a', true) returning id into v_a;
  insert into clients (name, slug, is_active) values ('Shopify OAuth B', 'shop-oauth-b', true) returning id into v_b;
  insert into seo_locations (client_id, name) values (v_a, 'A one') returning id into v_a1;
  insert into seo_locations (client_id, name) values (v_a, 'A two') returning id into v_a2;
  insert into seo_locations (client_id, name, is_active) values (v_a, 'A closed', false) returning id into v_a3;
  insert into seo_locations (client_id, name) values (v_b, 'B one') returning id into v_b1;

  -- A2 already has a hand-made connection with a placeholder domain (PACKS, 2026-10-09).
  with c as (
    insert into seo_site_connections (client_id, location_id, shop_domain, status, last_checked_at, last_error)
    values (v_a, v_a2, 'replace-me.myshopify.com', 'error', now(), 'token exchange refused (400)')
    returning id
  ) insert into seo_site_credentials (connection_id, credentials_ref) select id, 'old-secret' from c;
  -- B1 is a GitHub site.
  insert into seo_site_connections (client_id, location_id, platform, shop_domain, repo, branch) values (v_b, v_b1, 'github', 'www.b.example', 'b-org/site', 'main');

  perform vault.create_secret('{"client_id":"cid","client_secret":"csecret"}', 'test-shop-oauth-app');
  insert into seo_shopify_apps (shop_domain, client_id, app_secret_ref) values ('shop-a.myshopify.com', v_a, 'test-shop-oauth-app');
  insert into seo_shopify_apps (shop_domain, client_id, app_secret_ref) values ('shop-b.myshopify.com', v_b, 'test-shop-oauth-app');

  begin
    insert into seo_shopify_apps (shop_domain, client_id, app_secret_ref) values ('Shop.myshopify.com', v_a, 'x');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'check: shop domain must be lowercase *.myshopify.com';

  -- The edge function's lookup.
  select get_seo_shopify_app('SHOP-A.myshopify.com')->>'credentials' into v_text;
  assert v_text like '%csecret%', 'lookup: credentials come back for a registered shop (case-insensitive)';
  assert get_seo_shopify_app('nope.myshopify.com') is null, 'lookup: unknown shop is null';

  -- Store the token.
  v_n := store_seo_shopify_token('shop-a.myshopify.com', 'shpat_test_token_123', array['write_products', 'write_content']);
  assert v_n = 2, format('token: wired to the two active locations, got %s', v_n);
  select count(*) into v_seen from seo_site_connections
   where client_id = v_a and shop_domain = 'shop-a.myshopify.com' and status = 'unchecked' and last_checked_at is null and last_error is null;
  assert v_seen = 2, 'token: both connections reset to unchecked on the real domain (the placeholder one fixed)';
  select count(*) into v_seen from seo_site_connections where location_id = v_a3;
  assert v_seen = 0, 'token: an inactive location is not connected';
  select count(*) into v_seen from seo_site_credentials sc join seo_site_connections x on x.id = sc.connection_id
   where x.client_id = v_a and sc.credentials_ref = 'shopify-token:shop-a.myshopify.com';
  assert v_seen = 2, 'token: both point at the new token secret';
  select count(*) into v_seen from vault.decrypted_secrets
   where name = 'shopify-token:shop-a.myshopify.com' and decrypted_secret::jsonb->>'access_token' = 'shpat_test_token_123';
  assert v_seen = 1, 'token: stored in Vault as {"access_token"}';
  select (get_seo_site_credentials(v_a1)->>'credentials')::jsonb->>'access_token' into v_text;
  assert v_text = 'shpat_test_token_123', 'token: the publisher''s lookup returns it';

  -- Reconnecting updates the same secret.
  perform store_seo_shopify_token('shop-a.myshopify.com', 'shpat_second_token_456', null);
  select count(*) into v_seen from vault.secrets where name = 'shopify-token:shop-a.myshopify.com';
  assert v_seen = 1, 'token: a reconnect updates, not duplicates';

  v_n := store_seo_shopify_token('shop-b.myshopify.com', 'shpat_b_token_789', null);
  assert v_n = 0, 'token: a GitHub site counts as nothing wired';
  select count(*) into v_seen from seo_site_connections where location_id = v_b1 and platform = 'github' and shop_domain = 'www.b.example';
  assert v_seen = 1, 'token: a GitHub connection is left alone';

  begin
    perform store_seo_shopify_token('unregistered.myshopify.com', 'shpat_x_token_000', null);
    v_denied := false;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'token: an unregistered shop is refused';

  -- As tenant A.
  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'shop-oauth-test@example.com');
  update users set client_id = v_a, role = 'admin' where id = v_user_a;
  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  begin
    perform 1 from seo_shopify_apps limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rule 4: a tenant must not read seo_shopify_apps';

  select count(*) into v_seen from seo_shopify_connect_info();
  assert v_seen = 1, 'info: tenant A sees its own store only';
  select shop_domain into v_text from seo_shopify_connect_info();
  assert v_text = 'shop-a.myshopify.com', 'info: and it is A''s';

  foreach v_text in array array['get_seo_shopify_app(''shop-a.myshopify.com'')', 'store_seo_shopify_token(''shop-a.myshopify.com'', ''shpat_forged_0000'', null)'] loop
    begin
      execute 'select ' || v_text;
      v_denied := false;
    exception when insufficient_privilege then v_denied := true;
    end;
    assert v_denied, format('rule 4: authenticated must not call %s', v_text);
  end loop;
  reset role;

  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  begin
    perform 1 from seo_shopify_connect_info();
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rule 4: anon must not call seo_shopify_connect_info';
  reset role;

  raise notice 'test_seo_shopify_oauth: all assertions passed';
end;
$$;

rollback;
