-- =============================================================================
-- billing_price_map_stripe.sql — point Stripe prices at the feature they unlock.
--
-- Run against the project AFTER creating the prices in Stripe. Idempotent:
-- (processor, external_price_id) is unique, so re-running only refreshes the
-- display fields.
--
-- Only the RECURRING prices belong here; webhooks report
-- subscription.items.data[0].price.id, and that is the only id resolveFeature()
-- looks up.
--
-- LIVE mode (export 2026-07-30)
--   Plan     Recurring (mapped)                One-time setup (NOT mapped)
--   Starter  price_1Tyltq2LgljE9Ppsatk8ckzq    price_1Tyltq2LgljE9PpsOMSVu17H  $299
--   Growth   price_1Tylts2LgljE9PpsDREEo9Eo    price_1Tylvi2LgljE9PpsT4Vk1KEw  $499
--   Scale    price_1Tyltt2LgljE9PpsUjcnX3Kf    price_1TylwR2LgljE9PpsweJb8JPP  $799
--
-- TEST mode (export 2026-07-29)
--   Starter  price_1TyfDd2MNeuPGOWj7Znc0uTG    price_1TyfP12MNeuPGOWjN8VJqGHC  $299
--   Growth   price_1TyfEK2MNeuPGOWjRH06POrk    (none)
--   Scale    price_1TyfEr2MNeuPGOWj1nSO90Dz    (none)
--
-- Amounts match the CFO workbook v2.0 ($179/$279/$449 monthly, $299/$499/$799
-- setup). Change a price in Stripe and you must change it here AND in
-- lib/entitlements.ts, or the marketing page and the invoice will disagree.
--
-- ---------------------------------------------------------------------------
-- THE PRICE-LEVEL `feature` METADATA IN STRIPE DOES NOTHING.
-- ---------------------------------------------------------------------------
-- The test-mode export shows `feature: voice` set on the Starter prices. That
-- metadata lives on the PRICE object, and collectMetadata() in
-- billing-webhook/lib.ts reads metadata from the Checkout Session, the
-- Subscription, and invoice.subscription_details — never from the price. Price
-- metadata is not copied onto any of them.
--
-- It is harmless, and these map rows make it redundant for the subscription and
-- invoice events. But it does NOT rescue checkout.session.completed, which
-- carries no price at all. For that, the metadata has to be on the PAYMENT LINK
-- itself. See docs/STRIPE-GO-LIVE.md §1.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Recurring plan prices.
--
-- All three map to feature 'voice'. That is correct but worth understanding:
-- 0008's map is FEATURE-level, not tier-level, because the tier schema is
-- deliberately deferred (docs/landing-page-plan.md §5). So a Growth purchase
-- grants the same 'voice' entitlement as Starter, and provision-feature applies
-- the ENTRY allowance of 100 minutes regardless.
--
-- => Anyone who self-serve buys Growth or Scale lands on Starter's minutes
--    until an operator raises their cap by hand. That is fine while Growth and
--    Scale are sales-assisted ("Talk to us" on the pricing page, manual grant).
--    DO NOT publish a Payment Link for Growth or Scale without either building
--    the tier layer or accepting that manual step as part of the sale.
-- ---------------------------------------------------------------------------
insert into billing_price_map
  (processor, external_price_id, feature, display_amount, display_currency, display_interval, is_active)
values
  -- LIVE mode
  ('stripe', 'price_1Tyltq2LgljE9Ppsatk8ckzq', 'voice', 179.00, 'usd', 'month', true),  -- Starter
  ('stripe', 'price_1Tylts2LgljE9PpsDREEo9Eo', 'voice', 279.00, 'usd', 'month', true),  -- Growth
  ('stripe', 'price_1Tyltt2LgljE9PpsUjcnX3Kf', 'voice', 449.00, 'usd', 'month', true),  -- Scale
  -- TEST mode. Different objects with different ids, so both sets must be
  -- present: a test purchase sends test ids, and matching them against the live
  -- rows resolves no feature and parks the payment as 'unmapped'.
  ('stripe', 'price_1TyfDd2MNeuPGOWj7Znc0uTG', 'voice', 179.00, 'usd', 'month', true),  -- Starter (test)
  ('stripe', 'price_1TyfEK2MNeuPGOWjRH06POrk', 'voice', 279.00, 'usd', 'month', true),  -- Growth  (test)
  ('stripe', 'price_1TyfEr2MNeuPGOWj1nSO90Dz', 'voice', 449.00, 'usd', 'month', true)   -- Scale   (test)
on conflict (processor, external_price_id) do update
  set feature          = excluded.feature,
      display_amount   = excluded.display_amount,
      display_currency = excluded.display_currency,
      display_interval = excluded.display_interval,
      is_active        = excluded.is_active;

-- ---------------------------------------------------------------------------
-- The setup-fee prices need NO rows here, and adding them would be wrong.
--
-- A one-time line item on a subscription Payment Link is billed on the first
-- invoice; it never becomes a subscription item. So a setup price id never
-- appears at subscription.items.data[0].price.id, which is the only place
-- resolveFeature reads. Mapping one would create a price that can grant an
-- entitlement on its own — exactly the "one-off payment starts a recurring
-- plan" case parseStripeEvent already refuses at the event level.
--
-- Note the Stripe export lists the setup prices with a blank Interval and the
-- recurring ones as month/1. That column is how you tell them apart; the ids
-- themselves give nothing away, and Starter's two prices differ by four
-- characters in the middle of the string.
-- ---------------------------------------------------------------------------

-- Verify:
--   select processor, external_price_id, feature, display_amount, is_active
--     from billing_price_map order by display_amount;
--
-- Every external_price_id must start with 'price_'. This catches the prod_ mixup:
--   select count(*) as bad_rows from billing_price_map
--    where processor = 'stripe' and external_price_id not like 'price\_%';
