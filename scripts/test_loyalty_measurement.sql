-- =============================================================================
-- test_loyalty_measurement.sql — non-destructive test of 0211 (Phase 1b
-- module 9): the holdout split is fixed per customer and about the set
-- percentage, holdout members don't get suppressed event kinds, and
-- loyalty_insights' numbers match a hand-worked example (per group revenue,
-- reward cost, lift, influenced orders, liability, the program's time zone).
-- The staff RPC is staff + MFA only.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_measurement.sql
--
-- To see it FAIL:
--   * in loyalty_insights use "m.holdout_bucket <= v_prog.holdout_percent"
--     -> "split: each member is in the group loyalty_member_treated says" fails.
--   * in loyalty_insights drop "- refunded_cents" from the period revenue
--     -> "insights: treatment revenue is net of refunds" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

create temp table t (k text primary key, v uuid) on commit drop;
grant select on t to authenticated;

do $$
declare
  v_client uuid;
  v_prog   uuid;
  v_prog2  uuid;
  v_ids    bigint[] := '{}';
  v_hold   bigint[] := '{}';
  v_b      int;
  v_m      uuid;
  v_n      int;
  v_frac   numeric;
  v_t1 uuid; v_t2 uuid; v_t3 uuid; v_h1 uuid; v_h2 uuid;
  v_r      jsonb;
  v_led    bigint;
  v_staff  uuid := gen_random_uuid();
begin
  insert into clients (name, slug, is_active) values ('Measurement Test', 'measurement-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, timezone)
  values (v_client, 'measure-test.myshopify.com', 'Wave Rewards', 3, 'America/Los_Angeles') returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents) values
    (v_prog, 'bronze', 'Bronze', 0, 0), (v_prog, 'silver', 'Silver', 1, 50000);
  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents) values
    (v_prog, 'five_off', '$5 off', 'amount_off_order', 750, 500);

  -- --- the split ---
  assert (select holdout_percent from loyalty_programs where id = v_prog) = 10, 'split: 10% by default';
  insert into loyalty_programs (client_id, shop_domain, name) values (v_client, 'measure-two.myshopify.com', 'Two')
  returning id into v_prog2;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents) values (v_prog2, 'bronze', 'Bronze', 0, 0);
  insert into loyalty_members (program_id, shopify_customer_id, tier_key, referral_code)
  select v_prog2, i, 'bronze', 'R' || i from generate_series(1, 4000) i;
  select count(*) filter (where holdout_bucket < 10)::numeric / count(*) into v_frac from loyalty_members where program_id = v_prog2;
  assert v_frac between 0.08 and 0.12, format('split: about 10%% of members are held out, got %s', v_frac);
  assert (select min(holdout_bucket) = 0 and max(holdout_bucket) = 99 from loyalty_members where program_id = v_prog2),
    'split: buckets run 0-99';

  v_r := loyalty_insights(v_prog2, current_date, current_date + 1);
  assert (v_r #>> '{groups,holdout,members}')::int = (select count(*) from loyalty_members where program_id = v_prog2 and not loyalty_member_treated(id))
     and (v_r #>> '{groups,treatment,members}')::int = (select count(*) from loyalty_members where program_id = v_prog2 and loyalty_member_treated(id)),
    'split: each member is in the group loyalty_member_treated says';

  -- Same customer, same bucket after a delete and re-create (e.g. a redact, then they come back).
  select holdout_bucket into v_b from loyalty_members where program_id = v_prog2 and shopify_customer_id = 77;
  delete from loyalty_members where program_id = v_prog2 and shopify_customer_id = 77;
  insert into loyalty_members (program_id, shopify_customer_id, tier_key, referral_code) values (v_prog2, 77, 'bronze', 'R77');
  assert (select holdout_bucket from loyalty_members where program_id = v_prog2 and shopify_customer_id = 77) = v_b,
    'split: a customer always lands in the same bucket';

  -- Pick customer ids: 3 treatment, 2 holdout in the main program.
  for i in 1..2000 loop
    v_b := ((hashtextextended(v_prog::text || ':' || i::text, 0) % 100) + 100) % 100;
    if v_b < 10 and coalesce(array_length(v_hold, 1), 0) < 2 then v_hold := v_hold || i::bigint;
    elsif v_b >= 10 and coalesce(array_length(v_ids, 1), 0) < 3 then v_ids := v_ids || i::bigint;
    end if;
    exit when array_length(v_ids, 1) = 3 and array_length(v_hold, 1) = 2;
  end loop;
  v_t1 := loyalty_enroll_member(v_prog, v_ids[1],  't1@example.com', null, null, '2026-08-01');
  v_t2 := loyalty_enroll_member(v_prog, v_ids[2],  't2@example.com', null, null, '2026-08-01');
  v_t3 := loyalty_enroll_member(v_prog, v_ids[3],  't3@example.com', null, null, '2026-08-01');
  v_h1 := loyalty_enroll_member(v_prog, v_hold[1], 'h1@example.com', null, null, '2026-08-01');
  v_h2 := loyalty_enroll_member(v_prog, v_hold[2], 'h2@example.com', null, null, '2026-08-01');
  -- Enrolled after the period: not in it.
  perform loyalty_enroll_member(v_prog, 999999, 'late@example.com', null, null, '2026-10-05');

  assert loyalty_member_treated(v_t1) and loyalty_member_treated(v_t2) and loyalty_member_treated(v_t3)
     and not loyalty_member_treated(v_h1) and not loyalty_member_treated(v_h2),
    'split: loyalty_member_treated follows the bucket';

  -- --- suppressed kinds ---
  assert loyalty_emit_event(v_h1, 'birthday', 'bd:h1:a'), 'suppress: with nothing listed the holdout gets every event';
  update loyalty_programs set holdout_suppressed_kinds = '{birthday}' where id = v_prog;
  assert not loyalty_emit_event(v_h1, 'birthday', 'bd:h1:b'), 'suppress: a listed kind is not queued for the holdout';
  assert loyalty_emit_event(v_t1, 'birthday', 'bd:t1:b'), 'suppress: a listed kind still goes to treatment';
  assert loyalty_emit_event(v_h1, 'tier_up', 'tu:h1:b'), 'suppress: unlisted kinds still go to the holdout';
  update loyalty_programs set holdout_suppressed_kinds = '{}' where id = v_prog;
  delete from loyalty_events where program_id = v_prog;

  -- --- a September (Pacific) to work by hand ---
  insert into loyalty_orders (program_id, shopify_order_id, member_id, eligible_cents, refunded_cents, spend_counted, source, processed_at) values
    (v_prog, 100, v_t1, 9000,  0,    true, 'webhook', '2026-08-31 12:00-07'),  -- before: only for the gap
    (v_prog, 101, v_t1, 10000, 0,    true, 'webhook', '2026-09-10 12:00-07'),  -- tier up
    (v_prog, 102, v_t1, 7000,  2000, true, 'webhook', '2026-09-20 12:00-07'),  -- $20 refunded; after an email
    (v_prog, 103, v_t2, 3000,  0,    true, 'webhook', '2026-09-15 12:00-07'),  -- $5 reward code
    (v_prog, 104, v_h1, 4000,  0,    true, 'webhook', '2026-09-12 12:00-07'),  -- email 10 days before: outside 7
    (v_prog, 105, v_t3, 5000,  0,    true, 'webhook', '2026-09-30 23:30-07'),  -- 06:30 UTC Oct 1, still September in LA
    (v_prog, 106, v_h2, 6000,  0,    true, 'webhook', '2026-10-01 00:30-07');  -- October in LA

  insert into loyalty_discount_codes (program_id, member_id, reward_key, code, title, value_cents, points_spent, status, used_order_id, used_at)
  values (v_prog, v_t2, 'five_off', 'WAVE-TEST0001', '$5 off', 500, 750, 'used', 103, '2026-09-15 12:00-07');

  insert into loyalty_events (program_id, member_id, kind, dedupe_key, status, sent_at) values
    (v_prog, v_t1, 'reward_eligible', 'e1', 'sent', '2026-09-18 12:00-07'),
    (v_prog, v_h1, 'reward_eligible', 'e2', 'sent', '2026-09-02 12:00-07');

  perform loyalty_post_entry(v_t1, 300, 'order', 'o101', 0, null, 'shopify_order', '101', null, 'system', '2026-09-10 12:00-07');
  select id into v_led from loyalty_ledger where program_id = v_prog and idempotency_key = 'o101';
  insert into loyalty_tier_changes (program_id, member_id, from_tier, to_tier, direction, reason, ledger_id)
  values (v_prog, v_t1, 'bronze', 'silver', 'up', 'spend', v_led);
  perform loyalty_post_entry(v_t2, 1000, 'adjust', 'seed-t2', 0, null, 'staff', null, null, 'test', '2026-08-02');
  perform loyalty_post_entry(v_t2, -750, 'redeem', 'r-t2', 0, null, 'reward', null, null, 'system', '2026-09-14 12:00-07');
  perform loyalty_post_entry(v_h1, 200, 'order', 'o-late', 0, null, 'shopify_order', '106', null, 'system', '2026-10-02');

  insert into t values ('prog', v_prog), ('staff', v_staff);
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at)
  values (v_staff, 'staff@lumilink.example', '{"business_name":"LumiLink"}', now());
  insert into platform_staff (user_id, email) values (v_staff, 'staff@lumilink.example');
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values (gen_random_uuid(), v_staff, 'test', 'totp', 'verified', now(), now(), 'x');

  -- --- revenue basis (no margin set) ---
  v_r := loyalty_insights(v_prog, '2026-09-01', '2026-10-01');
  assert v_r->>'basis' = 'revenue_minus_rewards' and (v_r->>'aa_check')::boolean, 'insights: no margin, no treatment yet';
  assert (v_r #>> '{groups,treatment,members}')::int = 3 and (v_r #>> '{groups,holdout,members}')::int = 2,
    format('insights: members enrolled before the period end, got %s', v_r->'groups');
  assert (v_r #>> '{groups,treatment,orders}')::int = 4 and (v_r #>> '{groups,holdout,orders}')::int = 1,
    'insights: orders by Pacific date (the 23:30 Sep 30 order in, the 00:30 Oct 1 order out)';
  assert (v_r #>> '{groups,treatment,revenue_cents}')::bigint = 23000, format('insights: treatment revenue is net of refunds, got %s', v_r #>> '{groups,treatment,revenue_cents}');
  assert (v_r #>> '{groups,holdout,revenue_cents}')::bigint = 4000, 'insights: holdout revenue';
  assert (v_r #>> '{groups,treatment,reward_cost_cents}')::bigint = 500, 'insights: reward cost = used code value';
  assert (v_r #>> '{groups,treatment,buyers}')::int = 3 and (v_r #>> '{groups,treatment,repeat_rate}')::numeric = 0.3333,
    'insights: buyers and repeat rate';
  assert (v_r #>> '{groups,treatment,aov_cents}')::numeric = 5750, 'insights: AOV';
  assert (v_r #>> '{groups,holdout,purchase_rate}')::numeric = 0.5, 'insights: purchase rate';
  -- t1: Aug 31 -> Sep 10 (10 days), Sep 10 -> Sep 20 (10 days)
  assert (v_r #>> '{groups,treatment,avg_days_between_orders}')::numeric = 10.0, format('insights: days between orders, got %s', v_r #>> '{groups,treatment,avg_days_between_orders}');
  assert (v_r #>> '{groups,treatment,points_issued}')::int = 300 and (v_r #>> '{groups,treatment,points_redeemed}')::int = 750,
    'insights: points issued (not adjustments) and redeemed';
  -- value per member: t1 15000, t2 3000-500, t3 5000 -> 7500; h1 4000, h2 0 -> 2000
  assert (v_r #>> '{groups,treatment,value_per_member_cents}')::numeric = 7500
     and (v_r #>> '{groups,holdout,value_per_member_cents}')::numeric = 2000, 'insights: value per member';
  assert (v_r #>> '{lift,per_member_cents}')::numeric = 5500 and (v_r #>> '{lift,incremental_total_cents}')::numeric = 16500,
    format('insights: lift, got %s', v_r->'lift');
  assert (v_r #>> '{lift,low_cents}')::numeric < 5500 and (v_r #>> '{lift,high_cents}')::numeric > 5500,
    'insights: the range brackets the lift';
  assert not (v_r #>> '{lift,significant}')::boolean, 'insights: 5 members can''t be significant';
  assert (v_r #>> '{influenced,treatment,orders}')::int = 3 and (v_r #>> '{influenced,treatment,reward_code}')::int = 1
     and (v_r #>> '{influenced,treatment,after_email}')::int = 1 and (v_r #>> '{influenced,treatment,tier_up}')::int = 1
     and (v_r #>> '{influenced,treatment,revenue_cents}')::bigint = 18000,
    format('insights: influenced orders, got %s', v_r->'influenced');
  assert (v_r #>> '{influenced,holdout,orders}')::int = 0, 'insights: an email outside the window doesn''t count';
  -- ledger before Oct 1 (Pacific): 300 + 1000 - 750 = 550 points; at $5 per 750 = 367 cents
  assert (v_r #>> '{liability,points}')::int = 550 and (v_r #>> '{liability,cents}')::int = 367,
    format('insights: liability, got %s', v_r->'liability');

  -- --- profit basis, treatment live ---
  update loyalty_programs set gross_margin_pct = 50, treatment_since = '2026-08-15' where id = v_prog;
  v_r := loyalty_insights(v_prog, '2026-09-01', '2026-10-01');
  -- t1 7500, t2 1500-500, t3 2500 -> 3666.67; h1 2000, h2 0 -> 1000
  assert v_r->>'basis' = 'gross_profit_minus_rewards' and not (v_r->>'aa_check')::boolean, 'insights: margin + treatment live';
  assert (v_r #>> '{lift,per_member_cents}')::numeric = 2666.67 and (v_r #>> '{lift,incremental_total_cents}')::numeric = 8000,
    format('insights: lift on gross profit, got %s', v_r->'lift');

  begin
    perform loyalty_insights(v_prog, '2026-10-01', '2026-09-01');
    assert false, 'insights: a backwards period is refused';
  exception when raise_exception then null;
  end;
end $$;

-- --- staff RPC ---
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
declare v_ok boolean;
begin
  begin
    perform loyalty_staff_insights((select v from t where k = 'prog'), '2026-09-01', '2026-10-01');
    v_ok := false;
  exception when insufficient_privilege then v_ok := sqlerrm = 'not_staff';
  end;
  assert v_ok, 'staff: not staff is refused';
  begin
    perform loyalty_insights((select v from t where k = 'prog'), '2026-09-01', '2026-10-01');
    v_ok := false;
  exception when insufficient_privilege then v_ok := sqlerrm like 'permission denied for function%';
  end;
  assert v_ok, 'staff: the raw function isn''t callable by signed-in users';
end $$;
reset role;

select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'staff'), 'aal', 'aal1')::text, true);
set local role authenticated;
do $$
declare v_ok boolean;
begin
  begin
    perform loyalty_staff_insights((select v from t where k = 'prog'), '2026-09-01', '2026-10-01');
    v_ok := false;
  exception when insufficient_privilege then v_ok := sqlerrm = 'mfa_required';
  end;
  assert v_ok, 'staff: a password-only session is refused';
end $$;
reset role;

select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'staff'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
declare
  v_r jsonb;
begin
  v_r := loyalty_staff_insights((select v from t where k = 'prog'), '2026-09-01', '2026-10-01', 'month');
  assert jsonb_array_length(v_r->'series') = 1 and (v_r #>> '{series,0,revenue_cents}')::bigint = 27000
     and (v_r #>> '{summary,lift,per_member_cents}')::numeric = 2666.67
     and (v_r #>> '{series,0,treatment_value_per_member_cents}')::numeric = 3666.67
     and (v_r #>> '{series,0,holdout_value_per_member_cents}')::numeric = 1000
     and (v_r #>> '{series,0,liability_points}')::int = 550,
    format('staff: monthly series + summary, got %s', v_r->'series');
  v_r := loyalty_staff_insights((select v from t where k = 'prog'), '2026-09-01', '2026-10-01', 'week');
  -- weeks start Monday: Aug 31, Sep 7, 14, 21, 28 -> 5 buckets, clipped to the period
  assert jsonb_array_length(v_r->'series') = 5 and v_r #>> '{series,0,from}' = '2026-09-01'
     and v_r #>> '{series,4,to}' = '2026-10-01', format('staff: weekly series, got %s', v_r->'series');
  assert (select sum((s->>'revenue_cents')::bigint) from jsonb_array_elements(v_r->'series') s) = 27000,
    'staff: weekly buckets add up to the period';
end $$;
reset role;

rollback;
