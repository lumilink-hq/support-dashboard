-- =============================================================================
-- test_loyalty_merchant_access.sql — non-destructive test of 0223 (Phase 2
-- P2): workspace admins manage their own program, only with merchant_access
-- on, with MFA; staff keep everything; staff-only parts stay staff-only.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_merchant_access.sql
--
-- To see it FAIL:
--   * drop "and p.merchant_access" in loyalty_can_manage
--     -> "admin of a program without merchant access is refused" fails.
--   * drop "and u.role = 'admin'" in loyalty_can_manage
--     -> "agent is refused" fails.
--   * in loyalty_staff_member, check loyalty_require_manager_any() instead of
--     the member's own program -> "other store's member is refused" fails.
--   * drop the case on gross_margin_pct in loyalty_staff_program_save
--     -> "merchant cannot set gross margin" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

create temp table t (k text primary key, v uuid) on commit drop;
grant all on t to authenticated;

-- Expect a 42501 (not_staff or mfa_required) from a statement.
create or replace function pg_temp.refused(p_sql text, p_want text default 'not_staff')
returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when insufficient_privilege then
  return sqlerrm = p_want;
end;
$$;
grant execute on function pg_temp.refused(text, text) to authenticated;

do $$
declare
  v_staff uuid := gen_random_uuid();
  v_a     uuid := gen_random_uuid();   -- admin of the self-serve store
  v_g     uuid := gen_random_uuid();   -- agent in the same workspace
  v_b     uuid := gen_random_uuid();   -- admin of a Tsunami-like store (no merchant access)
  v_ca    uuid;
  v_cb    uuid;
  v_pa    uuid;
  v_pb    uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at) values
    (v_staff, 'staff@lumilink.example', '{"business_name":"LumiLink"}', now()),
    (v_a,     'owner@shop-a.example',   '{"business_name":"Shop A"}',   now()),
    (v_b,     'owner@shop-b.example',   '{"business_name":"Shop B"}',   now());
  insert into platform_staff (user_id, email) values (v_staff, 'staff@lumilink.example');
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  select gen_random_uuid(), u, 'test', 'totp', 'verified', now(), now(), 'x' from unnest(array[v_staff, v_a, v_b]) u;
  select client_id into v_ca from users where id = v_a;
  select client_id into v_cb from users where id = v_b;
  update users set role = 'admin' where id in (v_a, v_b);
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at)
  values (v_g, 'agent@shop-a.example', '{"business_name":"Shop A agent"}', now());
  update users set client_id = v_ca, role = 'agent' where id = v_g;

  insert into loyalty_programs (client_id, shop_domain, name, created_via)
  values (v_ca, 'merchant-a.myshopify.com', 'A Rewards', 'self_serve') returning id into v_pa;
  insert into loyalty_programs (client_id, shop_domain, name)
  values (v_cb, 'merchant-b.myshopify.com', 'B Rewards') returning id into v_pb;
  if not (select merchant_access from loyalty_programs where id = v_pa)
     or (select merchant_access from loyalty_programs where id = v_pb) then
    raise exception 'FAIL self-serve programs start with merchant access, others without';
  end if;
  raise notice 'ok  self-serve program gets merchant access, staff-made program does not';

  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents) values
    (v_pa, 'bronze', 'Bronze', 0, 0), (v_pb, 'bronze', 'Bronze', 0, 0);
  insert into t values ('staff', v_staff), ('a', v_a), ('g', v_g), ('b', v_b), ('pa', v_pa), ('pb', v_pb),
    ('ma', loyalty_enroll_member(v_pa, 101, 'shopper@a.example', 'Sam', 'A')),
    ('mb', loyalty_enroll_member(v_pb, 202, 'shopper@b.example', 'Sue', 'B'));
  insert into loyalty_campaigns (program_id, key, name, kind, multiplier, starts_at, ends_at)
  values (v_pb, 'b_double', 'B double', 'multiplier', 2, now() + interval '7 days', now() + interval '14 days');
  insert into t select 'cb', id from loyalty_campaigns where program_id = v_pb;
end $$;

-- ---------------------------------------------------------------------------
-- Merchant admin A, MFA verified.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'a'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
declare
  v_pa uuid := (select v from t where k = 'pa');
  v_pb uuid := (select v from t where k = 'pb');
  v_ma uuid := (select v from t where k = 'ma');
  v_mb uuid := (select v from t where k = 'mb');
  v_list jsonb;
begin
  if loyalty_manager_role() <> 'merchant' or loyalty_staff_access() <> 'ok' then
    raise exception 'FAIL merchant role/access: % %', loyalty_manager_role(), loyalty_staff_access();
  end if;
  v_list := loyalty_staff_programs();
  if jsonb_array_length(v_list) <> 1 or (v_list->0->>'id')::uuid <> v_pa then
    raise exception 'FAIL merchant sees only their program: %', v_list;
  end if;
  raise notice 'ok  merchant sees only their own program';

  if (loyalty_staff_members(v_pa)->>'total')::int <> 1 or loyalty_staff_member(v_ma) is null then
    raise exception 'FAIL merchant reads own members';
  end if;
  perform loyalty_staff_adjust(v_ma, 10, 'goodwill test', 'merchant-test-1');
  raise notice 'ok  merchant reads and adjusts own members (balance checked below)';

  if not pg_temp.refused(format('select loyalty_staff_member(%L)', v_mb)) then
    raise exception 'FAIL other store''s member is refused';
  end if;
  if not pg_temp.refused(format('select loyalty_staff_members(%L)', v_pb))
     or not pg_temp.refused(format('select loyalty_staff_adjust(%L, 5, ''x test'', ''k2'')', v_mb))
     or not pg_temp.refused(format('select loyalty_staff_campaign_set_active(%L, false)', (select v from t where k = 'cb')))
     or not pg_temp.refused(format('select loyalty_staff_program_config(%L)', v_pb))
     or not pg_temp.refused(format('select loyalty_staff_member(%L)', gen_random_uuid())) then
    raise exception 'FAIL other store refused (members list, adjust, campaign, config, unknown member)';
  end if;
  raise notice 'ok  other store''s member, list, adjust, campaign, config refused';

  if not pg_temp.refused('select loyalty_staff_data_requests()') then
    raise exception 'FAIL data requests stay staff only';
  end if;
  raise notice 'ok  data requests stay staff only';

  perform loyalty_staff_program_save(v_pa, jsonb_build_object(
    'points_per_dollar', 2, 'expire_months', 12, 'demote_months', 6, 'demotion_warning_days', 7,
    'balance_reminder_days', 30, 'near_tier_percent', 15, 'gross_margin_pct', 55));
end $$;
reset role;

do $$
begin
  if (select points_balance from loyalty_members where id = (select v from t where k = 'ma')) <> 10 then
    raise exception 'FAIL merchant adjust';
  end if;
  if (select points_per_dollar from loyalty_programs where id = (select v from t where k = 'pa')) <> 2
     or (select gross_margin_pct from loyalty_programs where id = (select v from t where k = 'pa')) is not null then
    raise exception 'FAIL merchant cannot set gross margin';
  end if;
  raise notice 'ok  merchant adjust landed, settings saved, gross margin kept (staff only)';
  if (select count(*) from loyalty_access_log
       where staff_user_id = (select v from t where k = 'a') and actor_kind = 'merchant'
         and staff_email = 'owner@shop-a.example') < 3
     or exists (select 1 from loyalty_access_log
                 where staff_user_id = (select v from t where k = 'a') and program_id = (select v from t where k = 'pb')) then
    raise exception 'FAIL merchant actions logged as merchant, nothing logged against the other store';
  end if;
  raise notice 'ok  merchant actions in the access log as merchant';
end $$;

-- Merchant A without MFA.
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'a'), 'aal', 'aal1')::text, true);
set local role authenticated;
do $$
begin
  if not pg_temp.refused(format('select loyalty_staff_members(%L)', (select v from t where k = 'pa')), 'mfa_required')
     or loyalty_staff_access() <> 'verify' then
    raise exception 'FAIL merchant needs MFA (access %)', loyalty_staff_access();
  end if;
  raise notice 'ok  merchant needs MFA';
end $$;
reset role;

-- Agent in the same workspace.
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'g'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
begin
  if loyalty_manager_role() <> 'none' or loyalty_staff_access() <> 'none'
     or not pg_temp.refused(format('select loyalty_staff_members(%L)', (select v from t where k = 'pa')))
     or not pg_temp.refused('select loyalty_staff_programs()') then
    raise exception 'FAIL agent is refused';
  end if;
  raise notice 'ok  agent is refused';
end $$;
reset role;

-- Admin B: their program has no merchant access (the Tsunami case).
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'b'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
begin
  if loyalty_manager_role() <> 'none'
     or not pg_temp.refused(format('select loyalty_staff_members(%L)', (select v from t where k = 'pb'))) then
    raise exception 'FAIL admin of a program without merchant access is refused';
  end if;
  raise notice 'ok  admin of a program without merchant access is refused';
end $$;
reset role;

-- Staff: everything, including gross margin.
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'staff'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
declare
  v_pb uuid := (select v from t where k = 'pb');
begin
  if loyalty_manager_role() <> 'staff' or jsonb_array_length(loyalty_staff_programs()) < 2
     or loyalty_staff_member((select v from t where k = 'mb')) is null then
    raise exception 'FAIL staff sees every program';
  end if;
  perform loyalty_staff_program_save(v_pb, jsonb_build_object(
    'points_per_dollar', 3, 'expire_months', 12, 'demote_months', 6, 'demotion_warning_days', 7,
    'balance_reminder_days', 30, 'near_tier_percent', 15, 'gross_margin_pct', 40));
  if (loyalty_staff_program_config(v_pb)->'program'->>'gross_margin_pct')::numeric <> 40 then
    raise exception 'FAIL staff sets gross margin: %', loyalty_staff_program_config(v_pb)->'program';
  end if;
  perform loyalty_staff_data_requests();
  raise notice 'ok  staff: every program, gross margin, data requests';
end $$;
reset role;

do $$
begin
  if exists (select 1 from loyalty_access_log where staff_user_id = (select v from t where k = 'staff') and actor_kind <> 'staff') then
    raise exception 'FAIL staff rows marked staff';
  end if;
end $$;

-- A deactivated admin loses access.
update users set is_active = false where id = (select v from t where k = 'a');
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'a'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
begin
  if not pg_temp.refused(format('select loyalty_staff_members(%L)', (select v from t where k = 'pa'))) then
    raise exception 'FAIL deactivated admin is refused';
  end if;
  raise notice 'ok  deactivated admin is refused';
end $$;
reset role;

rollback;
