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
--    Then, from ll-loyalty/:  shopify app deploy
--    (ships the webhook subscriptions, App URL and redirect URL in
--    shopify.app.toml). Functions FIRST, so Shopify never hits a missing URL.
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
-- 5. Webhooks arriving:
select topic, outcome, error, received_at from loyalty_webhook_receipts order by received_at desc limit 20;
