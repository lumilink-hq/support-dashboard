-- =============================================================================
-- test_loyalty_klaviyo.sql — non-destructive test of 0205 (LL Loyalty module
-- 6): events from tier changes, milestones and reward thresholds; quiet mode
-- for the backfill; Joy's profile property names and formats; nothing sent
-- before klaviyo_enabled_at; skips and retries.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_klaviyo.sql
--
-- To see it FAIL:
--   * in loyalty_record_orders drop the set_config('loyalty.quiet', 'on', true)
--     -> "quiet: a backfill promotion queues no event" fails.
--   * in loyalty_klaviyo_events_due drop the "created_at < klaviyo_enabled_at" skip
--     -> "enable: events queued before cutover are skipped" fails.
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
  v_p      jsonb;
  v_n      int;
  v_id     bigint;
begin
  insert into clients (name, slug, is_active) values ('Loyalty Klaviyo Test', 'loyalty-klaviyo-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, live_since, tier_spend_since, rewards_page_url)
  values (v_client, 'klaviyo-test.myshopify.com', 'Wave Rewards', 3, '2026-10-01', '2026-06-05', 'https://tsunami.example/pages/wave-rewards')
  returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents) values
    (v_prog, 'bronze', 'Bronze', 0, 0), (v_prog, 'silver', 'Silver', 1, 50000);
  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents) values
    (v_prog, 'five_off', '$5 off', 'amount_off_order', 750, 500),
    (v_prog, 'ten_off',  '$10 off', 'amount_off_order', 1500, 1000);
  insert into loyalty_earn_rules (program_id, key, kind, points, order_count) values (v_prog, 'order_1', 'milestone', 100, 1);

  -- --- default names are Joy's (plan §4) ---
  select klaviyo_names into v_p from loyalty_programs where id = v_prog;
  assert v_p->>'prop_tier' = 'Joy Vip tier' and v_p->>'prop_points' = 'Joy Loyalty Points' and v_p->>'event_tier_down' = 'Joy: Tier Downgrade'
     and v_p->>'event_reward_eligible' = 'Joy: Points Eligible Reward' and v_p->'event_tier_up' = 'null'::jsonb,
    'names: Joy''s by default, unknown ones null';

  -- --- quiet mode: backfill promotions queue nothing ---
  v_r := loyalty_record_orders(v_prog, jsonb_build_array(jsonb_build_object(
    'id', 1, 'processed_at', '2026-07-01T00:00:00Z', 'eligible_cents', 60000,
    'customer', jsonb_build_object('id', 10, 'email', 'alice@example.com', 'state', 'enabled'))), 'backfill');
  select id into v_alice from loyalty_members where program_id = v_prog and shopify_customer_id = 10;
  assert (select tier_key from loyalty_members where id = v_alice) = 'silver', 'quiet: backfill still promotes';
  select count(*) into v_n from loyalty_events where member_id = v_alice;
  assert v_n = 0, 'quiet: a backfill promotion queues no event';
  assert not loyalty_quiet(), 'quiet: off again after the batch';

  -- --- live events ---
  v_bob := loyalty_enroll_member(v_prog, 11, 'bob@example.com', 'Bob');
  perform loyalty_post_entry(v_bob, 0, 'order', 'order:2:earn', 60000);     -- live promotion
  assert exists (select 1 from loyalty_events where member_id = v_bob and kind = 'tier_up'
                  and payload->>'tier' = 'Silver' and payload->>'previous_tier' = 'Bronze'), 'event: tier_up on spend';
  perform loyalty_post_entry(v_bob, 0, 'refund', 'refund:2', -60000);
  assert exists (select 1 from loyalty_events where member_id = v_bob and kind = 'tier_down' and payload->>'reason' = 'refund'),
    'event: tier_down on refund';
  perform loyalty_set_tier(v_bob, 'silver', 'import');
  select count(*) into v_n from loyalty_events where member_id = v_bob and kind = 'tier_up';
  assert v_n = 1, 'event: an import tier change is silent';

  perform loyalty_post_entry(v_bob, 800, 'adjust', 'test:bob1', 0, null, 'staff', null, null, 'test');
  perform loyalty_post_entry(v_bob, 800, 'adjust', 'test:bob2', 0, null, 'staff', null, null, 'test');
  select count(*) into v_n from loyalty_events where member_id = v_bob and kind = 'reward_eligible';
  assert v_n = 2, 'event: reward_eligible once per threshold crossed (750, then 1500)';
  perform loyalty_post_entry(v_bob, 10, 'adjust', 'test:bob3', 0, null, 'staff', null, null, 'test');
  select count(*) into v_n from loyalty_events where member_id = v_bob and kind = 'reward_eligible';
  assert v_n = 2, 'event: staying above a threshold doesn''t repeat it';
  perform loyalty_post_entry(v_bob, 100, 'milestone', 'milestone:bob:order_1', 0, 'order_1');
  assert exists (select 1 from loyalty_events where member_id = v_bob and kind = 'milestone' and (payload->>'order_count')::int = 1),
    'event: milestone';

  -- --- profile properties ---
  update loyalty_members set birthday = '1990-03-07' where id = v_bob;
  v_p := loyalty_klaviyo_properties(v_bob);
  assert v_p->>'Joy Vip tier' = 'Silver' and (v_p->>'Joy Loyalty Points')::int = 1710 and v_p->>'Joy member status' = 'member',
    'profile: tier, points, status';
  assert v_p->>'Birthday' = '03/07/1990' and v_p->>'dateOfBirth' = '03/07/1990', 'profile: birthday MM/DD/YYYY under both names';
  assert v_p->>'Joy Referral URL' = 'https://tsunami.example/pages/wave-rewards?ref=' || (select referral_code from loyalty_members where id = v_bob),
    'profile: referral URL';
  assert not (loyalty_klaviyo_properties(v_alice) ? 'Birthday'), 'profile: no birthday, no birthday property';
  update loyalty_programs set klaviyo_names = klaviyo_names || '{"prop_status": null}' where id = v_prog;
  assert not (loyalty_klaviyo_properties(v_bob) ? 'Joy member status'), 'profile: a null name is left out';

  v_r := loyalty_klaviyo_profiles_due(v_prog);
  assert jsonb_array_length(v_r) = 2, 'profile: both members due';
  perform loyalty_klaviyo_profiles_result(jsonb_build_array(
    jsonb_build_object('member_id', v_alice, 'hash', md5(loyalty_klaviyo_properties(v_alice)::text), 'error', null),
    jsonb_build_object('member_id', v_bob, 'hash', 'x', 'error', 'Klaviyo 400')));
  v_r := loyalty_klaviyo_profiles_due(v_prog);
  assert jsonb_array_length(v_r) = 0, 'profile: synced one is done; failed one waits out its backoff';
  perform loyalty_post_entry(v_alice, 5, 'adjust', 'test:alice', 0, null, 'staff', null, null, 'test');
  assert jsonb_array_length(loyalty_klaviyo_profiles_due(v_prog)) = 1, 'profile: a points change makes it due again';

  -- --- enabling: nothing goes before cutover ---
  assert jsonb_array_length(loyalty_klaviyo_events_due(v_prog)) = 0, 'enable: nothing sent while disabled';
  -- now() is frozen inside this transaction, so date what came before enabling into the past.
  update loyalty_events set created_at = now() - interval '1 hour' where program_id = v_prog;
  update loyalty_programs set klaviyo_enabled_at = now() - interval '1 minute' where id = v_prog;
  perform loyalty_emit_event(v_bob, 'birthday', 'test:bday', '{}');
  v_r := loyalty_klaviyo_events_due(v_prog);
  assert jsonb_array_length(v_r) = 1 and v_r->0->>'metric' = 'Joy: Birthday', 'enable: only events after enabling are sent';
  assert (v_r->0->'properties'->>'tier') = 'Silver' and (v_r->0->'properties'->>'points_balance')::int = 1710
     and v_r->0->>'email' = 'bob@example.com' and v_r->0->>'unique_id' like 'll-%', 'enable: event carries email, state and a unique id';
  select count(*) into v_n from loyalty_events where program_id = v_prog and status = 'skipped' and last_error like 'queued before%';
  assert v_n >= 5, 'enable: events queued before cutover are skipped';

  v_id := (v_r->0->>'id')::bigint;
  for i in 1..4 loop
    perform loyalty_klaviyo_event_result(v_id, 'Klaviyo 500');
  end loop;
  assert (select status from loyalty_events where id = v_id) = 'pending', 'retry: up to 5 attempts';
  perform loyalty_klaviyo_event_result(v_id, 'Klaviyo 500');
  assert (select status from loyalty_events where id = v_id) = 'failed', 'retry: 5th failure is final';
  perform loyalty_emit_event(v_bob, 'pre_birthday', 'test:pre', '{}');
  perform loyalty_emit_event(v_bob, 'demotion_warning', 'test:warn', '{}');
  v_r := loyalty_klaviyo_events_due(v_prog);
  assert jsonb_array_length(v_r) = 1 and v_r->0->>'metric' = 'Joy: 7 Days Pre Birthday', 'skip: an event with no name isn''t sent';
  assert (select status from loyalty_events where dedupe_key = 'test:warn') = 'skipped', 'skip: marked skipped with a reason';
  perform loyalty_klaviyo_event_result((v_r->0->>'id')::bigint);
  assert (select status = 'sent' and sent_at is not null from loyalty_events where dedupe_key = 'test:pre'), 'sent: recorded';

  select count(*) into v_n from loyalty_verify_balances(v_prog);
  assert v_n = 0, 'verify: caches match the ledger';
end $$;

do $$
declare
  v_denied boolean;
begin
  set local role authenticated;
  begin
    perform get_loyalty_klaviyo_key(gen_random_uuid());
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rls: authenticated cannot read the Klaviyo key';
  reset role;
end $$;

rollback;

\echo 'test_loyalty_klaviyo: all assertions passed'
