-- =============================================================================
-- test_loyalty_staff_admin.sql — non-destructive test of 0206 (LL Loyalty
-- module 7): only platform_staff can use the staff RPCs (a workspace admin
-- can't), every member read and change writes the access log, adjustments
-- need a note and can't double-post or overdraw, and the log is append-only.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_staff_admin.sql
--
-- To see it FAIL:
--   * in loyalty_staff_member drop "perform loyalty_require_staff();"
--     -> "gate: a workspace admin can't view a member" fails.
--   * in loyalty_staff_member drop the loyalty_log_access('view', …) call
--     -> "log: viewing a member is logged" fails.
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
  v_alice  uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at)
  values (v_staff, 'staff@lumilink.example', '{"business_name":"LumiLink"}', now()),
         (v_admin, 'owner@tsunami.example', '{"business_name":"Tsunami"}', now());
  insert into platform_staff (user_id, email) values (v_staff, 'staff@lumilink.example');

  select client_id into v_client from users where id = v_admin;   -- the admin's own workspace
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar)
  values (v_client, 'staff-test.myshopify.com', 'Wave Rewards', 3) returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents) values
    (v_prog, 'bronze', 'Bronze', 0, 0), (v_prog, 'gold', 'Gold', 1, 120000);
  v_alice := loyalty_enroll_member(v_prog, 10, 'alice@example.com', 'Alice', 'Ng');
  perform loyalty_post_entry(v_alice, 500, 'adjust', 'seed:alice', 0, null, 'staff', null, null, 'seed');

  insert into t values ('staff', v_staff), ('admin', v_admin), ('prog', v_prog), ('alice', v_alice);
end $$;

-- --- a workspace admin (even of the store's own client) is not staff ---
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'admin'), true);
set local role authenticated;
do $$
declare
  v_denied boolean;
  v_alice  uuid := (select v from t where k = 'alice');
begin
  assert not current_user_is_staff(), 'gate: workspace admin is not staff';
  begin
    perform loyalty_staff_member(v_alice);
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'gate: a workspace admin can''t view a member';
  begin
    perform loyalty_staff_adjust(v_alice, 1000, 'please', 'req-admin-0001');
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'gate: a workspace admin can''t adjust points';
  begin
    perform loyalty_staff_programs();
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'gate: a workspace admin can''t list programs';
  begin
    perform 1 from platform_staff;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'gate: nobody reads platform_staff directly';
  begin
    insert into platform_staff (user_id, email) values (auth.uid(), 'me@x');
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'gate: nobody can add themselves as staff';
end $$;
reset role;

-- --- staff ---
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'staff'), true);
set local role authenticated;
do $$
declare
  v_prog  uuid := (select v from t where k = 'prog');
  v_alice uuid := (select v from t where k = 'alice');
  v_r     jsonb;
  v_ok    boolean;
begin
  assert current_user_is_staff(), 'gate: staff is staff';
  v_r := loyalty_staff_programs();
  assert jsonb_array_length(v_r) >= 1 and exists (select 1 from jsonb_array_elements(v_r) p where p->>'shop_domain' = 'staff-test.myshopify.com'
           and (p->>'members')::int = 1 and (p->>'points_outstanding')::int = 500), 'programs: listed with counts';

  assert jsonb_array_length(loyalty_staff_search(v_prog, 'ALICE@')) = 1, 'search: email, case-insensitive';
  assert jsonb_array_length(loyalty_staff_search(v_prog, 'alice ng')) = 1, 'search: full name';
  assert jsonb_array_length(loyalty_staff_search(v_prog, '10')) = 1, 'search: Shopify customer id';
  assert jsonb_array_length(loyalty_staff_search(v_prog, 'a')) = 0, 'search: 1 char is too short';

  v_r := loyalty_staff_member(v_alice);
  assert v_r->'member'->>'email' = 'alice@example.com' and v_r->'tier'->>'name' = 'Bronze'
     and jsonb_array_length(v_r->'ledger') = 1, 'member: detail with ledger';

  v_r := loyalty_staff_adjust(v_alice, 250, 'Goodwill: late delivery', 'req-staff-0001');
  assert (v_r->>'points_balance')::int = 750 and not (v_r->>'duplicate')::boolean, 'adjust: +250';
  v_r := loyalty_staff_adjust(v_alice, 250, 'Goodwill: late delivery', 'req-staff-0001');
  assert (v_r->>'duplicate')::boolean and (v_r->>'points_balance')::int = 750, 'adjust: double submit is a no-op';
  begin
    perform loyalty_staff_adjust(v_alice, -5000, 'Remove points', 'req-staff-0002');
    v_ok := false;
  exception when others then v_ok := sqlerrm like 'insufficient_points%';
  end;
  assert v_ok, 'adjust: can''t overdraw';
  begin
    perform loyalty_staff_adjust(v_alice, 10, '', 'req-staff-0003');
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%note is required%';
  end;
  assert v_ok, 'adjust: a note is required';

  assert loyalty_staff_set_tier(v_alice, 'gold', 'Matched Joy tier'), 'tier: set';
  assert not loyalty_staff_set_tier(v_alice, 'gold', 'Again'), 'tier: unchanged is false';
  perform loyalty_staff_set_birthday(v_alice, '1990-01-02', 'Customer emailed');
  perform loyalty_staff_set_birthday(v_alice, '1990-02-03', 'Typo fix');
  perform loyalty_staff_data_requests();
end $$;
reset role;

-- --- what landed (as postgres) ---
do $$
declare
  v_alice uuid := (select v from t where k = 'alice');
  v_staff uuid := (select v from t where k = 'staff');
  v_n     int;
  v_ok    boolean;
begin
  assert (select actor = 'staff@lumilink.example' and note = 'Goodwill: late delivery'
            from loyalty_ledger where member_id = v_alice and idempotency_key = 'adjust:req-staff-0001'),
    'adjust: ledger records who and why';
  assert (select actor from loyalty_tier_changes where member_id = v_alice and reason = 'staff') = 'staff@lumilink.example',
    'tier: change records who';
  assert (select birthday from loyalty_members where id = v_alice) = '1990-02-03', 'birthday: staff can change it again';

  select count(*) into v_n from loyalty_access_log where staff_user_id = v_staff and action = 'search';
  assert v_n = 3, format('log: each search with a query is logged (got %s)', v_n);
  select count(*) into v_n from loyalty_access_log where staff_user_id = v_staff and action = 'view' and member_id = v_alice;
  assert v_n = 1, 'log: viewing a member is logged';
  select count(*) into v_n from loyalty_access_log where staff_user_id = v_staff and action = 'adjust';
  assert v_n = 1, 'log: one adjust (the duplicate and the refused ones aren''t)';
  select count(*) into v_n from loyalty_access_log where staff_user_id = v_staff and action in ('set_tier', 'set_birthday', 'data_requests');
  assert v_n = 4, 'log: tier, both birthday changes, data requests';
  assert (select detail->>'query' from loyalty_access_log where staff_user_id = v_staff and action = 'search' order by id limit 1) = 'ALICE@',
    'log: search query recorded';

  begin
    update loyalty_access_log set staff_email = 'x' where staff_user_id = v_staff;
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%append-only%';
  end;
  assert v_ok, 'log: append-only';
end $$;

rollback;

\echo 'test_loyalty_staff_admin: all assertions passed'
