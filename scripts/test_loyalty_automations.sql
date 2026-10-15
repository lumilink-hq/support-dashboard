-- =============================================================================
-- test_loyalty_automations.sql — non-destructive test of 0214 (Phase 1b
-- module 12): bonus campaigns (multiplier, flat, product scope, window,
-- pause, retries, refund clawback), the hourly automations (near_tier,
-- balance_reminder, campaign_started) and the new Klaviyo profile
-- properties. Nothing for the holdout, nothing before treatment_since.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_automations.sql
--
-- To see it FAIL:
--   * in loyalty_apply_campaigns use "if not found then" (drop the
--     loyalty_nudges_for check) -> "campaign: no bonus for the holdout" fails.
--   * in loyalty_campaign_scope_cents drop the least(...) cap on the scoped sum
--     -> "scope: never more than the order" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_prog   uuid;
  v_t      bigint;
  v_h      bigint;
  v_tm     uuid;
  v_hm     uuid;
  v_b      int;
  v_now    timestamptz := now();
  v_at     text := (now() - interval '1 hour')::text;
  v_c1     uuid;
  v_c2     uuid;
  v_n      int;
  v_r      jsonb;
  v_p      jsonb;
begin
  insert into clients (name, slug, is_active) values ('Automations Test', 'automations-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, live_since, discount_code_prefix, enroll_guests, timezone)
  values (v_client, 'automations-test.myshopify.com', 'Wave Rewards', 3, now() - interval '60 days', 'WAVE-', true, 'America/Los_Angeles')
  returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier) values
    (v_prog, 'bronze', 'Bronze', 0, 0, 1.0), (v_prog, 'silver', 'Silver', 1, 50000, 1.1), (v_prog, 'gold', 'Gold', 2, 120000, 1.2);
  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents) values
    (v_prog, 'five_off', '$5 off', 'amount_off_order', 750, 500);

  assert (select holdout_suppressed_kinds @> '{near_tier,balance_reminder,campaign_started}' from loyalty_programs where id = v_prog),
    'settings: new kinds are held back from the holdout by default';
  assert (select klaviyo_names->>'event_near_tier' = 'LL: Near Tier' and klaviyo_names->>'prop_group' = 'LL Group'
            and klaviyo_names->>'event_reward_eligible' = 'Joy: Points Eligible Reward' from loyalty_programs where id = v_prog),
    'settings: new Klaviyo names next to Joy''s';

  for i in 1..2000 loop
    v_b := ((hashtextextended(v_prog::text || ':' || i::text, 0) % 100) + 100) % 100;
    if v_b < 10 and v_h is null then v_h := i;
    elsif v_b >= 10 and v_t is null then v_t := i;
    end if;
    exit when v_h is not null and v_t is not null;
  end loop;
  v_tm := loyalty_enroll_member(v_prog, v_t, 't@example.com', 'Tess', null, now() - interval '60 days');
  v_hm := loyalty_enroll_member(v_prog, v_h, 'h@example.com', 'Hal', null, now() - interval '60 days');

  insert into loyalty_campaigns (program_id, key, name, kind, multiplier, starts_at, ends_at)
  values (v_prog, 'double', 'Double points weekend', 'multiplier', 2.0, now() - interval '1 day', now() + interval '1 day')
  returning id into v_c1;

  -- --- before Phase 1b is live: nothing ---
  perform loyalty_record_order(v_prog, jsonb_build_object('id', 7001, 'processed_at', v_at, 'eligible_cents', 10000,
    'customer', jsonb_build_object('id', v_t, 'email', 't@example.com')), 'webhook');
  assert loyalty_apply_campaigns(v_prog, jsonb_build_object('id', 7001)) = 0, 'campaign: nothing before treatment_since';
  assert (run_loyalty_automations(v_now)->>'near_tier')::int = 0
     and (run_loyalty_automations(v_now)->>'campaign_started')::int = 0, 'automations: nothing before treatment_since';

  update loyalty_programs set treatment_since = now() - interval '2 days' where id = v_prog;

  -- --- multiplier, whole order ---
  perform loyalty_record_order(v_prog, jsonb_build_object('id', 7002, 'processed_at', v_at, 'eligible_cents', 10000,
    'customer', jsonb_build_object('id', v_t, 'email', 't@example.com')), 'webhook');
  assert loyalty_apply_campaigns(v_prog, jsonb_build_object('id', 7002)) = 300, 'campaign: double points = 300 extra on $100 at 3/$';
  assert (select points_earned from loyalty_orders where program_id = v_prog and shopify_order_id = 7002) = 600,
    'campaign: the bonus is part of the order''s points (for refunds)';
  assert exists (select 1 from loyalty_ledger where member_id = v_tm and reason = 'action' and rule_key = 'campaign:double'
                  and source_id = '7002' and note = 'Double points weekend'), 'campaign: ledger entry names the campaign';
  assert loyalty_apply_campaigns(v_prog, jsonb_build_object('id', 7002)) = 0
     and (select points_earned from loyalty_orders where program_id = v_prog and shopify_order_id = 7002) = 600,
    'campaign: a retried delivery awards nothing more';

  -- --- holdout ---
  perform loyalty_record_order(v_prog, jsonb_build_object('id', 7003, 'processed_at', v_at, 'eligible_cents', 10000,
    'customer', jsonb_build_object('id', v_h, 'email', 'h@example.com')), 'webhook');
  assert loyalty_apply_campaigns(v_prog, jsonb_build_object('id', 7003)) = 0, 'campaign: no bonus for the holdout';

  -- --- refund claws the bonus back in proportion ---
  perform loyalty_record_refund(v_prog, 7002, 99001, 5000, now());
  assert (select points_clawed from loyalty_orders where program_id = v_prog and shopify_order_id = 7002) = 300,
    'campaign: a half refund claws back half of base + bonus';

  -- --- window and pause ---
  update loyalty_campaigns set is_active = false where id = v_c1;
  perform loyalty_record_order(v_prog, jsonb_build_object('id', 7004, 'processed_at', v_at, 'eligible_cents', 10000,
    'customer', jsonb_build_object('id', v_t, 'email', 't@example.com')), 'webhook');
  assert loyalty_apply_campaigns(v_prog, jsonb_build_object('id', 7004)) = 0, 'campaign: a paused campaign awards nothing';
  update loyalty_campaigns set is_active = true, starts_at = now() - interval '3 days', ends_at = now() - interval '2 hours' where id = v_c1;
  perform loyalty_record_order(v_prog, jsonb_build_object('id', 7005, 'processed_at', v_at, 'eligible_cents', 10000,
    'customer', jsonb_build_object('id', v_t, 'email', 't@example.com')), 'webhook');
  assert loyalty_apply_campaigns(v_prog, jsonb_build_object('id', 7005)) = 0, 'campaign: an order after the window gets nothing';

  -- --- flat bonus on a product tag ---
  insert into loyalty_campaigns (program_id, key, name, kind, flat_points, min_scope_cents, product_tag, starts_at, ends_at)
  values (v_prog, 'new_arrivals', '+100 on new arrivals', 'flat', 100, 1500, 'New', now() - interval '1 day', now() + interval '1 day')
  returning id into v_c2;
  perform loyalty_record_order(v_prog, jsonb_build_object('id', 7006, 'processed_at', v_at, 'eligible_cents', 5000,
    'customer', jsonb_build_object('id', v_t, 'email', 't@example.com'),
    'line_items', jsonb_build_array(jsonb_build_object('product_id', 111, 'cents', 2000), jsonb_build_object('product_id', 222, 'cents', 3000))), 'webhook');
  assert loyalty_apply_campaigns(v_prog, jsonb_build_object('id', 7006,
    'line_items', jsonb_build_array(jsonb_build_object('product_id', 111, 'cents', 2000)))) = 0,
    'scope: unresolved products award nothing';
  assert jsonb_array_length(loyalty_campaigns_to_resolve(v_prog)) = 1 and loyalty_shopify_has_work(v_prog),
    'scope: an unresolved scoped campaign is work for loyalty-shopify';

  perform loyalty_campaign_resolved(v_c2, array[111, 333]::bigint[]);
  assert jsonb_array_length(loyalty_campaigns_to_resolve(v_prog)) = 0, 'scope: resolved -> not due';
  assert loyalty_campaign_scope_cents(v_c2, '[{"product_id":111,"cents":2000},{"product_id":222,"cents":3000},{"product_id":"x","cents":9}]', 5000) = 2000,
    'scope: only in-scope lines count';
  assert loyalty_campaign_scope_cents(v_c2, '[{"product_id":111,"cents":9000}]', 5000) = 5000, 'scope: never more than the order';
  perform loyalty_record_order(v_prog, jsonb_build_object('id', 7007, 'processed_at', v_at, 'eligible_cents', 5000,
    'customer', jsonb_build_object('id', v_t, 'email', 't@example.com')), 'webhook');
  assert loyalty_apply_campaigns(v_prog, jsonb_build_object('id', 7007, 'line_items',
    '[{"product_id":111,"cents":2000},{"product_id":222,"cents":3000}]'::jsonb)) = 100, 'scope: flat bonus with $20 in scope';
  perform loyalty_record_order(v_prog, jsonb_build_object('id', 7008, 'processed_at', v_at, 'eligible_cents', 5000,
    'customer', jsonb_build_object('id', v_t, 'email', 't@example.com')), 'webhook');
  assert loyalty_apply_campaigns(v_prog, jsonb_build_object('id', 7008, 'line_items',
    '[{"product_id":111,"cents":1000},{"product_id":222,"cents":4000}]'::jsonb)) = 0, 'scope: below min_scope_cents gets nothing';

  perform loyalty_campaign_resolved(v_c2, null, 'boom');
  assert (select products_error = 'boom' and products_resolved_at is not null from loyalty_campaigns where id = v_c2)
     and (select count(*) from loyalty_campaign_products where campaign_id = v_c2) = 2,
    'scope: a failed refresh keeps the last products';
  update loyalty_campaigns set product_tag = 'Sale' where id = v_c2;
  assert (select products_resolved_at is null from loyalty_campaigns where id = v_c2)
     and not exists (select 1 from loyalty_campaign_products where campaign_id = v_c2),
    'scope: a new tag drops the old products';

  begin
    insert into loyalty_campaigns (program_id, key, name, kind, multiplier, flat_points, starts_at, ends_at)
    values (v_prog, 'bad', 'x', 'multiplier', 2, 50, now(), now() + interval '1 day');
    assert false, 'campaign: a multiplier campaign can''t also have flat points';
  exception when check_violation then null;
  end;

  -- --- automations ---
  delete from loyalty_events where program_id = v_prog;
  update loyalty_members set tier_key = 'bronze', tier_spend_cents = 43000, points_balance = 900 where id in (v_tm, v_hm);   -- $70 from Silver (15% = $75)
  update loyalty_campaigns set announced_at = now() where program_id = v_prog;   -- campaign_started is checked below
  v_r := run_loyalty_automations(v_now);
  assert (v_r->>'near_tier')::int = 1 and exists (select 1 from loyalty_events where member_id = v_tm and kind = 'near_tier'
            and payload->>'next_tier' = 'Silver' and (payload->>'remaining_cents')::int = 7000 and payload->>'remaining' = '70.00'),
    format('near_tier: treatment member within 15%% of Silver, got %s', v_r);
  assert not exists (select 1 from loyalty_events where member_id = v_hm), 'automations: nothing for the holdout';
  assert (v_r->>'balance_reminder')::int = 1 and exists (select 1 from loyalty_events where member_id = v_tm and kind = 'balance_reminder'
            and payload->>'reward' = '$5 off' and (payload->>'rewards_affordable')::int = 1),
    'balance_reminder: 900 points covers $5 off, nothing redeemed';
  v_r := run_loyalty_automations(v_now);
  assert (v_r->>'near_tier')::int = 0 and (v_r->>'balance_reminder')::int = 0, 'automations: the next hour sends nothing again';

  update loyalty_members set tier_spend_cents = 40000 where id = v_tm;   -- $100 away: outside 15%
  delete from loyalty_events where program_id = v_prog;
  perform loyalty_post_entry(v_tm, -750, 'redeem', 'auto-r1', 0, null, 'reward', null, null, 'system', now() - interval '3 days');
  v_r := run_loyalty_automations(v_now);
  assert (v_r->>'near_tier')::int = 0, 'near_tier: $100 away is not near';
  assert (v_r->>'balance_reminder')::int = 0, 'balance_reminder: not after a recent redeem';

  update loyalty_campaigns set starts_at = now() - interval '1 hour', ends_at = now() + interval '2 days', announced_at = null, is_active = true
   where id = v_c1;
  v_r := run_loyalty_automations(v_now);
  assert (v_r->>'campaign_started')::int = 1 and exists (select 1 from loyalty_events where member_id = v_tm and kind = 'campaign_started'
            and payload->>'campaign' = 'Double points weekend' and (payload->>'multiplier')::numeric = 2.0),
    format('campaign_started: one event per treated member, got %s', v_r);
  assert (select announced_at is not null from loyalty_campaigns where id = v_c1)
     and (run_loyalty_automations(v_now)->>'campaign_started')::int = 0, 'campaign_started: announced once';
  assert not loyalty_emit_event(v_hm, 'near_tier', 'direct-h'), 'emit: a held-back kind never queues for the holdout';

  -- --- Klaviyo profile properties ---
  update loyalty_members set tier_key = 'silver', tier_spend_cents = 61250, last_order_at = '2026-09-10 12:00-07', last_demoted_at = null
   where id = v_tm;
  v_p := loyalty_klaviyo_properties(v_tm);
  assert v_p->>'LL Group' = 'treatment' and v_p->>'LL Next Tier' = 'Gold' and (v_p->>'LL Spend To Next Tier')::numeric = 587.50,
    format('profile: group, next tier, spend to it, got %s', v_p);
  assert v_p->>'LL Demotion Date' = '2027-03-10', format('profile: demotion date = last order + 6 months, got %s', v_p->>'LL Demotion Date');
  assert v_p->>'Joy Vip tier' = 'Silver', 'profile: Joy''s properties unchanged';
  v_p := loyalty_klaviyo_properties(v_hm);
  assert v_p->>'LL Group' = 'holdout' and v_p->'LL Demotion Date' = 'null'::jsonb and v_p->>'LL Next Tier' = 'Silver',
    'profile: holdout flagged; the entry tier has no demotion date';
  update loyalty_members set tier_key = 'gold' where id = v_tm;
  assert loyalty_klaviyo_properties(v_tm)->'LL Next Tier' = 'null'::jsonb
     and loyalty_klaviyo_properties(v_tm)->'LL Spend To Next Tier' = 'null'::jsonb, 'profile: top tier has no next tier';

  raise notice 'test_loyalty_automations: all assertions passed';
end;
$$;

rollback;
