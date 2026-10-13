-- =============================================================================
-- test_loyalty_core.sql — non-destructive test of 0200 (LL Loyalty module 1):
-- enrollment, order points x tier multiplier, tier up on spend and down on
-- refund, idempotent posting, overdraw guard, milestones, the append-only
-- ledger, cached balances matching the ledger, and no tenant access.
--
-- Uses Joy's live Tsunami rules (plan §3) as the fixture.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_core.sql
--
-- To see it FAIL:
--   * in loyalty_post_entry drop the "p_reason <> 'refund'" overdraw guard
--     -> "redeem: overdraw raises insufficient_points" fails.
--   * drop trigger trg_loyalty_ledger_append_only on loyalty_ledger;
--     -> "ledger: update is rejected" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client  uuid;
  v_prog    uuid;
  v_alice   uuid;
  v_bob     uuid;
  v_again   uuid;
  v_r       jsonb;
  v_n       int;
  v_text    text;
  v_denied  boolean;
begin
  insert into clients (name, slug, is_active) values ('Loyalty Test', 'loyalty-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, tier_spend_since,
                                points_expire_after, discount_code_prefix)
  values (v_client, 'loyalty-test.myshopify.com', 'Wave Rewards', 3, '2026-06-05', '1 year', 'WAVE-')
  returning id into v_prog;

  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier) values
    (v_prog, 'bronze', 'Bronze', 0, 0, 1.0),
    (v_prog, 'silver', 'Silver', 1, 50000, 1.1),
    (v_prog, 'gold',   'Gold',   2, 120000, 1.2);
  insert into loyalty_earn_rules (program_id, key, kind, points, order_count) values
    (v_prog, 'signup',      'action',    100, null),
    (v_prog, 'order_1',     'milestone', 100, 1),
    (v_prog, 'order_10',    'milestone', 300, 10),
    (v_prog, 'order_20',    'milestone', 300, 20),
    (v_prog, 'order_30',    'milestone', 300, 30);
  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents)
  values (v_prog, 'five_off', '$5 off', 'amount_off_order', 750, 500);

  -- --- tiers and milestones (pure lookups) ---
  assert loyalty_tier_for_spend(v_prog, 0) = 'bronze', 'tier: $0 is bronze';
  assert loyalty_tier_for_spend(v_prog, 49999) = 'bronze', 'tier: $499.99 is bronze';
  assert loyalty_tier_for_spend(v_prog, 50000) = 'silver', 'tier: $500 is silver';
  assert loyalty_tier_for_spend(v_prog, 500000) = 'gold', 'tier: $5,000 is gold';
  assert loyalty_tier_for_spend(v_prog, -100) = 'bronze', 'tier: negative spend is the entry tier';
  select count(*) into v_n from loyalty_milestones_crossed(v_prog, 0, 1);
  assert v_n = 1, 'milestones: 1st order';
  select count(*) into v_n from loyalty_milestones_crossed(v_prog, 9, 21);
  assert v_n = 2, 'milestones: jumping 9 -> 21 hits 10th and 20th';
  select count(*) into v_n from loyalty_milestones_crossed(v_prog, 10, 10);
  assert v_n = 0, 'milestones: no new orders, nothing crossed';

  -- --- enrollment ---
  v_alice := loyalty_enroll_member(v_prog, 1001, 'alice@example.com', 'Alice', null);
  v_again := loyalty_enroll_member(v_prog, 1001, null, null, 'Ng');
  assert v_alice = v_again, 'enroll: idempotent on shopify customer id';
  select count(*) into v_n from loyalty_members
   where id = v_alice and tier_key = 'bronze' and email = 'alice@example.com' and last_name = 'Ng'
     and length(referral_code) = 8;
  assert v_n = 1, 'enroll: entry tier, contact fields merged (nulls keep old values), referral code set';
  select count(*) into v_n from loyalty_tier_changes where member_id = v_alice and direction = 'enroll';
  assert v_n = 1, 'enroll: one enroll row in tier history';
  v_bob := loyalty_enroll_member(v_prog, 1002, 'bob@example.com', 'Bob', null, '2026-07-01', v_alice);
  assert (select referred_by from loyalty_members where id = v_bob) = v_alice, 'enroll: referrer recorded';

  -- --- order points: $100.99 at Bronze = floor(100.99 x 3 x 1.0) = 302 ---
  assert loyalty_order_points(v_alice, 10099) = 302, 'points: bronze 3/$ floors';
  v_r := loyalty_post_entry(v_alice, 302, 'order', 'order:1:earn', 10099, null, 'shopify_order', '1', null, 'system', '2026-07-02');
  assert (v_r->>'duplicate')::boolean = false and (v_r->>'points_balance')::int = 302
     and (v_r->>'paid_order_count')::int = 1, 'order: posted, balance 302, 1 order';

  -- Shopify retries the same webhook.
  v_r := loyalty_post_entry(v_alice, 302, 'order', 'order:1:earn', 10099);
  assert (v_r->>'duplicate')::boolean and (v_r->>'points_balance')::int = 302
     and (v_r->>'paid_order_count')::int = 1, 'idempotent: retry changes nothing';
  begin
    perform loyalty_post_entry(v_bob, 302, 'order', 'order:1:earn', 10099);
    v_denied := false;
  exception when others then v_denied := sqlerrm like '%another member%';
  end;
  assert v_denied, 'idempotent: same key on another member raises';

  -- --- tier up on spend: +$450 crosses $500 -> silver ---
  v_r := loyalty_post_entry(v_alice, loyalty_order_points(v_alice, 45000), 'order', 'order:2:earn', 45000);
  assert (v_r->>'points_balance')::int = 302 + 1350, 'order 2: earned at bronze (tier before the order)';
  assert (v_r->>'tier_changed')::boolean and v_r->>'tier_key' = 'silver', 'tier: promoted to silver on spend';
  assert loyalty_order_points(v_alice, 10000) = 330, 'points: silver earns 1.1x';
  select count(*) into v_n from loyalty_tier_changes
   where member_id = v_alice and direction = 'up' and reason = 'spend' and to_tier = 'silver' and ledger_id is not null;
  assert v_n = 1, 'tier: change logged against the ledger entry';

  -- Staff override up to gold; a small order with spend tier silver must not demote.
  assert loyalty_set_tier(v_alice, 'gold', 'staff', 'jay@packsglobal.com'), 'set_tier: staff override';
  v_r := loyalty_post_entry(v_alice, 0, 'order', 'order:3:earn', 1);
  assert v_r->>'tier_key' = 'gold' and not (v_r->>'tier_changed')::boolean, 'tier: positive spend never demotes';

  -- --- redeem ---
  v_r := loyalty_post_entry(v_alice, -750, 'redeem', 'redeem:a1', 0, 'five_off');
  assert (v_r->>'points_balance')::int = 902, 'redeem: 1652 - 750 = 902';
  begin
    perform loyalty_post_entry(v_alice, -1000, 'redeem', 'redeem:a2', 0, 'five_off');
    v_denied := false;
  exception when others then v_denied := sqlerrm like 'insufficient_points%';
  end;
  assert v_denied, 'redeem: overdraw raises insufficient_points';
  begin
    perform loyalty_post_entry(v_alice, 750, 'redeem', 'redeem:a3');
    v_denied := false;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'redeem: a positive redeem is rejected';

  -- --- refund: claw back order 2 in full; may go negative, drops to spend tier ---
  v_r := loyalty_post_entry(v_alice, -1350, 'refund', 'refund:2:1', -45000, null, 'shopify_refund', '2');
  assert (v_r->>'points_balance')::int = -448, 'refund: balance may go negative';
  assert v_r->>'tier_key' = 'bronze', 'refund: gold drops to the spend tier (bronze)';
  assert (select paid_order_count from loyalty_members where id = v_alice) = 3, 'refund: order count is kept';

  -- --- append-only ---
  begin
    update loyalty_ledger set points = 99999 where member_id = v_alice;
    v_denied := false;
  exception when others then v_denied := sqlerrm like '%append-only%';
  end;
  assert v_denied, 'ledger: update is rejected';
  begin
    delete from loyalty_ledger where member_id = v_alice;
    v_denied := false;
  exception when others then v_denied := sqlerrm like '%append-only%';
  end;
  assert v_denied, 'ledger: delete is rejected';
  begin
    delete from loyalty_tier_changes where member_id = v_alice;
    v_denied := false;
  exception when others then v_denied := sqlerrm like '%append-only%';
  end;
  assert v_denied, 'tier history: delete is rejected';

  -- --- caches match the ledger ---
  select count(*) into v_n from loyalty_verify_balances(v_prog);
  assert v_n = 0, 'verify: every cached balance matches the ledger';

  -- --- redact / uninstall: member delete cascades through the history ---
  delete from loyalty_members where id = v_bob;
  select count(*) into v_n from loyalty_ledger where member_id = v_bob;
  assert v_n = 0, 'cascade: member delete removes their ledger';
  delete from loyalty_programs where id = v_prog;
  select count(*) into v_n from loyalty_ledger where program_id = v_prog;
  assert v_n = 0, 'cascade: program delete removes everything';
end $$;

-- --- tenants: no access at all ---
do $$
declare
  v_denied boolean;
begin
  set local role authenticated;
  begin
    perform 1 from loyalty_members limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rls: authenticated cannot read loyalty_members';
  begin
    perform loyalty_tier_for_spend(gen_random_uuid(), 0);
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rls: authenticated cannot call the rules engine';
  reset role;
end $$;

rollback;

\echo 'test_loyalty_core: all assertions passed'
