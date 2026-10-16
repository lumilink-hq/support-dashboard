-- =============================================================================
-- test_loyalty_program_editor.sql — non-destructive test of 0221: the staff
-- program editor RPCs (settings, tiers, rewards, earn rules).
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_program_editor.sql
--
-- To see it FAIL:
--   * in loyalty_staff_tiers_save drop the set_config('loyalty.quiet', 'on', true)
--     -> "tiers: promotions send no tier_up events" fails.
--   * drop "if not v_first and ... <= v_prev" -> "tiers: thresholds must rise" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

create temp table t (k text primary key, v uuid) on commit drop;
grant all on t to authenticated;

do $$
declare
  v_staff  uuid := gen_random_uuid();
  v_admin  uuid := gen_random_uuid();
  v_client uuid;
  v_prog   uuid;
  v_m      uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at)
  values (v_staff, 'staff@lumilink.example', '{"business_name":"LumiLink"}', now()),
         (v_admin, 'owner@store.example', '{"business_name":"Store"}', now());
  insert into platform_staff (user_id, email) values (v_staff, 'staff@lumilink.example');
  select client_id into v_client from users where id = v_admin;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, points_expire_after, demote_after_inactive)
  values (v_client, 'editor-test.myshopify.com', 'Wave Rewards', 3, '1 year', '6 months') returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier, perks) values
    (v_prog, 'bronze', 'Bronze', 0, 0, 1, '["Birthday rewards"]'),
    (v_prog, 'silver', 'Silver', 1, 50000, 1.1, '[]'),
    (v_prog, 'gold',   'Gold',   2, 120000, 1.2, '[]');
  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents) values
    (v_prog, 'five_off', '$5 off', 'amount_off_order', 750, 500),
    (v_prog, 'referral_friend', '$10 off your first order', 'amount_off_order', null, 1000);
  insert into loyalty_earn_rules (program_id, key, kind, points) values (v_prog, 'signup', 'action', 100);
  -- A member at $300 spend (Bronze today) and one at $700 (Silver).
  v_m := loyalty_enroll_member(v_prog, 1, 'a@example.com');
  perform loyalty_post_entry(v_m, 0, 'order', 'seed:a', 30000, null, null, null, null, 'seed');
  insert into t values ('a', v_m);
  v_m := loyalty_enroll_member(v_prog, 2, 'b@example.com');
  perform loyalty_post_entry(v_m, 0, 'order', 'seed:b', 70000, null, null, null, null, 'seed');
  insert into t values ('b', v_m), ('staff', v_staff), ('admin', v_admin), ('prog', v_prog);
end $$;

-- --- not staff ---
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'admin'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
declare v_denied boolean := false;
begin
  begin
    perform loyalty_staff_program_save((select v from t where k = 'prog'), '{"points_per_dollar":10}');
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'gate: a workspace admin can''t edit the program';
end $$;
reset role;

-- --- staff without MFA ---
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'staff'), 'aal', 'aal1')::text, true);
set local role authenticated;
do $$
declare v_denied boolean := false;
begin
  begin
    perform loyalty_staff_program_config((select v from t where k = 'prog'));
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'gate: staff need MFA to read the program config';
end $$;
reset role;

-- --- staff, aal2 ---
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'staff'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
declare
  v_prog uuid := (select v from t where k = 'prog');
  v_c    jsonb;
  v_r    jsonb;
  v_err  text;
begin
  v_c := loyalty_staff_program_config(v_prog);
  assert (v_c->'program'->>'expire_months')::int = 12, 'config: 1 year shows as 12 months';
  assert (v_c->'program'->>'demote_months')::int = 6, 'config: 6 months';
  assert jsonb_array_length(v_c->'tiers') = 3 and (v_c->'tiers'->1->>'members')::int = 1, 'config: tiers with member counts';
  assert jsonb_array_length(v_c->'rewards') = 2, 'config: rewards';

  -- settings
  v_r := loyalty_staff_program_save(v_prog, '{"points_per_dollar":"4","expire_months":"","demote_months":"9","demotion_warning_days":"10","balance_reminder_days":"21","near_tier_percent":"20","gross_margin_pct":"45"}');
  assert (v_r->>'points_per_dollar')::numeric = 4 and v_r->'expire_months' = 'null'::jsonb and (v_r->>'demote_months')::int = 9,
    'settings: saved (empty expiry = never)';
  assert (v_r->>'gross_margin_pct')::numeric = 45, 'settings: gross margin';
  begin
    perform loyalty_staff_program_save(v_prog, '{"points_per_dollar":"0","demote_months":"6","demotion_warning_days":"7","balance_reminder_days":"30","near_tier_percent":"15"}');
  exception when others then v_err := sqlerrm;
  end;
  assert v_err like 'Points per $1%', 'settings: 0 points per $1 refused';

  -- tiers: lower Silver to $250 -> member a ($300) moves up quietly.
  v_r := loyalty_staff_tiers_save(v_prog, '[{"key":"bronze","min_spend_cents":0,"earn_multiplier":1,"perks":["Birthday rewards"]},
                                            {"key":"silver","min_spend_cents":25000,"earn_multiplier":1.15,"perks":["Early access to drops"]},
                                            {"key":"gold","min_spend_cents":60000,"earn_multiplier":1.25,"perks":[]}]');
  assert (v_r->>'promoted')::int = 2, 'tiers: a -> Silver and b -> Gold';
  v_err := null;
  begin
    perform loyalty_staff_tiers_save(v_prog, '[{"key":"bronze","min_spend_cents":0,"earn_multiplier":1},
                                              {"key":"silver","min_spend_cents":60000,"earn_multiplier":1.1},
                                              {"key":"gold","min_spend_cents":60000,"earn_multiplier":1.2}]');
  exception when others then v_err := sqlerrm;
  end;
  assert v_err like 'Gold must need more spend%', 'tiers: thresholds must rise';
  v_err := null;
  begin
    perform loyalty_staff_tiers_save(v_prog, '[{"key":"bronze","min_spend_cents":100,"earn_multiplier":1},
                                              {"key":"silver","min_spend_cents":60000,"earn_multiplier":1.1},
                                              {"key":"gold","min_spend_cents":90000,"earn_multiplier":1.2}]');
  exception when others then v_err := sqlerrm;
  end;
  assert v_err like 'The first tier%', 'tiers: the first tier starts at $0';
  v_err := null;
  begin
    perform loyalty_staff_tiers_save(v_prog, '[{"key":"bronze","min_spend_cents":0,"earn_multiplier":1}]');
  exception when others then v_err := sqlerrm;
  end;
  assert v_err = 'Send every tier.', 'tiers: all tiers in one call';
  -- Raising thresholds back demotes nobody.
  v_r := loyalty_staff_tiers_save(v_prog, '[{"key":"bronze","min_spend_cents":0,"earn_multiplier":1},
                                            {"key":"silver","min_spend_cents":50000,"earn_multiplier":1.1},
                                            {"key":"gold","min_spend_cents":120000,"earn_multiplier":1.2}]');
  assert (v_r->>'promoted')::int = 0, 'tiers: raising thresholds promotes nobody';

  -- rewards: edit, create, referral reward keeps no points cost.
  v_r := loyalty_staff_reward_save(v_prog, '{"key":"five_off","name":"$5 off","points_cost":"500","value_cents":"500","min_order_cents":"0","max_units":"","is_active":true}');
  assert v_r->>'key' = 'five_off', 'reward: edited';
  v_r := loyalty_staff_reward_save(v_prog, '{"name":"$15 off","points_cost":"2000","value_cents":"1500","min_order_cents":"5000","max_units":"1","is_active":true}');
  assert v_r->>'key' = '15_off' or v_r->>'key' = 'reward_15_off', 'reward: created with a key from the name';
  v_r := loyalty_staff_reward_save(v_prog, '{"key":"referral_friend","name":"$12 off your first order","points_cost":"999","value_cents":"1200","is_active":true}');
  v_c := loyalty_staff_program_config(v_prog);
  assert (select r->'points_cost' from jsonb_array_elements(v_c->'rewards') r where r->>'key' = 'referral_friend') = 'null'::jsonb,
    'reward: the friend reward stays free (no points cost)';
  assert (select (r->>'value_cents')::int from jsonb_array_elements(v_c->'rewards') r where r->>'key' = 'referral_friend') = 1200,
    'reward: the friend reward value changed';
  assert (select r->'max_units' from jsonb_array_elements(v_c->'rewards') r where r->>'key' = 'five_off') = 'null'::jsonb,
    'reward: empty max per code = no limit';
  v_err := null;
  begin
    perform loyalty_staff_reward_save(v_prog, '{"name":"Free","points_cost":"","value_cents":"500"}');
  exception when others then v_err := sqlerrm;
  end;
  assert v_err like 'The points cost%', 'reward: a new reward needs a points cost';

  -- earn rule
  v_r := loyalty_staff_earn_rule_save(v_prog, 'signup', 150, false);
  assert (v_r->>'points')::int = 150 and not (v_r->>'is_active')::boolean, 'earn rule: points and on/off saved';
  v_err := null;
  begin
    perform loyalty_staff_earn_rule_save(v_prog, 'nope', 10, true);
  exception when others then v_err := sqlerrm;
  end;
  assert v_err = 'Unknown earning rule.', 'earn rule: only existing rules';
end $$;
reset role;

do $$
declare
  v_prog uuid := (select v from t where k = 'prog');
  v_n    int;
begin
  assert (select tier_key from loyalty_members where id = (select v from t where k = 'a')) = 'silver', 'tiers: member a is Silver';
  assert (select tier_key from loyalty_members where id = (select v from t where k = 'b')) = 'gold', 'tiers: member b is Gold';
  -- (The seed's $700 order earned Silver by spend and sent its own tier_up; the editor's must not.)
  select count(*) into v_n from loyalty_events where program_id = v_prog and kind = 'tier_up' and payload->>'reason' = 'staff';
  assert v_n = 0, 'tiers: promotions send no tier_up events';
  select count(*) into v_n from loyalty_tier_changes where program_id = v_prog and reason = 'staff' and actor = 'staff@lumilink.example';
  assert v_n = 2, 'tiers: promotions logged as staff changes by the editor';
  select count(*) into v_n from loyalty_access_log where program_id = v_prog and action = 'program_save';
  assert v_n = 7, 'log: one program_save row per successful save, got ' || v_n;
  assert exists (select 1 from loyalty_access_log where program_id = v_prog and action = 'program_save'
                  and detail->>'section' = 'settings' and (detail->'before'->>'points_per_dollar')::numeric = 3
                  and (detail->'after'->>'points_per_dollar')::numeric = 4), 'log: before and after recorded';
  assert (select points_per_dollar from loyalty_programs where id = v_prog) = 4, 'settings: stored';
  assert (select count(*) from loyalty_verify_balances(v_prog)) = 0, 'ledger: untouched balances still match';
  raise notice 'test_loyalty_program_editor: all assertions passed';
end $$;

rollback;
