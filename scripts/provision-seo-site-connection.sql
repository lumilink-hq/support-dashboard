-- =============================================================================
-- provision-seo-site-connection.sql — operator runbook for connecting a client's
-- Shopify store to LumiLink for SEO publishing (module 5, migration 0055).
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
-- 1. In the client's Shopify admin: Settings > Apps and sales channels > Develop
--    apps > Create an app ("LumiLink SEO"). Configure the Admin API scopes:
--        write_products         (products and collections)
--        write_content          (pages and blog articles)
--    (write_online_store_pages also satisfies pages, but articles need
--    write_content, so grant write_content.) Install the app and copy the Admin
--    API access token (shpat_...). Shopify shows it once.
--
-- 2. Store the token in Vault. The secret is JSON with an access_token key.
select vault.create_secret(
  '{"access_token":"<shpat_...>"}',
  '<slug>-seo-shopify'
);

-- 3. Connect it to the LOCATION. One row per location; several locations of one
--    store each get their own row pointing at the same Vault secret.
with conn as (
  insert into seo_site_connections (client_id, location_id, shop_domain)
  select l.client_id, l.id, '<store>.myshopify.com'
    from seo_locations l
   where l.id = '<location uuid>'
  returning id
)
insert into seo_site_credentials (connection_id, credentials_ref)
select id, '<slug>-seo-shopify' from conn;

-- 4. The connection starts 'unchecked'. The heartbeat (seo-publish task 'check')
--    runs within the hour, reads the granted scopes and the store's primary
--    domain, and sets status to healthy or degraded. To check it right away:
--      select run_due_seo_site_jobs();
select location_id, shop_domain, status, granted_scopes, primary_domain, last_error
  from seo_site_connections where location_id = '<location uuid>';
