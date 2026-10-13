-- =============================================================================
-- provision-loyalty-shopify-app.sql — operator runbook: connect a store to
-- LL Loyalty (0201). Once per store, after scripts/setup-loyalty-program.sql.
--
-- This is a TEMPLATE: replace every <placeholder>. Never paste a real secret
-- into chat, a ticket, or a committed file.
--
-- 0. Edge functions deployed (all --no-verify-jwt; see CLAUDE.md):
--      supabase functions deploy loyalty-webhooks --no-verify-jwt
--      supabase functions deploy loyalty-oauth --no-verify-jwt
--      supabase functions deploy loyalty-backfill --no-verify-jwt
--      supabase functions deploy loyalty-shopify --no-verify-jwt
--      supabase functions deploy loyalty-proxy --no-verify-jwt
--    Then, from ll-loyalty/:  npm run build:blocks && shopify app deploy
--    (ships the webhook subscriptions, App URL, redirect URL and app proxy in
--    shopify.app.toml, and the Wave Rewards theme block). Functions FIRST, so
--    Shopify never hits a missing URL.
-- 1. The app's Client ID and Client secret (Dev Dashboard > LL Loyalty >
--    Settings) into Vault. The secret also verifies every webhook.
select vault.create_secret(
  '{"client_id":"<client id>","client_secret":"<client secret>"}',
  'll-loyalty-app:<store>'
);
-- 2. Register the store against its program. Lowercase domain.
insert into loyalty_shopify_apps (shop_domain, app_client_id, program_id, app_secret_ref)
select p.shop_domain, '<client id>', p.id, 'll-loyalty-app:<store>'
  from loyalty_programs p where p.shop_domain = '<store>.myshopify.com'
on conflict (shop_domain, app_client_id) do update
   set program_id = excluded.program_id, app_secret_ref = excluded.app_secret_ref;
-- 3. Install: open the app's install link (Dev Dashboard > Distribution), or
--    https://xqsxjxrzpxhosedkmufg.supabase.co/functions/v1/loyalty-oauth?shop=<store>.myshopify.com
--    It ends on "LL Loyalty is connected". That starts the live period:
select shop_domain, connected_at, last_error from loyalty_shopify_apps where shop_domain = '<store>.myshopify.com';
select live_since from loyalty_programs where shop_domain = '<store>.myshopify.com';
-- 4. Backfill (once per project, the URL secret; voice_tool_secret already exists):
select vault.create_secret('https://xqsxjxrzpxhosedkmufg.functions.supabase.co/loyalty-backfill', 'loyalty_backfill_url', '');
--    Then start it; pg_cron runs a slice every minute until done:
select start_loyalty_backfill(id) from loyalty_programs where shop_domain = '<store>.myshopify.com';
select * from loyalty_backfills;
-- 5. Shopify sync (codes, perks, member tier tags + metafields). Once per project:
select vault.create_secret('https://xqsxjxrzpxhosedkmufg.functions.supabase.co/loyalty-shopify', 'loyalty_shopify_url', '');
--    pg_cron calls it every minute for programs with work. Check:
select key, shopify_discount_id, last_error from loyalty_perks;
select status, count(*) from loyalty_discount_codes group by 1;
select count(*) filter (where shopify_sync_error is not null) errors,
       count(*) filter (where tier_key is distinct from shopify_synced_tier
                           or points_balance is distinct from shopify_synced_points) due
  from loyalty_members;
-- 6. Storefront: Online Store > Themes > Customize > the Wave Rewards page >
--    Add block > Apps > "Wave Rewards page". Set the Instagram link. Check
--    https://<store>/apps/loyalty/state returns JSON (proxy wired).
-- 7. Webhooks arriving:
select topic, outcome, error, received_at from loyalty_webhook_receipts order by received_at desc limit 20;
