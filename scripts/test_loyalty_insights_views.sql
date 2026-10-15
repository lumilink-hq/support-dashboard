-- =============================================================================
-- test_loyalty_insights_views.sql — non-destructive test of 0213 (Phase 1b
-- module 10): per-tier and redemption numbers for staff, and the client
-- results RPC: the caller's own workspace only, aggregates only, no
-- extra-revenue claim while measuring, ROI once live.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_insights_views.sql
--
-- To see it FAIL:
--   * in loyalty_client_results use "where is_active" without the client_id filter
--     -> "client: another workspace sees nothing" fails.
--   * in loyalty_client_results drop "v_measuring or" from the extra case
--     -> "client: no extra-revenue claim while measuring" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

create temp table t (k text primary key, v uuid) on commit drop;
grant select on t to authenticated;

do $$
declare
  v_owner  uuid := gen_random_uuid();
  v_other  uuid := gen_random_uuid();
  v_staff  uuid := gen_random_uuid();
  v_client uuid;
  v_prog   uuid;
  v_ids    bigint[] := '{}';
  v_hold   bigint[] := '{}';
  v_b      int;
  v_t1 uuid; v_t2 uuid; v_t3 uuid; v_h1 uuid; v_h2 uuid;
  v_d      jsonb;
begin
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at)
  values (v_owner, 'owner@views.example', '{"business_name":"Views Store"}', now()),
         (v_other, 'owner@other.example', '{"business_name":"Other Store"}', now()),
         (v_staff, 'staff@lumilink.example', '{"business_name":"LumiLink"}', now());
  insert into platform_staff (user_id, email) values (v_staff, 'staff@lumilink.example');
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values (gen_random_uuid(), v_staff, 'test', 'totp', 'verified', now(), now(), 'x');

  select client_id into v_client from users where id = v_owner;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, timezone)
  values (v_client, 'views-test.myshopify.com', 'Wave Rewards', 3, 'America/Los_Angeles') returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents) values
    (v_prog, 'bronze', 'Bronze', 0, 0), (v_prog, 'silver', 'Silver', 1, 50000);
  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents) values
    (v_prog, 'five_off', '$5 off', 'amount_off_order', 750, 500);

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
  update loyalty_members set tier_key = 'silver' where id = v_t1;

  -- September (Pacific): t1 $150 (silver), t2 $30 with a $5 code, t3 $50, h1 $40.
  insert into loyalty_orders (program_id, shopify_order_id, member_id, eligible_cents, refunded_cents, spend_counted, source, processed_at) values
    (v_prog, 201, v_t1, 10000, 0,    true, 'webhook', '2026-09-10 12:00-07'),
    (v_prog, 202, v_t1, 7000,  2000, true, 'webhook', '2026-09-20 12:00-07'),
    (v_prog, 203, v_t2, 3000,  0,    true, 'webhook', '2026-09-15 12:00-07'),
    (v_prog, 204, v_t3, 5000,  0,    true, 'webhook', '2026-09-30 23:30-07'),
    (v_prog, 205, v_h1, 4000,  0,    true, 'webhook', '2026-09-12 12:00-07'),
    (v_prog, 206, v_h2, 6000,  0,    true, 'webhook', '2026-10-01 00:30-07');   -- October
  insert into loyalty_discount_codes (program_id, member_id, reward_key, code, title, value_cents, points_spent, status, used_order_id, used_at, created_at)
  values (v_prog, v_t2, 'five_off', 'WAVE-VIEW0001', '$5 off', 500, 750, 'used', 203, '2026-09-15 12:00-07', '2026-09-14 12:00-07'),
         (v_prog, v_t3, 'five_off', 'WAVE-VIEW0002', '$5 off', 500, 750, 'issued', null, null, '2026-09-20 12:00-07');
  perform loyalty_post_entry(v_t1, 450, 'order', 'v201', 0, null, 'shopify_order', '201', null, 'system', '2026-09-10 12:00-07');
  perform loyalty_post_entry(v_t2, 2000, 'adjust', 'v-seed', 0, null, 'staff', null, null, 'test', '2026-08-02');
  perform loyalty_post_entry(v_t2, -750, 'redeem', 'v-r1', 0, null, 'reward', null, null, 'system', '2026-09-14 12:00-07');
  perform loyalty_post_entry(v_t3, 1000, 'adjust', 'v-seed3', 0, null, 'staff', null, null, 'test', '2026-08-02');
  perform loyalty_post_entry(v_t3, -750, 'redeem', 'v-r2', 0, null, 'reward', null, null, 'system', '2026-09-20 12:00-07');
  perform loyalty_post_entry(v_h1, 1050, 'order', 'v205', 0, null, 'shopify_order', '205', null, 'system', '2026-09-12 12:00-07');

  -- --- staff detail (internal function) ---
  v_d := loyalty_insights_detail(v_prog, '2026-09-01', '2026-10-01');
  assert v_d #>> '{tiers,0,key}' = 'bronze' and (v_d #>> '{tiers,0,members}')::int = 4 and (v_d #>> '{tiers,1,members}')::int = 1,
    format('detail: members per current tier, got %s', v_d->'tiers');
  assert (v_d #>> '{tiers,1,revenue_cents}')::bigint = 15000 and (v_d #>> '{tiers,0,revenue_cents}')::bigint = 12000,
    'detail: period revenue per tier, net of refunds (Oct 1 Pacific order out)';
  assert (v_d #>> '{tiers,0,buyers}')::int = 3, 'detail: buyers per tier';
  assert (v_d #>> '{redemptions,codes_created}')::int = 2 and (v_d #>> '{redemptions,codes_used}')::int = 1,
    'detail: codes created and used in the period';
  assert (v_d #>> '{redemptions,points_issued}')::int = 1500 and (v_d #>> '{redemptions,points_redeemed}')::int = 1500
     and (v_d #>> '{redemptions,redemption_rate}')::numeric = 1.0,
    format('detail: points issued (not adjustments) vs redeemed, got %s', v_d->'redemptions');

  insert into t values ('owner', v_owner), ('other', v_other), ('staff', v_staff), ('prog', v_prog);
end $$;

-- --- the store's owner: own results, aggregates only, measuring ---
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'owner'), true);
set local role authenticated;
do $$
declare v_r jsonb; v_ok boolean;
begin
  assert loyalty_client_has_program(), 'client: the store has a program';
  v_r := loyalty_client_results('2026-09-01', '2026-10-01');
  assert v_r->>'program' = 'Wave Rewards' and (v_r->>'members')::int = 5 and (v_r->>'buyers')::int = 4
     and (v_r->>'orders')::int = 5, format('client: activity totals, got %s', v_r);
  assert (v_r->>'revenue_cents')::bigint = 27000 and (v_r->>'reward_cost_cents')::bigint = 500
     and (v_r->>'redemptions')::int = 1, 'client: revenue, reward cost, redemptions';
  assert (v_r->>'measuring')::boolean and v_r->'extra' = 'null'::jsonb, 'client: no extra-revenue claim while measuring';
  assert v_r::text !~ '@' and v_r::text !~ 'WAVE-' and v_r->'groups' is null and v_r->'tiers' is null,
    'client: no emails, codes or member-level data';

  begin
    perform loyalty_staff_insights_detail((select v from t where k = 'prog'), '2026-09-01', '2026-10-01');
    v_ok := false;
  exception when insufficient_privilege then v_ok := sqlerrm = 'not_staff';
  end;
  assert v_ok, 'staff detail: a store owner is not staff';
  begin
    perform loyalty_insights_detail((select v from t where k = 'prog'), '2026-09-01', '2026-10-01');
    v_ok := false;
  exception when insufficient_privilege then v_ok := true;
  end;
  assert v_ok, 'detail: the internal function isn''t callable from the browser';
  begin
    perform loyalty_client_results('2026-10-01', '2026-09-01');
    v_ok := false;
  exception when raise_exception then v_ok := true;
  end;
  assert v_ok, 'client: a backwards period is refused';
end $$;
reset role;

-- --- treatment live: extra revenue and ROI ---
update loyalty_programs set treatment_since = '2026-08-15', gross_margin_pct = 50 where id = (select v from t where k = 'prog');
set local role authenticated;
do $$
declare v_r jsonb; v_i jsonb;
begin
  v_r := loyalty_client_results('2026-09-01', '2026-10-01');
  assert not (v_r->>'measuring')::boolean and v_r->'extra' <> 'null'::jsonb, 'client: extra shown once live';
  -- value per member: t1 7500, t2 1500-500, t3 2500 -> 3666.67; h1 2000, h2 0 -> 1000; lift 2666.67 x 3
  assert (v_r #>> '{extra,total_cents}')::numeric = 8000, format('client: extra = lift x treatment members, got %s', v_r->'extra');
  assert (v_r #>> '{extra,roi}')::numeric = 16.00, 'client: ROI = extra / treatment reward cost';
  assert (v_r #>> '{extra,low_cents}')::numeric < 8000 and (v_r #>> '{extra,high_cents}')::numeric > 8000,
    'client: the range brackets the total';
  assert v_r->>'basis' = 'gross_profit_minus_rewards', 'client: profit basis with a margin';
end $$;
reset role;

-- --- another workspace sees nothing ---
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'other'), true);
set local role authenticated;
do $$
begin
  assert not loyalty_client_has_program(), 'client: another workspace has no program';
  assert loyalty_client_results('2026-09-01', '2026-10-01') is null, 'client: another workspace sees nothing';
end $$;
reset role;

-- --- staff with MFA get the detail ---
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'staff'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
begin
  assert (loyalty_staff_insights_detail((select v from t where k = 'prog'), '2026-09-01', '2026-10-01')
          #>> '{redemptions,codes_used}')::int = 1, 'staff detail: staff + MFA can read it';
end $$;
reset role;

do $$ begin raise notice 'test_loyalty_insights_views: all assertions passed'; end $$;

rollback;
