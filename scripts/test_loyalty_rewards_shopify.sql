-- =============================================================================
-- test_loyalty_rewards_shopify.sql — non-destructive test of 0203 (LL Loyalty
-- module 4): redeeming points for a code, retries, failure refunds, the
-- referral coupon trigger, codes marked used, perk work + config hashing, and
-- the member tier/points sync bookkeeping.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_rewards_shopify.sql
--
-- To see it FAIL:
--   * in loyalty_code_failed drop the redeem_reversal post
--     -> "code: 5th failure returns the points" fails.
--   * in loyalty_perk_config drop 'percent' from the object
--     -> "perk: a config change makes it due again" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_prog   uuid;
  v_alice  uuid;
  v_bob    uuid;
  v_r      jsonb;
  v_code   uuid;
  v_n      int;
  v_text   text;
  v_w      jsonb;
  v_perk   uuid;
  v_gold   uuid;
  v_hash   text;
begin
  insert into clients (name, slug, is_active) values ('Loyalty Rewards Test', 'loyalty-rewards-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, live_since, discount_code_prefix)
  values (v_client, 'rewards-test.myshopify.com', 'Wave Rewards', 3, '2026-10-01', 'WAVE-')
  returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier) values
    (v_prog, 'bronze', 'Bronze', 0, 0, 1.0),
    (v_prog, 'silver', 'Silver', 1, 50000, 1.1),
    (v_prog, 'gold',   'Gold',   2, 120000, 1.2);
  select id into v_gold from loyalty_tiers where program_id = v_prog and key = 'gold';
  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents) values
    (v_prog, 'five_off',        '$5 off',                   'amount_off_order', 750,  500),
    (v_prog, 'referral_friend', '$10 off your first order', 'amount_off_order', null, 1000);

  v_alice := loyalty_enroll_member(v_prog, 10, 'alice@example.com');
  v_bob   := loyalty_enroll_member(v_prog, 11, 'bob@example.com');
  perform loyalty_post_entry(v_alice, 1600, 'adjust', 'test:alice', 0, null, 'staff', null, null, 'test');

  -- --- new codes ---
  v_text := loyalty_new_code('WAVE-');
  assert v_text ~ '^WAVE-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$', format('code: prefix + 8 unambiguous chars, got %s', v_text);

  -- --- redeem ---
  v_r := loyalty_redeem(v_alice, 'five_off', 'req-alice-0001');
  assert v_r->>'status' = 'pending' and v_r->>'code' like 'WAVE-%', 'redeem: pending code';
  v_code := (v_r->>'code_id')::uuid;
  assert (select points_balance from loyalty_members where id = v_alice) = 850, 'redeem: 750 points taken first';
  v_r := loyalty_redeem(v_alice, 'five_off', 'req-alice-0001');
  assert v_r->>'status' = 'duplicate' and (v_r->>'code_id')::uuid = v_code, 'redeem: retried request returns the same code';
  assert (select points_balance from loyalty_members where id = v_alice) = 850, 'redeem: retry spends nothing';
  v_r := loyalty_redeem(v_alice, 'five_off', 'req-alice-0002');
  v_r := loyalty_redeem(v_alice, 'five_off', 'req-alice-0003');
  assert v_r->>'status' = 'insufficient_points', 'redeem: not enough points';
  assert (select points_balance from loyalty_members where id = v_alice) = 100, 'redeem: failed redeem spends nothing';
  select count(*) into v_n from loyalty_discount_codes where member_id = v_alice;
  assert v_n = 2, 'redeem: no code for the refused request';
  assert loyalty_redeem(v_alice, 'referral_friend', 'req-alice-0004')->>'status' = 'unknown_reward',
    'redeem: a reward with no points cost can''t be bought';

  -- --- issuing ---
  v_r := loyalty_codes_to_issue(v_prog);
  assert jsonb_array_length(v_r) = 2 and (v_r->0->>'customer_id')::bigint = 10 and (v_r->0->>'value_cents')::int = 500,
    'issue: pending codes listed with the customer';
  perform loyalty_code_issued(v_code, 'gid://shopify/DiscountCodeNode/1');
  assert (select status = 'issued' and shopify_discount_id is not null from loyalty_discount_codes where id = v_code), 'issue: marked issued';

  select id into v_code from loyalty_discount_codes where member_id = v_alice and status = 'pending';
  for i in 1..4 loop
    assert not loyalty_code_failed(v_code, 'boom'), 'code: early failures are retried';
  end loop;
  assert loyalty_code_failed(v_code, 'boom'), 'code: 5th failure is final';
  assert (select status from loyalty_discount_codes where id = v_code) = 'failed', 'code: marked failed';
  assert (select points_balance from loyalty_members where id = v_alice) = 850, 'code: 5th failure returns the points';
  assert not loyalty_code_failed(v_code, 'again'), 'code: failing a failed code does nothing';
  assert (select points_balance from loyalty_members where id = v_alice) = 850, 'code: points returned once';

  -- --- referral coupon trigger ---
  v_r := loyalty_create_referral(v_alice, 'friend@example.com');
  select discount_code into v_text from loyalty_referrals where id = (v_r->>'referral_id')::uuid;
  assert v_text like 'WAVE-REF-%', 'referral: friend code set on the referral';
  select count(*) into v_n from loyalty_discount_codes
   where referral_id = (v_r->>'referral_id')::uuid and code = v_text and value_cents = 1000 and status = 'pending' and member_id is null;
  assert v_n = 1, 'referral: $10 code queued for Shopify, open to any customer';
  assert (select customer_id from jsonb_to_recordset(loyalty_codes_to_issue(v_prog)) as x(code text, customer_id bigint) where code = v_text) is null,
    'referral: issued without a customer restriction';

  -- --- used ---
  assert loyalty_mark_codes_used(v_prog, jsonb_build_object('id', 555, 'discount_codes', jsonb_build_array(lower(v_text), 'OTHER'))) = 1,
    'used: our code on a paid order, case-insensitive';
  assert (select status = 'used' and used_order_id = 555 from loyalty_discount_codes where code = v_text), 'used: order recorded';

  -- --- perks ---
  update loyalty_programs set shopify_definitions_at = now() where id = v_prog;
  insert into loyalty_perks (program_id, key, tier_key, title, kind, min_subtotal_cents)
  values (v_prog, 'gold_free_shipping', 'silver', 'Free shipping on $75+', 'free_shipping', 7500)
  returning id into v_perk;
  v_w := loyalty_shopify_work(v_prog);
  assert (v_w->>'segment_min_rank')::int = 1, 'work: segments needed from the lowest perk tier';
  assert jsonb_array_length(v_w->'perks') = 1, 'work: new perk is due';
  assert v_w->'perks'->0->'config'->'segment_ids' = '[null, null]'::jsonb, 'work: perk covers its tier and above (silver, gold)';
  assert loyalty_shopify_has_work(v_prog), 'work: has work';

  update loyalty_tiers set shopify_segment_id = 'gid://shopify/Segment/' || rank where program_id = v_prog and rank >= 1;
  v_w := loyalty_shopify_work(v_prog);
  v_hash := v_w->'perks'->0->>'hash';
  perform loyalty_perk_synced(v_perk, 'gid://shopify/DiscountAutomaticNode/9', v_hash);
  assert jsonb_array_length(loyalty_shopify_work(v_prog)->'perks') = 0, 'perk: synced, nothing due';

  update loyalty_perks set min_subtotal_cents = 5000 where id = v_perk;
  assert jsonb_array_length(loyalty_shopify_work(v_prog)->'perks') = 1, 'perk: a config change makes it due again';
  perform loyalty_perk_synced(v_perk, null, null, 'delete failed');
  assert (select shopify_discount_id is null and last_error = 'delete failed' from loyalty_perks where id = v_perk),
    'perk: a failed re-create records that no discount is live';
  perform loyalty_perk_synced(v_perk, 'gid://shopify/DiscountAutomaticNode/10', md5(loyalty_perk_config(v_perk)::text));
  update loyalty_perks set is_active = false where id = v_perk;
  v_w := loyalty_shopify_work(v_prog);
  assert jsonb_array_length(v_w->'perks') = 1 and (v_w->'perks'->0->>'is_active')::boolean = false, 'perk: deactivated perk is due for removal';
  perform loyalty_perk_synced(v_perk, null, null);
  assert jsonb_array_length(loyalty_shopify_work(v_prog)->'perks') = 0, 'perk: removed, nothing due';

  begin
    insert into loyalty_perks (program_id, key, tier_key, title, kind) values (v_prog, 'bad', 'gold', 'x', 'percent_off_products');
    assert false, 'perk: percent perk without products must be rejected';
  exception when check_violation then null;
  end;

  -- --- member sync ---
  v_r := loyalty_members_to_sync(v_prog);
  assert v_r->'tier_names' = '["Bronze", "Silver", "Gold"]'::jsonb, 'sync: tier names in rank order';
  assert jsonb_array_length(v_r->'members') = 2, 'sync: never-synced members are due';
  perform loyalty_mark_members_synced(jsonb_build_array(
    jsonb_build_object('member_id', v_alice, 'tier_key', 'bronze', 'points', 850, 'error', null),
    jsonb_build_object('member_id', v_bob, 'tier_key', 'bronze', 'points', 0, 'error', 'tags: boom')));
  v_r := loyalty_members_to_sync(v_prog);
  assert jsonb_array_length(v_r->'members') = 1 and (v_r->'members'->0->>'member_id')::uuid = v_bob, 'sync: a failed member stays due';
  perform loyalty_post_entry(v_alice, 10, 'adjust', 'test:alice2', 0, null, 'staff', null, null, 'test');
  v_r := loyalty_members_to_sync(v_prog);
  assert exists (select 1 from jsonb_array_elements(v_r->'members') e
                  where (e->>'member_id')::uuid = v_alice and not (e->>'tier_changed')::boolean),
    'sync: points change makes a member due without a tag change';
  perform loyalty_set_tier(v_alice, 'gold', 'staff', 'test');
  v_r := loyalty_members_to_sync(v_prog);
  assert exists (select 1 from jsonb_array_elements(v_r->'members') e
                  where (e->>'member_id')::uuid = v_alice and (e->>'tier_changed')::boolean and e->>'tier_name' = 'Gold'),
    'sync: tier change flagged for the tag';

  select count(*) into v_n from loyalty_verify_balances(v_prog);
  assert v_n = 0, 'verify: caches match the ledger';
end $$;

do $$
declare
  v_denied boolean;
begin
  set local role authenticated;
  begin
    perform 1 from loyalty_discount_codes limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rls: authenticated cannot read loyalty_discount_codes';
  begin
    perform loyalty_redeem(gen_random_uuid(), 'x', 'xxxxxxxx');
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rls: authenticated cannot redeem';
  reset role;
end $$;

rollback;

\echo 'test_loyalty_rewards_shopify: all assertions passed'
