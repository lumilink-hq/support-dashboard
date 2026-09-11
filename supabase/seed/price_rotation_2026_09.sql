-- =============================================================================
-- price_rotation_2026_09.sql — map the NEW Stripe prices from the 2026-09-11
-- "no price ends in 9 anymore" rotation, and bump plan_tiers to match.
--
-- WHY THIS EXISTS. Stripe prices are immutable, so raising every $X9 amount by
-- $1 created NINE brand-new price objects (3 plans + 6 add-ons), all sharing
-- their old product ids but with new price ids. resolveFeature/resolvePlanTier
-- in supabase/functions/billing-webhook/index.ts:208-213,285-291 match
-- PURELY by external_price_id against billing_price_map with is_active=true.
-- Until this file runs, any purchase or upgrade billed at the new prices finds
-- no row, resolves no feature/tier, and parks as 'unmapped' instead of
-- granting an entitlement — existing subscribers renewing at their OLD price
-- are unaffected, only new/changed purchases are broken.
--
-- OLD ROWS ARE NOT TOUCHED. An existing subscriber's price id does not change
-- until they're migrated to a new Payment Link, and their renewal invoices
-- keep reporting the old id — deactivating it would break THEIR resolution.
-- This only adds the new ids alongside, exactly like the live/test dual rows
-- already in billing_price_map_stripe.sql.
--
-- WEBSITE CHAT IS THE ONE EXCEPTION ON PURPOSE: its old $39 row stays
-- is_active=false (it was never sellable — no metering exists, see
-- lib/addons.ts and BUILD-PLAN-2026-08.md §H). Only the NEW $40 row is
-- inserted as active, per the explicit 2026-09-11 decision to sell it despite
-- that gap. If that decision gets reversed, flip this row's is_active back to
-- false rather than deleting it.
--
-- SKIPPED ON PURPOSE: price_1UEdCB2LgljE9Ppsq81GePd3 — a stray $300 ONE-TIME
-- Starter price created the same minute as the correct $180/mo recurring one.
-- One-time prices never belong in this table (see billing_price_map_stripe.sql
-- §"setup-fee prices need NO rows here"); this looks like an accidental extra
-- price in Stripe worth archiving there, not something to map here.
--
-- NOT a migration. Safe to re-run (ON CONFLICT upserts).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. plan_tiers — enforcement truth. Must match lib/entitlements.ts exactly,
--    or the pricing page and the provisioner disagree (0031's own verify
--    query at the bottom of billing_price_map_stripe.sql checks this).
-- ---------------------------------------------------------------------------
update plan_tiers set monthly_usd = 180.00 where tier = 'starter';
update plan_tiers set monthly_usd = 280.00 where tier = 'growth';
update plan_tiers set monthly_usd = 450.00 where tier = 'scale';

-- ---------------------------------------------------------------------------
-- 2. New plan prices (kind='plan', carries plan_tier — required by 0031's
--    check constraint).
-- ---------------------------------------------------------------------------
insert into billing_price_map
  (processor, external_price_id, feature, plan_tier, kind, display_amount, display_currency, display_interval, is_active)
values
  ('stripe', 'price_1UEdCB2LgljE9Pps6cHzxz37', 'voice', 'starter', 'plan', 180.00, 'usd', 'month', true),
  ('stripe', 'price_1UEdCT2LgljE9PpsXQHeJDjT', 'voice', 'growth',  'plan', 280.00, 'usd', 'month', true),
  ('stripe', 'price_1UEdBV2LgljE9PpsFNWOT3W0', 'voice', 'scale',   'plan', 450.00, 'usd', 'month', true)
on conflict (processor, external_price_id) do update
  set feature          = excluded.feature,
      plan_tier        = excluded.plan_tier,
      kind             = excluded.kind,
      display_amount   = excluded.display_amount,
      display_currency = excluded.display_currency,
      display_interval = excluded.display_interval,
      is_active        = excluded.is_active;

-- ---------------------------------------------------------------------------
-- 3. New add-on prices (kind='addon', carries addon_key — never a plan_tier).
-- ---------------------------------------------------------------------------
insert into billing_price_map
  (processor, external_price_id, feature, kind, addon_key, display_amount, display_currency, display_interval, is_active)
values
  ('stripe', 'price_1UEdAa2LgljE9PpsDQawF7Fc', 'voice', 'addon', 'additional_phone_line', 20.00, 'usd', 'month', true),
  ('stripe', 'price_1UEdAH2LgljE9PpsYQhWCEev', 'voice', 'addon', 'additional_location',   30.00, 'usd', 'month', true),
  ('stripe', 'price_1UEd7Q2LgljE9Pps4u5XhBiS', 'voice', 'addon', 'managed_integration',   30.00, 'usd', 'month', true),
  ('stripe', 'price_1UEd7p2LgljE9Pps9nIiOCMs', 'voice', 'addon', 'advanced_workflow',     50.00, 'usd', 'month', true),
  ('stripe', 'price_1UEd6Y2LgljE9PpsPXmbCJWR', 'voice', 'addon', 'enhanced_optimization', 80.00, 'usd', 'month', true),
  -- The one row where is_active is deliberately true for a reason other than
  -- "this is just the current price" — see the header note.
  ('stripe', 'price_1UEd882LgljE9PpsOswMYp5M', 'voice', 'addon', 'website_chat',          40.00, 'usd', 'month', true)
on conflict (processor, external_price_id) do update
  set feature          = excluded.feature,
      kind             = excluded.kind,
      addon_key        = excluded.addon_key,
      display_amount   = excluded.display_amount,
      display_currency = excluded.display_currency,
      display_interval = excluded.display_interval,
      is_active        = excluded.is_active;

-- ---------------------------------------------------------------------------
-- 4. VERIFY
-- ---------------------------------------------------------------------------

-- The pricing page and the provisioner must agree. Must return zero rows:
select m.external_price_id, m.display_amount, t.monthly_usd
  from billing_price_map m join plan_tiers t on t.tier = m.plan_tier
 where m.kind = 'plan' and m.is_active and m.display_amount <> t.monthly_usd;

-- Every add-on row must have an addon_key and no plan_tier. Must return zero:
select external_price_id, addon_key, plan_tier
  from billing_price_map
 where processor = 'stripe' and kind = 'addon' and (addon_key is null or plan_tier is not null);

-- Full picture, new rows should now show alongside the old ones:
select kind, addon_key, plan_tier, display_amount, is_active, external_price_id, created_at
  from billing_price_map
 where processor = 'stripe'
 order by kind, coalesce(addon_key, plan_tier), display_amount;

-- plan_tiers itself:
select tier, monthly_usd, setup_fee_usd, included_minutes from plan_tiers order by sort_order;
