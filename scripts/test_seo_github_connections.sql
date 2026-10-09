-- =============================================================================
-- test_seo_github_connections.sql — non-destructive test of 0075.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_github_connections.sql
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_loc1   uuid;
  v_loc2   uuid;
  v_loc3   uuid;
  v_conn   uuid;
  v_denied boolean;
  v_creds  jsonb;
begin
  insert into clients (name, slug, is_active) values ('GH Test', 'gh-test', true) returning id into v_client;
  insert into seo_locations (client_id, name, website_url) values (v_client, 'Site', 'https://www.gh-test.example.com') returning id into v_loc1;
  insert into seo_locations (client_id, name, website_url) values (v_client, 'Store', 'https://shop.gh-test.example.com') returning id into v_loc2;
  insert into seo_locations (client_id, name, website_url) values (v_client, 'Other', 'https://other.example.com') returning id into v_loc3;

  insert into seo_site_connections (client_id, location_id, platform, shop_domain, repo, branch)
    values (v_client, v_loc1, 'github', 'www.gh-test.example.com', 'acme/site', 'main') returning id into v_conn;
  insert into seo_site_connections (client_id, location_id, platform, shop_domain)
    values (v_client, v_loc2, 'shopify', 'gh-test.myshopify.com');

  begin
    insert into seo_site_connections (client_id, location_id, platform, shop_domain, repo)
      values (v_client, v_loc3, 'github', 'www.other.example.com', 'not a repo');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'github: repo must be owner/name';

  begin
    insert into seo_site_connections (client_id, location_id, platform, shop_domain)
      values (v_client, v_loc3, 'github', 'www.other.example.com');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'github: a repo is required';

  begin
    insert into seo_site_connections (client_id, location_id, platform, shop_domain, repo)
      values (v_client, v_loc3, 'shopify', 'x.myshopify.com', 'acme/site');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'shopify: no repo';

  begin
    insert into seo_site_connections (client_id, location_id, platform, shop_domain)
      values (v_client, v_loc3, 'shopify', 'www.other.example.com');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'shopify: still a *.myshopify.com host';

  begin
    insert into seo_site_connections (client_id, location_id, platform, shop_domain, repo)
      values (v_client, v_loc3, 'wordpress', 'www.other.example.com', null);
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'unknown platforms are refused';

  v_creds := get_seo_site_credentials(v_loc1);
  assert v_creds->>'platform' = 'github' and v_creds->>'repo' = 'acme/site' and v_creds->>'branch' = 'main', format('credentials lookup carries platform, repo, branch: %s', v_creds);
  assert get_seo_site_credentials(v_loc2)->>'platform' = 'shopify', 'shopify connections report shopify';

  raise notice 'ALL 0075 GITHUB CONNECTION TESTS PASSED';
end;
$$;

rollback;
