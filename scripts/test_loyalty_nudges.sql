-- =============================================================================
-- test_loyalty_nudges.sql — non-destructive test of 0212 (Phase 1b module 11):
-- the shop program metafield (public rules only, re-synced when rules or
-- nudges_live change), member sync carries tier spend + group, the versioned
-- definitions, and loyalty_extension_state (guest vs member, order points only
-- for the member's own order, nudges only for treatment once live).
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_nudges.sql
--
-- To see it FAIL:
--   * in loyalty_extension_state drop "and o.member_id = v_m.id"
--     -> "ext: another member's order isn't shown" fails.
--   * in loyalty_nudges_for drop "and loyalty_member_treated(m.id)"
--     -> "nudges: never for the holdout" fails.
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
  v_w      jsonb;
  v_s      jsonb;
  v_m      jsonb;
  v_hash   text;
begin
  insert into clients (name, slug, is_active) values ('Loyalty Nudges Test', 'loyalty-nudges-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, discount_code_prefix)
  values (v_client, 'nudges-test.myshopify.com', 'Wave Rewards', 3, 'WAVE-') returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier) values
    (v_prog, 'bronze', 'Bronze', 0, 0, 1.0), (v_prog, 'silver', 'Silver', 1, 50000, 1.1), (v_prog, 'gold', 'Gold', 2, 120000, 1.2);
  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents) values
    (v_prog, 'five_off', '$5 off', 'amount_off_order', 750, 500),
    (v_prog, 'ten_off', '$10 off', 'amount_off_order', 1500, 1000);
  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents) values
    (v_prog, 'referral_friend', '$10 off your first order', 'amount_off_order', null, 1000);

  -- One treatment and one holdout customer.
  for i in 1..2000 loop
    v_b := ((hashtextextended(v_prog::text || ':' || i::text, 0) % 100) + 100) % 100;
    if v_b < 10 and v_h is null then v_h := i;
    elsif v_b >= 10 and v_t is null then v_t := i;
    end if;
    exit when v_h is not null and v_t is not null;
  end loop;
  v_tm := loyalty_enroll_member(v_prog, v_t, 't@example.com', 'Tess', null, '2026-08-01');
  v_hm := loyalty_enroll_member(v_prog, v_h, 'h@example.com', 'Hal', null, '2026-08-01');
  update loyalty_members set first_name = 'Tess' where id = v_tm;

  assert loyalty_member_group(v_tm) = 'treatment' and loyalty_member_group(v_hm) = 'holdout', 'group: follows the bucket';
  assert loyalty_member_group(gen_random_uuid()) is null, 'group: no member -> null';

  -- --- shop program metafield ---
  v_w := loyalty_shopify_work(v_prog);
  assert (v_w->>'definitions_needed')::boolean, 'definitions: needed on a new program';
  assert v_w->'program_metafield' <> 'null'::jsonb, 'program: never synced -> due';
  v_s := v_w #> '{program_metafield,value}';
  assert (v_s->>'points_per_dollar')::numeric = 3 and v_s->>'code_prefix' = 'WAVE-' and v_s->>'name' = 'Wave Rewards',
    'program: rate, prefix and name';
  assert jsonb_array_length(v_s->'tiers') = 3 and (v_s #>> '{tiers,1,multiplier}')::numeric = 1.1
     and (v_s #>> '{tiers,2,min_spend_cents}')::bigint = 120000, 'program: tiers in rank order with thresholds + multipliers';
  assert jsonb_array_length(v_s->'rewards') = 2 and v_s #>> '{rewards,0,key}' = 'five_off',
    'program: points rewards only (no referral coupon), cheapest first';
  assert not (v_s->>'nudges_live')::boolean, 'program: nudges off until treatment_since';
  assert v_s::text !~ 'example.com' and v_s->'members' is null, 'program: no member data';

  perform loyalty_program_metafield_synced(v_prog, v_w #>> '{program_metafield,hash}');
  perform loyalty_definitions_done(v_prog);
  v_w := loyalty_shopify_work(v_prog);
  assert v_w->'program_metafield' = 'null'::jsonb, 'program: synced -> not due';
  assert not (v_w->>'definitions_needed')::boolean, 'definitions: done -> version 2';

  update loyalty_rewards set points_cost = 700 where program_id = v_prog and key = 'five_off';
  assert loyalty_shopify_work(v_prog)->'program_metafield' <> 'null'::jsonb, 'program: a rule change re-syncs';
  perform loyalty_program_metafield_synced(v_prog, loyalty_shopify_work(v_prog) #>> '{program_metafield,hash}');

  update loyalty_programs set treatment_since = now() - interval '1 minute' where id = v_prog;
  v_w := loyalty_shopify_work(v_prog);
  assert v_w->'program_metafield' <> 'null'::jsonb and (v_w #>> '{program_metafield,value,nudges_live}')::boolean,
    'program: going live re-syncs with nudges_live';
  update loyalty_programs set treatment_since = null where id = v_prog;

  -- 0203 programs already had v1 definitions: they still need v2.
  update loyalty_programs set shopify_definitions_version = 1 where id = v_prog;
  assert (loyalty_shopify_work(v_prog)->>'definitions_needed')::boolean, 'definitions: v1 programs get the new ones';
  perform loyalty_definitions_done(v_prog);

  -- --- member sync ---
  perform loyalty_post_entry(v_tm, 1200, 'order', 'o1', 61250, null, 'shopify_order', '501', null, 'system', '2026-09-10');
  v_m := (select x from jsonb_array_elements(loyalty_members_to_sync(v_prog)->'members') x where x->>'member_id' = v_tm::text);
  assert (v_m->>'tier_spend_cents')::bigint = 61250 and v_m->>'group' = 'treatment' and v_m->>'tier_name' = 'Silver',
    'sync: tier spend, group and tier name are pushed';
  v_m := (select x from jsonb_array_elements(loyalty_members_to_sync(v_prog)->'members') x where x->>'member_id' = v_hm::text);
  assert v_m->>'group' = 'holdout', 'sync: the holdout member is pushed as holdout';
  assert loyalty_shopify_has_work(v_prog), 'sync: unsynced members are work';

  perform loyalty_mark_members_synced((select jsonb_agg(x - 'tier_name' - 'customer_id' - 'tier_changed')
                                         from jsonb_array_elements(loyalty_members_to_sync(v_prog)->'members') x));
  assert jsonb_array_length(loyalty_members_to_sync(v_prog)->'members') = 0, 'sync: nothing left after marking';
  assert not loyalty_shopify_has_work(v_prog), 'sync: no work left';

  update loyalty_members set shopify_synced_spend_cents = 0 where id = v_tm;
  assert jsonb_array_length(loyalty_members_to_sync(v_prog)->'members') = 1, 'sync: a spend change alone re-syncs';
  perform loyalty_mark_members_synced(jsonb_build_array(jsonb_build_object(
    'member_id', v_tm, 'tier_key', 'silver', 'points', 1300, 'tier_spend_cents', 61250, 'group', 'treatment', 'error', 'boom')));
  assert (select shopify_synced_spend_cents = 0 and shopify_sync_error = 'boom' from loyalty_members where id = v_tm),
    'sync: a failed push leaves the synced values alone';

  -- --- extension state ---
  insert into loyalty_orders (program_id, shopify_order_id, member_id, eligible_cents, spend_counted, points_earned, points_clawed, source, processed_at)
  values (v_prog, 501, v_tm, 61250, true, 1200, 200, 'webhook', '2026-09-10'),
         (v_prog, 502, v_hm, 1000, true, 30, 0, 'webhook', '2026-09-11');

  v_s := loyalty_extension_state(v_prog, null, 501);
  assert v_s->'member' = 'null'::jsonb and (v_s->>'rate')::numeric = 3 and v_s->'order' is null,
    'ext: guest gets the entry rate, no member, no order';
  v_s := loyalty_extension_state(v_prog, 424242, null);
  assert v_s->'member' = 'null'::jsonb, 'ext: unknown customer is treated as a guest';

  v_s := loyalty_extension_state(v_prog, v_t, 501);
  assert (v_s #>> '{member,points}')::int = 1200 and v_s #>> '{member,tier}' = 'Silver', 'ext: member points + tier';
  assert (v_s->>'rate')::numeric = 3.3, 'ext: rate at the member''s tier (3 x 1.1)';
  assert (v_s #>> '{order,recorded}')::boolean and (v_s #>> '{order,points_earned}')::int = 1000,
    'ext: own order points, net of clawback';
  assert v_s #>> '{next_tier,name}' = 'Gold' and (v_s #>> '{next_tier,remaining_cents}')::bigint = 58750, 'ext: next tier gap';
  assert v_s #>> '{next_reward,name}' = '$10 off' and (v_s #>> '{next_reward,remaining_points}')::int = 300,
    'ext: next reward is the cheapest one not yet affordable';
  assert not (v_s->>'nudges')::boolean, 'nudges: off before treatment_since';

  v_s := loyalty_extension_state(v_prog, v_t, 502);
  assert v_s #>> '{order,recorded}' = 'false' and v_s #> '{order,points_earned}' = 'null'::jsonb,
    'ext: another member''s order isn''t shown';
  v_s := loyalty_extension_state(v_prog, v_t, 999);
  assert v_s #>> '{order,recorded}' = 'false', 'ext: an order not recorded yet';

  update loyalty_programs set treatment_since = now() - interval '1 minute' where id = v_prog;
  assert (loyalty_extension_state(v_prog, v_t, null)->>'nudges')::boolean, 'nudges: on for treatment once live';
  assert not (loyalty_extension_state(v_prog, v_h, null)->>'nudges')::boolean, 'nudges: never for the holdout';
  update loyalty_programs set treatment_since = now() + interval '1 day' where id = v_prog;
  assert not loyalty_nudges_for(v_tm), 'nudges: a future treatment_since isn''t live yet';

  insert into loyalty_discount_codes (program_id, member_id, reward_key, code, title, value_cents, points_spent, status)
  values (v_prog, v_tm, 'five_off', 'WAVE-NUDG0001', '$5 off', 500, 700, 'issued'),
         (v_prog, v_tm, 'five_off', 'WAVE-NUDG0002', '$5 off', 500, 700, 'used');
  v_s := loyalty_extension_state(v_prog, v_t, null);
  assert jsonb_array_length(v_s->'codes') = 1 and v_s #>> '{codes,0,code}' = 'WAVE-NUDG0001', 'ext: only unused codes';

  update loyalty_members set status = 'excluded' where id = v_tm;
  assert loyalty_extension_state(v_prog, v_t, 501)->'member' = 'null'::jsonb, 'ext: an excluded member sees guest state';

  assert not has_function_privilege('authenticated', 'loyalty_extension_state(uuid, bigint, bigint)', 'execute')
     and not has_function_privilege('anon', 'loyalty_shop_program_json(uuid)', 'execute'),
    'grants: service role only';

  raise notice 'test_loyalty_nudges: all assertions passed';
end;
$$;

rollback;
