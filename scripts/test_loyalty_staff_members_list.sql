-- =============================================================================
-- test_loyalty_staff_members_list.sql — non-destructive test of 0219: the
-- staff members table (loyalty_staff_members). Staff + MFA only, 50 per page,
-- filters, sorting, one access-log row per call.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_staff_members_list.sql
--
-- To see it FAIL:
--   * drop the "filter (where s.rn > ...)" clause on the jsonb_agg
--     -> "paging: 50 rows on page 1" fails.
--   * drop the loyalty_log_access call -> "log: one 'list' row per call" fails.
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
  i        int;
begin
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at)
  values (v_staff, 'staff@lumilink.example', '{"business_name":"LumiLink"}', now()),
         (v_admin, 'owner@store.example', '{"business_name":"Store"}', now());
  insert into platform_staff (user_id, email) values (v_staff, 'staff@lumilink.example');
  select client_id into v_client from users where id = v_admin;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, points_expire_after, demote_after_inactive)
  values (v_client, 'list-test.myshopify.com', 'Wave Rewards', 3, '1 year', '6 months') returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents) values
    (v_prog, 'bronze', 'Bronze', 0, 0), (v_prog, 'silver', 'Silver', 1, 50000), (v_prog, 'gold', 'Gold', 2, 120000);
  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents) values
    (v_prog, 'five_off', '$5 off', 'amount_off_order', 750, 500);

  -- 60 plain Bronze members, recent activity, 0-59 points.
  for i in 1..60 loop
    v_m := loyalty_enroll_member(v_prog, 1000 + i, 'member' || lpad(i::text, 2, '0') || '@example.com', 'Member', i::text);
    update loyalty_members set points_balance = i - 1, last_activity_at = now(), last_order_at = now() - make_interval(days => i)
     where id = v_m;
  end loop;
  -- Four with something to find.
  v_m := loyalty_enroll_member(v_prog, 1, 'rich@example.com', 'Rita', 'Rich');
  update loyalty_members set points_balance = 2000, tier_key = 'gold', tier_spend_cents = 130000,
                             last_order_at = now() - interval '2 days', last_activity_at = now() where id = v_m;
  insert into t values ('rich', v_m);
  v_m := loyalty_enroll_member(v_prog, 2, 'lapsing@example.com', 'Lars', 'Lapse');
  update loyalty_members set points_balance = 100, tier_key = 'silver', tier_spend_cents = 60000,
                             last_order_at = now() - interval '6 months' + interval '10 days', last_activity_at = now() where id = v_m;
  insert into t values ('lapsing', v_m);
  v_m := loyalty_enroll_member(v_prog, 3, 'fading@example.com', 'Fay', 'Fade');
  update loyalty_members set points_balance = 300, last_activity_at = now() - interval '1 year' + interval '15 days',
                             enrolled_at = now() - interval '2 years' where id = v_m;
  insert into t values ('fading', v_m);
  v_m := loyalty_enroll_member(v_prog, 4, 'gone@example.com', 'Gus', 'Gone');
  update loyalty_members set status = 'excluded' where id = v_m;
  insert into t values ('gone', v_m);

  insert into t values ('staff', v_staff), ('admin', v_admin), ('prog', v_prog);
end $$;

-- --- not staff: refused ---
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'admin'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
declare v_denied boolean := false;
begin
  begin
    perform loyalty_staff_members((select v from t where k = 'prog'));
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'gate: a workspace admin can''t list members';
end $$;
reset role;

-- --- staff without an MFA-verified session: refused ---
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'staff'), 'aal', 'aal1')::text, true);
set local role authenticated;
do $$
declare v_denied boolean := false;
begin
  begin
    perform loyalty_staff_members((select v from t where k = 'prog'));
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'gate: staff need MFA to list members';
end $$;
reset role;

-- --- staff, aal2 ---
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'staff'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
declare
  v_prog uuid := (select v from t where k = 'prog');
  v_r    jsonb;
  v_h    int;
  v_t    int;
begin
  v_r := loyalty_staff_members(v_prog);
  assert (v_r->>'total')::int = 64, 'list: all 64 members counted';
  assert jsonb_array_length(v_r->'rows') = 50, 'paging: 50 rows on page 1';
  assert v_r->'rows'->0->>'email' = 'rich@example.com', 'sort: points, highest first by default';
  assert v_r->'rows'->0 ?& array['first_name', 'last_name', 'email', 'tier', 'points', 'tier_spend_cents', 'orders', 'last_order_at', 'group', 'status'],
    'columns: every table column is returned';
  assert not (v_r->'rows'->0 ? 'birthday'), 'columns: nothing beyond the table (no birthday)';

  v_r := loyalty_staff_members(v_prog, '{}', 'points', 'desc', 2);
  assert jsonb_array_length(v_r->'rows') = 14, 'paging: the remaining 14 on page 2';
  v_r := loyalty_staff_members(v_prog, '{}', 'points', 'asc', 1);
  assert (v_r->'rows'->0->>'points')::int = 0, 'sort: points ascending';
  v_r := loyalty_staff_members(v_prog, '{}', 'spend', 'desc', 1);
  assert v_r->'rows'->0->>'email' = 'rich@example.com' and v_r->'rows'->1->>'email' = 'lapsing@example.com', 'sort: tier spend';
  v_r := loyalty_staff_members(v_prog, '{}', 'last_order', 'desc', 1);
  assert v_r->'rows'->0->>'email' = 'member01@example.com', 'sort: most recent order first';
  v_r := loyalty_staff_members(v_prog, '{}', 'drop table x', 'sideways', 1);
  assert v_r->>'sort' = 'points' and v_r->>'dir' = 'desc', 'sort: unknown values fall back to points desc';

  v_r := loyalty_staff_members(v_prog, '{"tier":"silver"}');
  assert (v_r->>'total')::int = 1 and v_r->'rows'->0->>'email' = 'lapsing@example.com', 'filter: tier';
  v_r := loyalty_staff_members(v_prog, '{"status":"excluded"}');
  assert (v_r->>'total')::int = 1 and v_r->'rows'->0->>'email' = 'gone@example.com', 'filter: status';
  v_r := loyalty_staff_members(v_prog, '{"can_redeem":true}');
  assert (v_r->>'total')::int = 1 and v_r->'rows'->0->>'email' = 'rich@example.com', 'filter: can redeem (750+)';
  v_r := loyalty_staff_members(v_prog, '{"demotes_30d":true}');
  assert (v_r->>'total')::int = 1 and v_r->'rows'->0->>'email' = 'lapsing@example.com', 'filter: demotes within 30 days';
  v_r := loyalty_staff_members(v_prog, '{"expires_30d":true}');
  assert (v_r->>'total')::int = 1 and v_r->'rows'->0->>'email' = 'fading@example.com', 'filter: points expire within 30 days';
  v_r := loyalty_staff_members(v_prog, '{"q":"lars"}');
  assert (v_r->>'total')::int = 1, 'filter: name search';
  v_r := loyalty_staff_members(v_prog, '{"q":"member0"}');
  assert (v_r->>'total')::int = 9, 'filter: email search';
  v_r := loyalty_staff_members(v_prog, '{"tier":"bronze","can_redeem":true}');
  assert (v_r->>'total')::int = 0, 'filter: filters combine';

  v_h := (loyalty_staff_members(v_prog, '{"group":"holdout"}')->>'total')::int;
  v_t := (loyalty_staff_members(v_prog, '{"group":"treatment"}')->>'total')::int;
  assert v_h + v_t = 64, 'filter: holdout + treatment = everyone';
  insert into t values ('holdout_n', ('00000000-0000-0000-0000-' || lpad(v_h::text, 12, '0'))::uuid);
end $$;
reset role;

do $$
declare v_n int;
begin
  select count(*) into v_n from loyalty_access_log where program_id = (select v from t where k = 'prog') and action = 'list';
  assert v_n = 16, 'log: one ''list'' row per call (refused calls log nothing), got ' || v_n;
  assert (select count(*) from loyalty_members m join loyalty_programs p on p.id = m.program_id
           where p.id = (select v from t where k = 'prog') and m.holdout_bucket < p.holdout_percent)
         = right((select v from t where k = 'holdout_n')::text, 12)::int,
    'filter: holdout matches the member buckets';
  assert exists (select 1 from loyalty_access_log where program_id = (select v from t where k = 'prog') and action = 'list'
                  and detail->'filters'->>'tier' = 'silver' and (detail->>'results')::int = 1),
    'log: filters and result count are recorded';
  raise notice 'test_loyalty_staff_members_list: all assertions passed';
end $$;

rollback;
