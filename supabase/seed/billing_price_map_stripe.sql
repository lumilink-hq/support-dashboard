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
-- Monthly amounts match the CFO workbook ($179/$279/$449). Change a price in
-- Stripe and you must change it here AND in lib/entitlements.ts, or the
-- marketing page and the invoice will disagree.
--
-- SETUP FEES ABOVE ARE STALE. As of 2026-08-11 the fee is a flat $49.99 on all
-- three tiers, which required NEW Stripe price objects (amounts are immutable).
-- The ids listed above are the archived $299/$499/$799 ones. They are recorded
-- here only so an old invoice can be traced. No row below maps them, and none
-- should -- see the closing note on why a setup price must never be mapped.
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
-- All three map to feature 'voice' AND to their own plan_tier. The tier column
-- is what makes the difference between selling Scale and delivering Scale.
--
-- BEFORE 0031 this map was FEATURE-level only. All three prices granted the
-- same 'voice' entitlement, provision-feature could not tell them apart, and it
-- applied the ENTRY allowance of 100 minutes to every purchase at every price.
-- A $449 Scale customer received a sixth of their minutes, silently. That was
-- survivable only because Growth and Scale were sold "Talk to us" and an
-- operator raised the cap by hand as part of the sale.
--
-- 0031 added plan_tiers + billing_price_map.plan_tier + entitlements.plan_tier,
-- and provision-feature now reads the tier and applies its allowance. So these
-- rows MUST carry plan_tier — the check constraint refuses a plan price
-- without one, precisely so this can never silently regress.
--
-- kind = 'plan' is the default and is also load-bearing: add-on prices (extra
-- number, extra department) will live in this same table and will also map to
-- feature 'voice', on the same subscription, arriving on the same webhook
-- event. 'plan' is how tier resolution knows to ignore them.
-- ---------------------------------------------------------------------------
insert into billing_price_map
  (processor, external_price_id, feature, plan_tier, kind, display_amount, display_currency, display_interval, is_active)
values
  -- LIVE mode
  ('stripe', 'price_1Tyltq2LgljE9Ppsatk8ckzq', 'voice', 'starter', 'plan', 179.00, 'usd', 'month', true),
  ('stripe', 'price_1Tylts2LgljE9PpsDREEo9Eo', 'voice', 'growth',  'plan', 279.00, 'usd', 'month', true),
  ('stripe', 'price_1Tyltt2LgljE9PpsUjcnX3Kf', 'voice', 'scale',   'plan', 449.00, 'usd', 'month', true),
  -- TEST mode. Different objects with different ids, so both sets must be
  -- present: a test purchase sends test ids, and matching them against the live
  -- rows resolves no feature and parks the payment as 'unmapped'.
  ('stripe', 'price_1TyfDd2MNeuPGOWj7Znc0uTG', 'voice', 'starter', 'plan', 179.00, 'usd', 'month', true),
  ('stripe', 'price_1TyfEK2MNeuPGOWjRH06POrk', 'voice', 'growth',  'plan', 279.00, 'usd', 'month', true),
  ('stripe', 'price_1TyfEr2MNeuPGOWj1nSO90Dz', 'voice', 'scale',   'plan', 449.00, 'usd', 'month', true)
on conflict (processor, external_price_id) do update
  set feature          = excluded.feature,
      plan_tier        = excluded.plan_tier,
      kind             = excluded.kind,
      display_amount   = excluded.display_amount,
      display_currency = excluded.display_currency,
      display_interval = excluded.display_interval,
      is_active        = excluded.is_active;

-- ---------------------------------------------------------------------------
-- ADD-ONS — the slot, deliberately empty.
--
-- No add-on products exist in Stripe yet. When they do, map them HERE, with
-- kind = 'addon' and an addon_key, and NOT as plan rows:
--
--   insert into billing_price_map
--     (processor, external_price_id, feature, kind, addon_key,
--      display_amount, display_currency, display_interval, is_active)
--   values
--     ('stripe', 'price_…', 'voice', 'addon', 'extra_number',     15.00, 'usd', 'month', true),
--     ('stripe', 'price_…', 'voice', 'addon', 'extra_department', 39.00, 'usd', 'month', true)
--   on conflict (processor, external_price_id) do update
--     set kind = excluded.kind, addon_key = excluded.addon_key;
--
-- WHY kind MATTERS MORE THAN IT LOOKS. A Payment Link's optional items are
-- billed on the SAME subscription as the plan, so an add-on's price id arrives
-- on the same subscription.created and invoice.paid events as the plan's. Tier
-- resolution matches every price id on the event; a row without kind='addon'
-- would be a candidate answer to "which plan did they buy?", and 0031's check
-- constraint would force you to give the $15 extra-number price a plan_tier to
-- insert it at all. Both guards point the same way: add-ons are not plans.
--
-- STILL TO BUILD when the products exist — mapping the price is not the whole
-- job. Nothing yet acts on an add-on:
--   * extra_number     — provision-feature buys exactly ONE number per client
--                        (provisionVoice step 1). A second number needs a
--                        quantity-aware provisioning step, or it is a manual
--                        fulfilment task.
--   * extra_department — config only, but nothing reads an add-on to enable it.
-- Selling either before that exists means taking the money and fulfilling by
-- hand. That is a legitimate choice; it should just be a chosen one.
-- ---------------------------------------------------------------------------

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
--   select m.processor, m.external_price_id, m.feature, m.kind, m.plan_tier,
--          m.display_amount, t.included_minutes, m.is_active
--     from billing_price_map m
--     left join plan_tiers t on t.tier = m.plan_tier
--    order by m.kind, m.display_amount;
--
-- Every external_price_id must start with 'price_'. This catches the prod_ mixup:
--   select count(*) as bad_rows from billing_price_map
--    where processor = 'stripe' and external_price_id not like 'price\_%';
--
-- No plan price may be missing its tier — the constraint blocks it, but check
-- after any manual edit. Must return zero:
--   select count(*) from billing_price_map
--    where kind = 'plan' and plan_tier is null;
--
-- The minutes a price maps to must match what /plans quotes for that amount.
-- Must return zero rows; a hit means the page and the provisioner disagree:
--   select m.external_price_id, m.display_amount, t.monthly_usd
--     from billing_price_map m join plan_tiers t on t.tier = m.plan_tier
--    where m.kind = 'plan' and m.display_amount <> t.monthly_usd;
