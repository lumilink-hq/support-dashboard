-- =============================================================================
-- seed-addon-price-map.sql — map the six add-on prices created 2026-08-13.
--
-- Companion to supabase/seed/billing_price_map_stripe.sql, which maps the PLAN
-- prices. Kept separate because add-ons arrive later and on their own schedule;
-- re-running either is safe.
--
-- WHY `kind` AND `addon_key` ARE NOT BOOKKEEPING
--
-- An optional item on a Payment Link rides the SAME subscription as the plan.
-- Its price id therefore arrives on the same `customer.subscription.created` and
-- `invoice.paid` events as the plan's, and `resolvePlanTier()` matches EVERY
-- price id on the event. Without `kind = 'addon'`, a $39 Website Chat row is a
-- candidate answer to "which tier did they buy?" — and the tier decides the
-- minute allowance `set_plan_tier_caps` applies. That is the exact class of bug
-- 0031 was written to kill.
--
-- 0031's check constraints catch it from two directions: a `kind='plan'` row
-- must carry a plan_tier, and a `kind='addon'` row must carry an addon_key.
--
-- NEVER give an add-on a plan_tier. Not "for completeness", not "so it matches
-- the others".
--
-- MODE. These ids are from the export dated 2026-08-13. Stripe objects are
-- mode-scoped, so if you rebuild these add-ons in the other mode you must insert
-- those ids too — a test purchase sending test ids against live rows resolves
-- nothing and parks the payment as 'unmapped'.
--
-- FULFILMENT IS NOT MAPPING. Every row below makes the add-on BILL correctly. It
-- does not make it HAPPEN. See docs/BUILD-PLAN-2026-08.md §D — there is no
-- client_addons table, provisionVoice buys exactly one number, and Website Chat
-- has no metering at all (§H, and §8 of the costs workbook). Selling these today
-- means manual fulfilment per sale.
-- =============================================================================

insert into billing_price_map
  (processor, external_price_id, feature, kind, addon_key,
   display_amount, display_currency, display_interval, is_active)
values
  ('stripe', 'price_1U3qrT2LgljE9PpsyUZL6BEj', 'voice', 'addon', 'additional_phone_line',  19.00, 'usd', 'month', true),
  ('stripe', 'price_1U3qsv2LgljE9PpskOsFjrK8', 'voice', 'addon', 'additional_location',    29.00, 'usd', 'month', true),
  ('stripe', 'price_1U3qu92LgljE9PpsfBbayR1Q', 'voice', 'addon', 'managed_integration',    29.00, 'usd', 'month', true),
  ('stripe', 'price_1U3qtu2LgljE9PpsYh81PxvR', 'voice', 'addon', 'advanced_workflow',      49.00, 'usd', 'month', true),
  ('stripe', 'price_1U3quO2LgljE9PpsyOcuOJYH', 'voice', 'addon', 'enhanced_optimization',  79.00, 'usd', 'month', true),
  -- WEBSITE CHAT IS DELIBERATELY is_active = FALSE.
  --
  -- The price exists and can be mapped, but nothing meters a browser chat
  -- session: every cap in the product is denominated in MINUTES and a text
  -- session generates none, on a surface any visitor can open. Mapping it active
  -- makes it sellable before it is safe to sell. Flip this to true once the
  -- message allowance, per-session ceiling and per-slug rate limit exist.
  ('stripe', 'price_1U3qtT2LgljE9PpsbqqgQpYw', 'voice', 'addon', 'website_chat',           39.00, 'usd', 'month', false)
on conflict (processor, external_price_id) do update
  set feature          = excluded.feature,
      kind             = excluded.kind,
      addon_key        = excluded.addon_key,
      display_amount   = excluded.display_amount,
      display_currency = excluded.display_currency,
      display_interval = excluded.display_interval,
      is_active        = excluded.is_active;

-- -----------------------------------------------------------------------------
-- VERIFY
-- -----------------------------------------------------------------------------

-- Every add-on row must have an addon_key and NO plan_tier. Expect zero rows.
select external_price_id, addon_key, plan_tier
  from billing_price_map
 where processor = 'stripe'
   and kind = 'addon'
   and (addon_key is null or plan_tier is not null);

-- The full picture, plans and add-ons side by side.
select kind, addon_key, plan_tier, display_amount, is_active, external_price_id
  from billing_price_map
 where processor = 'stripe'
 order by kind, display_amount;

-- Tier resolution must still see exactly the plan rows and nothing else.
-- Expect 6 (3 live + 3 test), and no add-on among them.
select count(*) as plan_rows
  from billing_price_map
 where processor = 'stripe' and kind = 'plan' and is_active;
