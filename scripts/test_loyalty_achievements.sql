-- =============================================================================
-- test_loyalty_achievements.sql — non-destructive test of 0216 (Phase 1b
-- module 13): order lines and product types, each badge kind, the monthly
-- streak and its reminder, the four challenge kinds, the storefront view and
-- the staff challenge RPCs. Nothing for the holdout, nothing before
-- treatment_since.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_achievements.sql
--
-- To see it FAIL:
--   * in loyalty_evaluate_member use "if not found then" (drop the
--     loyalty_nudges_for check) -> "badges: nothing for the holdout" fails.
--   * in loyalty_member_streak drop "and refunded_cents < eligible_cents"
--     -> "streak: a fully refunded order doesn't count" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

create temp table t (k text primary key, v uuid) on commit drop;
grant select, insert on t to authenticated;

do $$
declare
  v_client uuid;
  v_prog   uuid;
  v_ids    bigint[] := '{}';
  v_h      bigint;
  v_b      int;
  v_tm     uuid;
  v_t2     uuid;
  v_t3     uuid;
  v_hm     uuid;
  v_r      jsonb;
  v_a      jsonb;
  v_s      jsonb;
  v_ch1    uuid;
  v_ch2    uuid;
  v_ch3    uuid;
  v_ch4    uuid;
  v_oid    bigint := 9000;
  v_month0 timestamptz := date_trunc('month', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles';
  v_at     timestamptz := greatest(v_month0 + interval '1 hour', now() - interval '1 hour');
begin
  insert into clients (name, slug, is_active) values ('Achievements Test', 'achievements-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, live_since, enroll_guests, timezone)
  values (v_client, 'achievements-test.myshopify.com', 'Wave Rewards', 3, now() - interval '200 days', true, 'America/Los_Angeles')
  returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier) values (v_prog, 'bronze', 'Bronze', 0, 0, 1.0);
  insert into loyalty_earn_rules (program_id, key, kind, points, order_count, claimable) values
    (v_prog, 'order_1', 'milestone', 100, 1, false), (v_prog, 'order_10', 'milestone', 300, 10, false);
  perform loyalty_seed_default_badges(v_prog);

  assert (select count(*) from loyalty_badges where program_id = v_prog) = 7
     and (select count(*) from loyalty_badges where program_id = v_prog and kind = 'milestone' and points = 0) = 2
     and (select name from loyalty_badges where program_id = v_prog and key = 'order_1') = 'First order',
    'seed: five badges plus the milestones (no extra points)';
  assert (select holdout_suppressed_kinds @> '{badge_earned,challenge_started,challenge_completed,streak_ending}'
            and klaviyo_names->>'event_badge_earned' = 'LL: Badge Earned' from loyalty_programs where id = v_prog),
    'seed: new kinds held back from the holdout, Klaviyo names set';

  for i in 1..5000 loop
    v_b := ((hashtextextended(v_prog::text || ':' || i::text, 0) % 100) + 100) % 100;
    if v_b < 10 and v_h is null then v_h := i;
    elsif v_b >= 10 and coalesce(array_length(v_ids, 1), 0) < 3 then v_ids := v_ids || i::bigint;
    end if;
    exit when v_h is not null and array_length(v_ids, 1) = 3;
  end loop;
  v_tm := loyalty_enroll_member(v_prog, v_ids[1], 't@example.com', 'Tess', null, now() - interval '200 days');
  v_t2 := loyalty_enroll_member(v_prog, v_ids[2], 't2@example.com', null, null, now() - interval '200 days');
  v_t3 := loyalty_enroll_member(v_prog, v_ids[3], 't3@example.com', null, null, now() - interval '200 days');
  v_hm := loyalty_enroll_member(v_prog, v_h, 'h@example.com', null, null, now() - interval '200 days');

  -- --- before Phase 1b is live: nothing ---
  perform loyalty_record_order(v_prog, jsonb_build_object('id', 8999, 'processed_at', (now() - interval '2 hours')::text, 'eligible_cents', 12000,
    'customer', jsonb_build_object('id', v_ids[1], 'email', 't@example.com')), 'webhook');
  v_r := loyalty_after_order(v_prog, '{"id":8999,"line_items":[{"product_id":1,"cents":12000}]}');
  assert v_r->'badges' = '[]'::jsonb and not exists (select 1 from loyalty_member_badges where member_id = v_tm),
    'badges: nothing before treatment_since';
  assert (select count(*) from loyalty_order_lines where shopify_order_id = 8999) = 1, 'lines: stored even before go-live (for categories)';
  delete from loyalty_orders where program_id = v_prog and shopify_order_id = 8999;   -- start the live part clean

  update loyalty_programs set treatment_since = now() - interval '1 day' where id = v_prog;

  -- --- big basket + lines ---
  v_oid := v_oid + 1;
  perform loyalty_record_order(v_prog, jsonb_build_object('id', v_oid, 'processed_at', v_at::text, 'eligible_cents', 12000,
    'customer', jsonb_build_object('id', v_ids[1], 'email', 't@example.com')), 'webhook');
  v_r := loyalty_after_order(v_prog, jsonb_build_object('id', v_oid, 'line_items',
    '[{"product_id":1,"cents":7000},{"product_id":2,"cents":3000},{"product_id":2,"cents":2000}]'::jsonb));
  assert v_r->'badges' = '["big_basket"]'::jsonb, format('big_basket: a $120 order, got %s', v_r);
  assert (select cents from loyalty_order_lines where shopify_order_id = v_oid and product_id = 2) = 5000, 'lines: summed per product';
  assert exists (select 1 from loyalty_ledger where member_id = v_tm and reason = 'action' and rule_key = 'badge:big_basket' and points = 150),
    'big_basket: +150 in the ledger';
  assert exists (select 1 from loyalty_events where member_id = v_tm and kind = 'badge_earned' and payload->>'badge' = 'Big basket'),
    'big_basket: badge_earned event queued';
  assert (loyalty_after_order(v_prog, jsonb_build_object('id', v_oid))->'badges') = '[]'::jsonb
     and (select count(*) from loyalty_ledger where member_id = v_tm and rule_key = 'badge:big_basket') = 1,
    'badges: earned once (a retried delivery adds nothing)';

  -- --- explorer: types looked up after the order ---
  assert loyalty_products_to_fetch(v_prog) @> '{1,2}'::bigint[] and loyalty_shopify_has_work(v_prog), 'types: unknown products are work';
  perform loyalty_products_fetched(v_prog, '[{"product_id":1,"product_type":"Glass"},{"product_id":2,"product_type":"Papers"}]');
  assert not exists (select 1 from loyalty_member_badges mb join loyalty_badges b on b.id = mb.badge_id
                      where mb.member_id = v_tm and b.key = 'explorer'), 'explorer: 2 types is not 3';
  v_oid := v_oid + 1;
  perform loyalty_record_order(v_prog, jsonb_build_object('id', v_oid, 'processed_at', v_at::text, 'eligible_cents', 2000,
    'customer', jsonb_build_object('id', v_ids[1], 'email', 't@example.com')), 'webhook');
  perform loyalty_after_order(v_prog, jsonb_build_object('id', v_oid, 'line_items', '[{"product_id":3,"cents":1500},{"product_id":4,"cents":500}]'::jsonb));
  perform loyalty_products_fetched(v_prog, '[{"product_id":3,"product_type":"Lighters"},{"product_id":4,"product_type":""}]');
  assert exists (select 1 from loyalty_member_badges mb join loyalty_badges b on b.id = mb.badge_id
                  where mb.member_id = v_tm and b.key = 'explorer'), 'explorer: the third type, found after the lookup, earns it';
  assert (select count(*) from loyalty_member_categories(v_tm)) = 3, 'types: a product without a type is no category';

  -- --- holdout ---
  v_oid := v_oid + 1;
  perform loyalty_record_order(v_prog, jsonb_build_object('id', v_oid, 'processed_at', v_at::text, 'eligible_cents', 15000,
    'customer', jsonb_build_object('id', v_h, 'email', 'h@example.com')), 'webhook');
  perform loyalty_after_order(v_prog, jsonb_build_object('id', v_oid, 'line_items', '[{"product_id":1,"cents":15000}]'::jsonb));
  assert not exists (select 1 from loyalty_member_badges where member_id = v_hm), 'badges: nothing for the holdout';
  assert loyalty_storefront_achievements(v_prog, v_h) is null, 'storefront: nothing shown to the holdout';

  -- --- streak ---
  insert into loyalty_orders (program_id, shopify_order_id, member_id, eligible_cents, refunded_cents, spend_counted, source, processed_at) values
    (v_prog, 7101, v_t2, 3000, 0,    true, 'backfill', v_month0 - interval '2 months' + interval '3 days'),
    (v_prog, 7102, v_t2, 3000, 0,    true, 'backfill', v_month0 - interval '1 month' + interval '3 days'),
    (v_prog, 7103, v_t2, 3000, 3000, true, 'backfill', v_month0 - interval '3 months' + interval '3 days');   -- fully refunded
  update loyalty_members set last_order_at = v_month0 - interval '1 month' + interval '3 days' where id = v_t2;
  v_s := loyalty_member_streak(v_t2);
  assert (v_s->>'months')::int = 2 and not (v_s->>'this_month')::boolean
     and (v_s->>'keep_by')::date = ((v_month0 at time zone 'America/Los_Angeles')::date + interval '1 month')::date - 1,
    format('streak: 2 months, keep it by the end of this month, got %s', v_s);
  assert (loyalty_evaluate_member(v_t2)->'badges') = '[]'::jsonb, 'streak: history alone earns nothing (needs an order after go-live)';

  -- streak_ending: the last week of this month, on a 2-month streak with no order yet
  v_a := run_loyalty_automations((v_month0 + interval '1 month') - interval '3 days');
  assert (v_a->>'streak_ending')::int = 1 and exists (select 1 from loyalty_events where member_id = v_t2 and kind = 'streak_ending'
            and (payload->>'streak_months')::int = 2), format('streak_ending: sent in the last week, got %s', v_a);
  assert (run_loyalty_automations((v_month0 + interval '1 month') - interval '2 days')->>'streak_ending')::int = 0,
    'streak_ending: once a month';
  assert (run_loyalty_automations(v_month0 + interval '10 days')->>'streak_ending')::int = 0, 'streak_ending: not mid-month';

  v_oid := v_oid + 1;
  perform loyalty_record_order(v_prog, jsonb_build_object('id', v_oid, 'processed_at', v_at::text, 'eligible_cents', 3000,
    'customer', jsonb_build_object('id', v_ids[2], 'email', 't2@example.com')), 'webhook');
  v_r := loyalty_after_order(v_prog, jsonb_build_object('id', v_oid));
  assert v_r->'badges' = '["on_a_roll"]'::jsonb, format('on_a_roll: 3 months in a row, got %s', v_r);
  assert (loyalty_member_streak(v_t2)->>'months')::int = 3 and (loyalty_member_streak(v_t2)->>'this_month')::boolean,
    'streak: a fully refunded order doesn''t count';

  -- --- ambassador ---
  insert into loyalty_referrals (program_id, referrer_id, friend_email, friend_email_norm, status, completed_at, shopify_order_id) values
    (v_prog, v_t3, 'f1@example.com', 'f1@example.com', 'completed', now() - interval '300 days', 1),
    (v_prog, v_t3, 'f2@example.com', 'f2@example.com', 'completed', now() - interval '300 days', 2);
  assert (loyalty_evaluate_member(v_t3)->'badges') = '[]'::jsonb, 'ambassador: 2 is not 3';
  -- The third friend's order completes a referral: after_order evaluates the referrer too.
  v_oid := v_oid + 1;
  insert into loyalty_referrals (program_id, referrer_id, friend_email, friend_email_norm, status, completed_at, shopify_order_id) values
    (v_prog, v_t3, 'f3@example.com', 'f3@example.com', 'completed', now(), v_oid);
  perform loyalty_record_order(v_prog, jsonb_build_object('id', v_oid, 'processed_at', v_at::text, 'eligible_cents', 2000,
    'customer', jsonb_build_object('id', 777001, 'email', 'f3@example.com')), 'webhook');
  perform loyalty_after_order(v_prog, jsonb_build_object('id', v_oid));
  assert exists (select 1 from loyalty_member_badges mb join loyalty_badges b on b.id = mb.badge_id
                  where mb.member_id = v_t3 and b.key = 'ambassador'), 'ambassador: the friend''s order earns it for the referrer';

  -- --- challenges ---
  insert into loyalty_challenges (program_id, key, name, kind, target, points, starts_at, ends_at)
  values (v_prog, 'two_orders', 'Order twice', 'order_count', 2, 200, now() - interval '1 day', now() + interval '5 days') returning id into v_ch1;
  insert into loyalty_challenges (program_id, key, name, kind, target, points, starts_at, ends_at)
  values (v_prog, 'spend_50', 'Spend $50', 'spend', 5000, 150, now() - interval '1 day', now() + interval '5 days') returning id into v_ch2;
  insert into loyalty_challenges (program_id, key, name, kind, target, points, starts_at, ends_at)
  values (v_prog, 'try_new', 'Try a new category', 'new_categories', 1, 100, v_at - interval '1 minute', now() + interval '5 days') returning id into v_ch3;
  insert into loyalty_challenges (program_id, key, name, kind, target, points, starts_at, ends_at, product_tag)
  values (v_prog, 'new_arrival', 'Buy a new arrival', 'tagged_product', 1, 100, now() - interval '1 day', now() + interval '5 days', 'New') returning id into v_ch4;

  assert loyalty_challenge_progress(v_tm, v_ch1) = 2 and loyalty_challenge_progress(v_tm, v_ch2) = 14000,
    'challenge: order count and spend in the window';
  v_r := loyalty_evaluate_member(v_tm);
  assert v_r->'challenges' @> '["two_orders","spend_50"]'::jsonb and not (v_r->'challenges' @> '["new_arrival"]'::jsonb),
    format('challenge: completed when the target is met; a tag challenge waits for its products, got %s', v_r);
  assert (select count(*) from loyalty_ledger where member_id = v_tm and rule_key in ('challenge:two_orders', 'challenge:spend_50')) = 2
     and (loyalty_evaluate_member(v_tm)->'challenges') = '[]'::jsonb, 'challenge: points once';
  assert exists (select 1 from loyalty_events where member_id = v_tm and kind = 'challenge_completed' and payload->>'challenge' = 'Order twice'),
    'challenge: challenge_completed event queued';
  -- Tess's window started just before her two orders: Glass/Papers/Lighters are all new in it.
  assert loyalty_challenge_progress(v_tm, v_ch3) = 3, 'challenge: categories new in the window';

  assert jsonb_array_length(loyalty_challenges_to_resolve(v_prog)) = 1, 'challenge: tag scope is work for loyalty-shopify';
  perform loyalty_challenge_resolved(v_ch4, array[3]::bigint[]);
  assert (loyalty_evaluate_member(v_tm)->'challenges') = '["new_arrival"]'::jsonb, 'challenge: tagged product completes once resolved';

  -- challenge_started announcement (treated members only)
  v_a := run_loyalty_automations(now());
  -- Treated members: the three above plus the referred friend, enrolled by their order (if not in the holdout).
  assert (v_a->>'challenge_started')::int = 4 * (select count(*) from loyalty_members where program_id = v_prog and loyalty_member_treated(id))
     and not exists (select 1 from loyalty_events where member_id = v_hm and kind = 'challenge_started'),
    format('challenge_started: 4 challenges x every treated member, none for the holdout, got %s', v_a);
  assert (run_loyalty_automations(now())->>'challenge_started')::int = 0, 'challenge_started: once';

  -- --- storefront ---
  v_s := loyalty_storefront_achievements(v_prog, v_ids[1]);
  assert (select count(*) from jsonb_array_elements(v_s->'badges') b where (b->>'earned')::boolean) = 3,
    format('storefront: Big basket, Explorer and First order earned, got %s', v_s->'badges');
  -- 3 paid orders counted (the pre-launch one included: its ledger entry stays when the order row is removed above).
  assert (select b->'progress' from jsonb_array_elements(v_s->'badges') b where b->>'key' = 'order_10') = '{"have": 3, "need": 10}'::jsonb,
    format('storefront: milestone progress from the order count, got %s', v_s->'badges');
  assert jsonb_array_length(v_s->'challenges') = 4 and (v_s->'streak'->>'months')::int = 1, 'storefront: challenges and streak';
  assert loyalty_storefront_achievements(v_prog, null) is null, 'storefront: logged out sees nothing';

  insert into t values ('prog', v_prog);
end $$;

-- --- staff RPCs ---
do $$
declare v_staff uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at)
  values (v_staff, 'staff@lumilink.example', '{"business_name":"LumiLink"}', now());
  insert into platform_staff (user_id, email) values (v_staff, 'staff@lumilink.example');
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values (gen_random_uuid(), v_staff, 'test', 'totp', 'verified', now(), now(), 'x');
  insert into t values ('staff', v_staff);
end $$;
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'staff'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
declare
  v_prog uuid := (select v from t where k = 'prog');
  v_id   uuid;
  v_l    jsonb;
  v_ok   boolean;
  v_start text := to_char((now() + interval '1 day') at time zone 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI');
  v_end   text := to_char((now() + interval '8 days') at time zone 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI');
begin
  v_id := loyalty_staff_challenge_save(v_prog, null, jsonb_build_object('name', 'Spend $150 this week', 'kind', 'spend',
    'target', '15000', 'points', '300', 'starts_local', v_start, 'ends_local', v_end, 'product_tag', 'ignored'));
  v_l := loyalty_staff_challenges(v_prog);
  assert (select x->>'status' = 'upcoming' and x->'product_tag' = 'null'::jsonb and (x->>'target')::int = 15000
            from jsonb_array_elements(v_l->'challenges') x where x->>'id' = v_id::text),
    'staff: create; a scope only applies to tagged-product challenges';
  assert (select (x->>'completed')::int = 1 from jsonb_array_elements(v_l->'challenges') x where x->>'key' = 'two_orders')
     and (select (x->>'earned')::int = 1 from jsonb_array_elements(v_l->'badges') x where x->>'key' = 'big_basket'),
    'staff: completions and badge counts';
  begin
    perform loyalty_staff_challenge_save(v_prog, null, jsonb_build_object('name', 'No scope', 'kind', 'tagged_product',
      'target', '1', 'points', '50', 'starts_local', v_start, 'ends_local', v_end));
    v_ok := false;
  exception when raise_exception then v_ok := sqlerrm like '%needs a tag or a collection%';
  end;
  assert v_ok, 'staff: a tagged-product challenge needs a scope';
  begin
    perform loyalty_staff_challenge_save(v_prog, (select (x->>'id')::uuid from jsonb_array_elements(v_l->'challenges') x where x->>'key' = 'two_orders'),
      jsonb_build_object('name', 'Order twice', 'kind', 'order_count', 'target', '1', 'points', '200',
        'starts_local', (select x->>'starts_local' from jsonb_array_elements(v_l->'challenges') x where x->>'key' = 'two_orders'),
        'ends_local', v_end));
    v_ok := false;
  exception when raise_exception then v_ok := sqlerrm like '%has started%';
  end;
  assert v_ok, 'staff: a started challenge''s target can''t change';
  assert loyalty_staff_challenge_set_active(v_id, false), 'staff: pause';
end $$;
reset role;

do $$
begin
  assert (select count(*) from loyalty_access_log where action = 'challenge_save') = 1
     and (select count(*) from loyalty_access_log where action = 'challenge_active') = 1, 'staff: changes logged';
  raise notice 'test_loyalty_achievements: all assertions passed';
end $$;

rollback;
