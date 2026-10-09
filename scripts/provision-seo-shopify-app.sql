-- =============================================================================
-- provision-seo-shopify-app.sql — operator runbook for Connect Shopify (0077).
-- Once per client store. After this the client (or anyone who can install apps
-- on the store) clicks Connect Shopify under /seo > Settings, approves in
-- Shopify, and the store's long-lived token is stored and wired to every
-- location automatically. Nobody copies a token.
--
-- This is a TEMPLATE: replace every <placeholder>. Never paste a real secret
-- into chat, a ticket, or a committed file.
--
-- WHY ONE APP PER STORE. Shopify's custom distribution (no App Store review)
-- allows one store per app. The client credentials grant (an app's client id +
-- secret exchanged directly) only works for stores in the app's own Shopify
-- organization, which a client's live store never is: Shopify answers
-- "shop_not_permitted" (PACKS, 2026-10-09).
--
-- 1. In LumiLink's Shopify Dev Dashboard (dev.shopify.com/dashboard): Create
--    app > "Start from Dev Dashboard", name it "LumiLink SEO - <client>".
--    (An app already created for this store can be reused instead.)
--    In its version settings:
--      App URL:          https://xqsxjxrzpxhosedkmufg.supabase.co/functions/v1/shopify-oauth
--      Embed in admin:   off
--      Redirect URL:     https://xqsxjxrzpxhosedkmufg.supabase.co/functions/v1/shopify-oauth/callback
--      Admin API scopes: write_products, write_content
--    Release the version.
-- 2. Distribution > Custom distribution > the store's *.myshopify.com domain.
--    (This choice can't be changed later.) Shopify then shows an install link;
--    it isn't needed if the client uses the Connect Shopify button, but works too.
-- 3. From the app's Settings, copy the Client ID and Client secret into Vault:
select vault.create_secret(
  '{"client_id":"<client id>","client_secret":"<client secret>"}',
  '<slug>-shopify-app'
);
--    (Reusing a secret that already holds that JSON, e.g. packs-seo-shopify, is
--    fine: put its name in step 4 instead.)
-- 4. Register the store for the client. The domain must be lowercase.
insert into seo_shopify_apps (shop_domain, client_id, app_secret_ref)
select '<store>.myshopify.com', c.id, '<slug>-shopify-app'
  from clients c where c.slug = '<slug>'
on conflict (shop_domain) do update
  set client_id = excluded.client_id, app_secret_ref = excluded.app_secret_ref;

-- 5. The client clicks Connect Shopify in /seo > Settings (or opens the install
--    link) and approves. Then check:
select shop_domain, connected_at, last_error from seo_shopify_apps where shop_domain = '<store>.myshopify.com';
select l.name, x.status, x.granted_scopes, x.primary_domain, x.last_error
  from seo_site_connections x
  join seo_locations l on l.id = x.location_id
  join clients c on c.id = x.client_id
 where c.slug = '<slug>';
-- Every location: healthy, write_products + write_content, the store's public domain.
