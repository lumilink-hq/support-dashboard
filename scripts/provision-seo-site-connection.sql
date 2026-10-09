-- =============================================================================
-- provision-seo-site-connection.sql — operator runbook for connecting a client's
-- Shopify store to LumiLink for SEO publishing (module 5, migration 0055).
--
-- SUPERSEDED FOR CLIENT STORES (2026-10-09): use provision-seo-shopify-app.sql
-- (Connect Shopify, 0077). This manual path only works with a legacy shpat_
-- token, or a Dev Dashboard app owned by the STORE'S OWN Shopify organization;
-- an app LumiLink creates gets "shop_not_permitted".
--
-- This is a TEMPLATE. Replace every <placeholder>, then run it in the SQL editor
-- (or `supabase db execute`). Never paste a real token into chat, a ticket, or a
-- file that is committed.
--
-- WHY A SEPARATE APP. The voice/order token is read-only on purpose (the runbook:
-- "the bot must never be able to write"). SEO publishing needs write access, so it
-- gets its OWN custom app in the client's Shopify admin, never a widened version
-- of the order token.
--
-- 1. Create the app IN THE CLIENT'S OWN Shopify organization (their login, not
--    ours). Since 2026-01-01 Shopify no longer lets a store create legacy custom
--    apps in the admin; new apps are made in the Dev Dashboard:
--      Shopify admin > Settings > Apps > Develop apps > Build apps in Dev
--      Dashboard (or dev.shopify.com/dashboard) > Create app > "Start from Dev
--      Dashboard", name it "LumiLink SEO".
--    In the app's version settings, select the Admin API scopes:
--        write_products         (products and collections)
--        write_content          (pages and blog articles)
--    (write_online_store_pages also satisfies pages, but articles need
--    write_content.) Release the version, then Install it on the store.
--    From the app's Settings, copy the Client ID and Client secret.
--    The client credentials grant LumiLink uses only works when the app and the
--    store are in the same organization, which is why the client creates it.
--
--    A LEGACY custom app made before 2026-01-01 with those scopes also works:
--    use its permanent Admin API token (shpat_...) instead.
--
-- 2. Store the credential in Vault. Dev Dashboard app:
select vault.create_secret(
  '{"client_id":"<client id>","client_secret":"<client secret>"}',
  '<slug>-seo-shopify'
);
--    or, for a legacy app:  '{"access_token":"<shpat_...>"}'

-- 3. Connect it to the client's locations. Every location needs its own row
--    (each store's drafts publish through its own location), all pointing at
--    the same Vault secret. This connects every active location of the client
--    at once; no location ids needed. Find the slug with:
--      select slug, name from clients order by name;
with conn as (
  insert into seo_site_connections (client_id, location_id, shop_domain)
  select l.client_id, l.id, '<store>.myshopify.com'
    from seo_locations l
    join clients c on c.id = l.client_id
   where c.slug = '<slug>' and l.is_active
  on conflict (location_id) do nothing
  returning id
)
insert into seo_site_credentials (connection_id, credentials_ref)
select id, '<slug>-seo-shopify' from conn;

-- 4. The connection starts 'unchecked'. The heartbeat (seo-publish task 'check')
--    runs within the hour, reads the granted scopes and the store's primary
--    domain, and sets status to healthy or degraded. To check it right away:
--      select run_due_seo_site_jobs();
select l.name, x.shop_domain, x.status, x.granted_scopes, x.primary_domain, x.last_error
  from seo_site_connections x
  join seo_locations l on l.id = x.location_id
  join clients c on c.id = x.client_id
 where c.slug = '<slug>';
