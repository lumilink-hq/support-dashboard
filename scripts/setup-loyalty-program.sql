-- =============================================================================
-- setup-loyalty-program.sql — create or update a store's LL Loyalty program
-- (needs 0200-0204). Defaults below are Joy's live Tsunami settings, read
-- 2026-10-09 (docs/loyalty/PLAN.md §3).
--
-- Supabase Dashboard -> SQL Editor (or the local db container). Fill in
-- v_client / v_client_name / v_shop, run once with v_dry_run = true, then flip
-- it to false.
--
-- Re-running is safe: every row is upserted on its key, so editing a value
-- here and re-running updates it. Rows removed from this script are NOT
-- deleted; set is_active = false by hand instead (tiers in use can't be
-- deleted at all).
-- =============================================================================

do $$
declare
  v_dry_run      boolean := true;                  -- set to false for the real run
  v_client       uuid    := '00000000-0000-0000-0000-000000000000';   -- FILL IN
  v_client_name  text    := 'Tsunami';             -- safety check on v_client
  v_shop         text    := 'FILL-IN.myshopify.com';
  -- Birthdays and anniversaries pay on the store's local date. CONFIRM in
  -- Shopify admin > Settings > General > Time zone (an IANA name).
  v_timezone     text    := 'America/Los_Angeles';
  v_prog         uuid;
begin
  if not exists (select 1 from clients where id = v_client and name = v_client_name) then
    raise exception 'client % (%) not found', v_client_name, v_client;
  end if;

  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, tier_spend_since,
                                demote_after_inactive, demotion_warning_days, points_expire_after,
                                discount_code_prefix, timezone, enroll_guests)
  values (v_client, lower(v_shop), 'Wave Rewards', 3, '2026-06-05',
          '6 months', 7, '1 year', 'WAVE-', v_timezone,
          -- Every customer is a member. Tsunami uses Shopify's NEW customer
          -- accounts (code sign-in), where customer.state never becomes
          -- 'enabled', so "has an account" can't be detected (2026-10-13).
          true)
  on conflict (shop_domain) do update
     set name                  = excluded.name,
         points_per_dollar     = excluded.points_per_dollar,
         tier_spend_since      = excluded.tier_spend_since,
         demote_after_inactive = excluded.demote_after_inactive,
         demotion_warning_days = excluded.demotion_warning_days,
         points_expire_after   = excluded.points_expire_after,
         discount_code_prefix  = excluded.discount_code_prefix,
         timezone              = excluded.timezone,
         enroll_guests         = excluded.enroll_guests
   where loyalty_programs.client_id = excluded.client_id
  returning id into v_prog;
  if v_prog is null then
    raise exception 'shop % already belongs to another client', v_shop;
  end if;

  -- Tiers: by amount spent since tier_spend_since.
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier, perks) values
    (v_prog, 'bronze', 'Bronze', 0, 0,      1.0, '[]'),
    (v_prog, 'silver', 'Silver', 1, 50000,  1.1, '["Early access", "1.1x points"]'),
    (v_prog, 'gold',   'Gold',   2, 120000, 1.2, '["1.2x points", "Free shipping on orders $75+"]')
  on conflict (program_id, key) do update
     set name = excluded.name, rank = excluded.rank, min_spend_cents = excluded.min_spend_cents,
         earn_multiplier = excluded.earn_multiplier, perks = excluded.perks;

  -- claimable: the shopper claims it on the Wave Rewards page (honor system, as Joy).
  insert into loyalty_earn_rules (program_id, key, kind, points, order_count, claimable) values
    (v_prog, 'signup',           'action',    100, null, false),
    (v_prog, 'instagram_follow', 'action',    100, null, true),
    (v_prog, 'newsletter',       'action',    75,  null, false),
    (v_prog, 'birthday',         'action',    225, null, false),
    (v_prog, 'anniversary',      'action',    225, null, false),
    (v_prog, 'referral',         'referral',  300, null, false),
    (v_prog, 'order_1',          'milestone', 100, 1,    false),
    (v_prog, 'order_10',         'milestone', 300, 10,   false),
    (v_prog, 'order_20',         'milestone', 300, 20,   false),
    (v_prog, 'order_30',         'milestone', 300, 30,   false)
  on conflict (program_id, key) do update
     set kind = excluded.kind, points = excluded.points, order_count = excluded.order_count,
         claimable = excluded.claimable;

  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents, min_order_cents) values
    (v_prog, 'five_off',           '$5 off',                    'amount_off_order', 750,  500,  0),
    (v_prog, 'referral_friend',    '$10 off your first order',  'amount_off_order', null, 1000, 0)
  on conflict (program_id, key) do update
     set name = excluded.name, kind = excluded.kind, points_cost = excluded.points_cost,
         value_cents = excluded.value_cents, min_order_cents = excluded.min_order_cents;

  -- Tier perks: automatic Shopify discounts for the tier and above (0203).
  -- Gold "members-only discounts on select products" is not offered yet (no
  -- products chosen, 2026-10-13), so it's also left out of Gold's perks text
  -- above. To add it: a 'percent_off_products' perk with collection_gids or
  -- product_gids, and the line back in Gold's perks.
  insert into loyalty_perks (program_id, key, tier_key, title, kind, min_subtotal_cents) values
    (v_prog, 'gold_free_shipping', 'gold', 'Gold: free shipping on $75+', 'free_shipping', 7500)
  on conflict (program_id, key) do update
     set tier_key = excluded.tier_key, title = excluded.title, kind = excluded.kind,
         min_subtotal_cents = excluded.min_subtotal_cents;

  raise notice 'program % for % (%): % tiers, % earn rules, % rewards, % perks',
    v_prog, v_client_name, lower(v_shop),
    (select count(*) from loyalty_tiers where program_id = v_prog),
    (select count(*) from loyalty_earn_rules where program_id = v_prog),
    (select count(*) from loyalty_rewards where program_id = v_prog),
    (select count(*) from loyalty_perks where program_id = v_prog);

  if v_dry_run then
    raise exception 'DRY RUN: rolled back. Set v_dry_run = false to apply.';
  end if;
end $$;
