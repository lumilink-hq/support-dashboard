-- =============================================================================
-- test_outbound_staff_access.sql — non-destructive test of 0307: the outbound
-- staff guard follows the loyalty staff model (platform_staff + MFA), browser
-- roles can't call it directly, and the outbound tables are still unreadable
-- from a signed-in session, staff or not.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_outbound_staff_access.sql
--
-- To see it FAIL:
--   * make outbound_require_staff() return 'x' without calling
--     loyalty_require_staff() -> "gate: a workspace admin is refused" fails.
--   * grant execute on outbound_require_staff() to authenticated
--     -> "grant: authenticated can't call the guard directly" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

create temp table t (k text primary key, v uuid) on commit drop;

do $$
declare
  v_staff uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at)
  values (v_staff, 'staff@lumilink.example', '{"business_name":"LumiLink"}', now()),
         (v_admin, 'owner@client.example', '{"business_name":"Client"}', now());
  insert into platform_staff (user_id, email) values (v_staff, 'staff@lumilink.example');
  insert into t values ('staff', v_staff), ('admin', v_admin);
end $$;

-- The guard runs as postgres here, the way an outbound RPC (SECURITY DEFINER)
-- runs it; only the JWT claims change.
create or replace function pg_temp.guard_error() returns text language plpgsql as $$
begin
  perform outbound_require_staff();
  return null;
exception when insufficient_privilege then
  return sqlerrm;
end $$;

-- --- a workspace admin is not staff ---
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'admin'), 'aal', 'aal2')::text, true);
do $$ begin
  assert pg_temp.guard_error() = 'not_staff', 'gate: a workspace admin is refused';
end $$;

-- --- staff, password only (aal1) ---
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'staff'), 'aal', 'aal1')::text, true);
do $$ begin
  assert pg_temp.guard_error() = 'mfa_required', 'mfa: a password-only staff session is refused';
end $$;

-- --- staff, MFA-verified (aal2) ---
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'staff'), 'aal', 'aal2')::text, true);
do $$ begin
  assert pg_temp.guard_error() is null, 'gate: staff on an aal2 session get through';
  assert outbound_require_staff() = 'staff@lumilink.example', 'gate: the guard returns the staff email';
end $$;

-- --- browser roles: no direct call, no table reads (0300 unchanged) ---
do $$ begin
  assert not has_function_privilege('authenticated', 'outbound_require_staff()', 'execute'),
    'grant: authenticated can''t call the guard directly';
  assert not has_function_privilege('anon', 'outbound_require_staff()', 'execute'),
    'grant: anon can''t call the guard directly';
  assert not has_table_privilege('authenticated', 'outbound_leads', 'select'),
    'grant: staff still can''t read outbound_leads straight from the browser';
  assert not has_table_privilege('authenticated', 'outbound_profiles', 'select'),
    'grant: staff still can''t read outbound_profiles straight from the browser';
end $$;

select 'test_outbound_staff_access: all assertions passed' as result;

rollback;
