-- =============================================================================
-- test_loyalty_storefront.sql — non-destructive test of 0204 (LL Loyalty
-- module 5): storefront state (rules for everyone, a member's own data only),
-- birthday once, honor-system claims, the referral form and its daily cap,
-- and order tags for orders that used our codes.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_storefront.sql
--
-- To see it FAIL:
--   * in loyalty_set_birthday drop "and birthday is null"
--     -> "birthday: set once" fails.
--   * in loyalty_claim_action drop "and r.claimable"
--     -> "claim: a non-claimable action can't be claimed" fails.
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
  v_s      jsonb;
  v_r      jsonb;
  v_n      int;
  v_code   text;
begin
  insert into clients (name, slug, is_active) values ('Loyalty Storefront Test', 'loyalty-storefront-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, live_since, discount_code_prefix, referrals_per_day)
  values (v_client, 'storefront-test.myshopify.com', 'Wave Rewards', 3, '2026-10-01', 'WAVE-', 2)
  returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier, perks) values
    (v_prog, 'bronze', 'Bronze', 0, 0, 1.0, '["Birthday rewards"]'),
    (v_prog, 'silver', 'Silver', 1, 50000, 1.1, '["1.1x points"]');
  insert into loyalty_earn_rules (program_id, key, kind, points, order_count, claimable) values
    (v_prog, 'instagram_follow', 'action', 100, null, true),
    (v_prog, 'newsletter',       'action', 75,  null, false),
    (v_prog, 'referral',         'referral', 300, null, false),
    (v_prog, 'order_1',          'milestone', 100, 1, false);
  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents) values
    (v_prog, 'five_off',        '$5 off',                   'amount_off_order', 750,  500),
    (v_prog, 'referral_friend', '$10 off your first order', 'amount_off_order', null, 1000);

  v_alice := loyalty_enroll_member(v_prog, 10, 'alice@example.com', 'Alice');
  v_bob   := loyalty_enroll_member(v_prog, 11, 'bob@example.com', 'Bob');
  perform loyalty_post_entry(v_alice, 1000, 'adjust', 'test:alice', 30000, null, 'staff', null, null, 'test');
  perform loyalty_post_entry(v_bob, 5, 'adjust', 'test:bob', 0, null, 'staff', null, null, 'test');

  -- --- program lookup ---
  assert loyalty_program_for_shop('STOREFRONT-TEST.myshopify.com') = v_prog, 'shop: program found, case-insensitive';
  assert loyalty_program_for_shop('nope.myshopify.com') is null, 'shop: unknown shop';

  -- --- state ---
  v_s := loyalty_storefront_state(v_prog, null);
  assert v_s->'member' = 'null'::jsonb and (v_s->>'logged_in')::boolean = false, 'state: logged out has no member';
  assert jsonb_array_length(v_s->'tiers') = 2 and v_s->'tiers'->1->>'min_spend_cents' = '50000', 'state: tiers with spend thresholds';
  assert jsonb_array_length(v_s->'earn_rules') = 4, 'state: active earn rules';
  assert v_s->'rewards'->0->>'key' = 'five_off', 'state: purchasable rewards first';

  v_s := loyalty_storefront_state(v_prog, 10);
  assert (v_s->'member'->>'points')::int = 1000 and v_s->'member'->'tier'->>'name' = 'Bronze', 'state: member points and tier';
  assert (v_s->'member'->'next_tier'->>'remaining_cents')::bigint = 20000, 'state: $200 to Silver';
  assert v_s->'member'->>'first_name' = 'Alice', 'state: own name';
  assert v_s::text not like '%bob@example.com%' and v_s::text not like '%alice@example.com%', 'state: no emails, and nobody else''s data';
  assert jsonb_array_length(v_s->'member'->'history') = 1, 'state: history';
  assert (loyalty_storefront_state(v_prog, 999)->>'logged_in')::boolean and loyalty_storefront_state(v_prog, 999)->'member' = 'null'::jsonb,
    'state: logged in but not a member yet';

  -- --- birthday ---
  assert loyalty_set_birthday(v_alice, '1990-10-20') = 'set', 'birthday: set';
  assert loyalty_set_birthday(v_alice, '1991-01-01') = 'already_set', 'birthday: set once';
  assert (select birthday from loyalty_members where id = v_alice) = '1990-10-20', 'birthday: first value kept';
  assert loyalty_set_birthday(v_bob, current_date + 1) = 'invalid', 'birthday: future refused';
  assert loyalty_set_birthday(v_bob, '1850-01-01') = 'invalid', 'birthday: absurd year refused';

  -- --- claims ---
  assert loyalty_claim_action(v_alice, 'instagram_follow') = 100, 'claim: Instagram follow pays 100';
  assert loyalty_claim_action(v_alice, 'instagram_follow') = 0, 'claim: once';
  assert loyalty_claim_action(v_alice, 'newsletter') = 0, 'claim: a non-claimable action can''t be claimed';
  assert loyalty_claim_action(v_alice, 'order_1') = 0, 'claim: a milestone can''t be claimed';
  assert loyalty_storefront_state(v_prog, 10)->'member'->'claimed' ? 'instagram_follow', 'state: claimed actions listed';

  -- --- referral form ---
  select referral_code into v_code from loyalty_members where id = v_alice;
  assert loyalty_referral_by_code(v_prog, 'NOPE1234', 'f@example.com')->>'status' = 'unknown_code', 'referral: unknown code';
  v_r := loyalty_referral_by_code(v_prog, lower(v_code), 'friend1@example.com');
  assert v_r->>'status' = 'created' and v_r->>'code' like 'WAVE-REF-%' and v_r ? 'code_id' and not v_r ? 'referral_id',
    'referral: created, friend gets the code (case-insensitive referral code)';
  assert loyalty_referral_by_code(v_prog, v_code, 'friend1@example.com')->>'status' = 'already_referred', 'referral: same friend twice';
  assert loyalty_referral_by_code(v_prog, v_code, 'friend2@example.com')->>'status' = 'created', 'referral: second friend';
  assert loyalty_referral_by_code(v_prog, v_code, 'friend3@example.com')->>'status' = 'limit_reached', 'referral: capped per referrer per day';
  assert loyalty_code_for_issue((v_r->>'code_id')::uuid)->>'customer_id' is null, 'referral: friend code has no customer restriction';

  -- --- order tags ---
  v_r := loyalty_redeem(v_alice, 'five_off', 'req-alice-store-1');
  perform loyalty_code_issued((v_r->>'code_id')::uuid, 'gid://shopify/DiscountCodeNode/1');
  select discount_code into v_code from loyalty_referrals where friend_email_norm = 'friend1@example.com';
  assert loyalty_mark_codes_used(v_prog, jsonb_build_object('id', 7001, 'discount_codes', jsonb_build_array(v_r->>'code', v_code))) = 2,
    'tags: both our codes marked used';
  select count(*) into v_n from loyalty_order_tags
   where shopify_order_id = 7001 and status = 'pending' and tags @> array['Loyalty assisted', 'Loyalty referral'] and cardinality(tags) = 2;
  assert v_n = 1, 'tags: assisted + referral queued once';
  assert loyalty_mark_codes_used(v_prog, jsonb_build_object('id', 7002, 'discount_codes', jsonb_build_array('SUMMER10'))) = 0,
    'tags: someone else''s code is not ours';
  assert not exists (select 1 from loyalty_order_tags where shopify_order_id = 7002), 'tags: nothing queued for it';
  assert jsonb_array_length(loyalty_order_tags_to_apply(v_prog)) = 1, 'tags: due';
  assert loyalty_shopify_has_work(v_prog), 'tags: makes the program have work';
  for i in 1..4 loop
    perform loyalty_order_tags_result(v_prog, 7001, 'boom');
  end loop;
  assert (select status from loyalty_order_tags where shopify_order_id = 7001) = 'pending', 'tags: retried up to 5 times';
  perform loyalty_order_tags_result(v_prog, 7001, 'boom');
  assert (select status from loyalty_order_tags where shopify_order_id = 7001) = 'failed', 'tags: 5th failure is final';
  update loyalty_order_tags set status = 'pending', attempts = 0 where shopify_order_id = 7001;
  perform loyalty_order_tags_result(v_prog, 7001);
  assert (select status from loyalty_order_tags where shopify_order_id = 7001) = 'done', 'tags: applied';

  select count(*) into v_n from loyalty_verify_balances(v_prog);
  assert v_n = 0, 'verify: caches match the ledger';
end $$;

do $$
declare
  v_denied boolean;
begin
  set local role authenticated;
  begin
    perform loyalty_storefront_state(gen_random_uuid(), 1);
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rls: authenticated cannot read storefront state directly';
  reset role;
  set local role anon;
  begin
    perform 1 from loyalty_order_tags limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rls: anon cannot read loyalty_order_tags';
  reset role;
end $$;

rollback;

\echo 'test_loyalty_storefront: all assertions passed'
