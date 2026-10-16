-- =============================================================================
-- test_loyalty_joy_parity.sql — non-destructive test of 0218: dynamic amount
-- rewards (one code for N x 750 points = N x $5) and inactivity demotion
-- lowering tier spend to the new tier's threshold. (Rounding is covered in
-- test_loyalty_core.sql.)
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_joy_parity.sql
--
-- To see it FAIL:
--   * in run_loyalty_jobs drop the 'demote_spend' loyalty_post_entry
--     -> "demotion: tier spend drops to silver's threshold" fails.
--   * in loyalty_redeem use coalesce(v_rw.max_units, 1) in the units check
--     -> "dynamic: two units in one code" fails (null = no cap).
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_prog   uuid;
  v_alice  uuid;
  v_erin   uuid;
  v_gus    uuid;
  v_r      jsonb;
  v_c      loyalty_discount_codes%rowtype;
  v_n      int;
begin
  insert into clients (name, slug, is_active) values ('Loyalty Parity Test', 'loyalty-parity-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, live_since, timezone,
                                points_expire_after, demote_after_inactive, demotion_warning_days, discount_code_prefix)
  values (v_client, 'parity-test.myshopify.com', 'Wave Rewards', 3, '2026-01-01T00:00:00Z', 'America/Los_Angeles',
          null, '6 months', 7, 'WAVE-')
  returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier) values
    (v_prog, 'bronze', 'Bronze', 0, 0, 1.0),
    (v_prog, 'silver', 'Silver', 1, 50000, 1.1),
    (v_prog, 'gold',   'Gold',   2, 120000, 1.2);
  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents, max_units) values
    (v_prog, 'five_off',        '$5 off',                   'amount_off_order', 750,  500,  null),
    (v_prog, 'ten_fixed',       '$10 off',                  'amount_off_order', 1500, 1000, 1),
    (v_prog, 'referral_friend', '$10 off your first order', 'amount_off_order', null, 1000, 1);

  -- --- dynamic amount reward ---
  v_alice := loyalty_enroll_member(v_prog, 10, 'alice@example.com');
  perform loyalty_post_entry(v_alice, 2000, 'adjust', 'test:alice', 0, null, 'staff', null, null, 'test');

  assert column_default is not null from information_schema.columns
    where table_name = 'loyalty_rewards' and column_name = 'max_units', 'schema: max_units has a default (existing rewards stay fixed)';

  v_r := loyalty_redeem(v_alice, 'five_off', 'req-alice-units-2', 2);
  assert v_r->>'status' = 'pending', 'dynamic: two units in one code';
  select * into v_c from loyalty_discount_codes where id = (v_r->>'code_id')::uuid;
  assert v_c.value_cents = 1000, 'dynamic: code is worth 2 x $5';
  assert v_c.points_spent = 1500, 'dynamic: code cost 2 x 750';
  assert v_c.title = 'Wave Rewards: $10 off', 'dynamic: title names the bundled amount';
  assert (select points_balance from loyalty_members where id = v_alice) = 500, 'dynamic: 1,500 points taken';

  v_r := loyalty_redeem(v_alice, 'five_off', 'req-alice-units-2', 2);
  assert v_r->>'status' = 'duplicate', 'dynamic: a retried request returns the same code';
  assert (select points_balance from loyalty_members where id = v_alice) = 500, 'dynamic: a retry spends nothing';

  v_r := loyalty_redeem(v_alice, 'five_off', 'req-alice-units-3', 3);
  assert v_r->>'status' = 'insufficient_points', 'dynamic: can''t buy more than the balance covers';
  assert (v_r->>'points_cost')::int = 2250, 'dynamic: reports the bundled cost';
  assert (select points_balance from loyalty_members where id = v_alice) = 500, 'dynamic: nothing taken on refusal';

  perform loyalty_post_entry(v_alice, 3000, 'adjust', 'test:alice2', 0, null, 'staff', null, null, 'test');
  v_r := loyalty_redeem(v_alice, 'ten_fixed', 'req-alice-fixed-2', 2);
  assert v_r->>'status' = 'invalid_units', 'fixed: a max_units 1 reward refuses 2 units';
  v_r := loyalty_redeem(v_alice, 'five_off', 'req-alice-units-0', 0);
  assert v_r->>'status' = 'invalid_units', 'dynamic: zero units refused';
  v_r := loyalty_redeem(v_alice, 'ten_fixed', 'req-alice-fixed-1');
  assert v_r->>'status' = 'pending', 'fixed: the 3-argument call still works (units default 1)';
  assert (select value_cents from loyalty_discount_codes where id = (v_r->>'code_id')::uuid) = 1000, 'fixed: one unit';
  assert (select title from loyalty_discount_codes where id = (v_r->>'code_id')::uuid) = 'Wave Rewards: $10 off', 'fixed: title is the reward name';

  update loyalty_rewards set max_units = 2 where program_id = v_prog and key = 'five_off';
  v_r := loyalty_redeem(v_alice, 'five_off', 'req-alice-capped', 3);
  assert v_r->>'status' = 'invalid_units', 'dynamic: a cap is respected';
  update loyalty_rewards set max_units = null where program_id = v_prog and key = 'five_off';

  v_r := loyalty_storefront_state(v_prog, 10);
  assert (select r->'max_units' from jsonb_array_elements(v_r->'rewards') r where r->>'key' = 'five_off') = 'null'::jsonb,
    'state: five_off has no cap';
  assert (select (r->>'max_units')::int from jsonb_array_elements(v_r->'rewards') r where r->>'key' = 'referral_friend') = 1,
    'state: the friend reward is a single unit';
  assert loyalty_shop_program_json(v_prog)->'rewards'->0 ? 'max_units', 'metafield: rewards carry max_units';

  -- --- demotion lowers tier spend ---
  v_erin := loyalty_enroll_member(v_prog, 50, 'erin@example.com', null, null, '2026-01-01T00:00:00Z');
  perform loyalty_post_entry(v_erin, 0, 'order', 'test:erin-1', 130000, null, null, null, null, 'test', '2026-01-15T00:00:00Z');
  assert (select tier_key from loyalty_members where id = v_erin) = 'gold', 'setup: $1,300 spend is gold';

  perform run_loyalty_jobs('2026-07-20T00:00:00Z');
  assert (select tier_key from loyalty_members where id = v_erin) = 'silver', 'demotion: gold -> silver after 6 months';
  assert (select tier_spend_cents from loyalty_members where id = v_erin) = 50000, 'demotion: tier spend drops to silver''s threshold';
  select count(*) into v_n from loyalty_ledger where member_id = v_erin and reason = 'adjust' and points = 0 and spend_cents = -80000;
  assert v_n = 1, 'demotion: one zero-point ledger entry for the spend';
  assert (select points_balance from loyalty_members where id = v_erin) = 0, 'demotion: no points move';
  perform run_loyalty_jobs('2026-07-21T00:00:00Z');
  select count(*) into v_n from loyalty_ledger where member_id = v_erin and source_id = 'demotion';
  assert v_n = 1, 'demotion: the spend reset runs once per lapse';

  perform loyalty_post_entry(v_erin, 0, 'order', 'test:erin-2', 5000, null, null, null, null, 'test', '2026-07-25T00:00:00Z');
  assert (select tier_key from loyalty_members where id = v_erin) = 'silver', 'demotion: the next small order doesn''t restore gold';

  perform run_loyalty_jobs('2027-01-26T00:00:00Z');
  assert (select tier_key from loyalty_members where id = v_erin) = 'bronze', 'demotion: silver -> bronze after another lapse';
  assert (select tier_spend_cents from loyalty_members where id = v_erin) = 0, 'demotion: spend drops to bronze''s threshold';

  -- A staff-set tier above the member's spend: demoted, spend not raised.
  v_gus := loyalty_enroll_member(v_prog, 60, 'gus@example.com', null, null, '2026-01-01T00:00:00Z');
  perform loyalty_set_tier(v_gus, 'gold', 'staff', 'test');
  perform run_loyalty_jobs('2026-07-20T00:00:00Z');
  assert (select tier_key from loyalty_members where id = v_gus) = 'silver', 'demotion: staff-set gold -> silver';
  assert (select tier_spend_cents from loyalty_members where id = v_gus) = 0, 'demotion: spend below the threshold is left alone';

  select count(*) into v_n from loyalty_verify_balances(v_prog);
  assert v_n = 0, 'ledger: cached balances and spend still match the ledger';

  raise notice 'test_loyalty_joy_parity: all assertions passed';
end;
$$;

rollback;
