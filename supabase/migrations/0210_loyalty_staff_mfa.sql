-- =============================================================================
-- 0210_loyalty_staff_mfa.sql — LumiLink staff need MFA (an authenticator app)
-- to see or change loyalty member data (plan §8b L2-5). Builds on 0206.
--
-- WHY HERE. Same reason as the staff check itself (0206): it's enforced in
-- the database, inside loyalty_require_staff(), which every staff RPC calls
-- first. A session that only passed a password carries aal = 'aal1' in its
-- JWT; one that also passed a TOTP code carries 'aal2'. Staff with aal1 get
-- 'mfa_required' (42501) from every staff RPC, whatever the page does.
--
-- loyalty_staff_access() tells the /loyalty pages which step a staff member
-- is on, so they can send them to set up or enter a code:
--   'none'   not staff (pages 404)
--   'enroll' staff, no verified authenticator yet
--   'verify' staff with an authenticator, this session hasn't passed it
--   'ok'     staff, session is aal2
--
-- Only staff are affected: client workspaces and their logins don't change.
-- Requires TOTP MFA enabled in Supabase Auth (Dashboard -> Authentication ->
-- Multi-Factor: TOTP enroll + verify on). Reset a lost authenticator by
-- deleting the user's row from auth.mfa_factors (SQL editor).
--
-- Test: scripts/test_loyalty_staff_admin.sql. Idempotent / safe to re-apply.
-- =============================================================================

create or replace function loyalty_staff_access()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not exists (select 1 from platform_staff where user_id = auth.uid()) then 'none'
    when not exists (select 1 from auth.mfa_factors f
                      where f.user_id = auth.uid() and f.status = 'verified') then 'enroll'
    when coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then 'verify'
    else 'ok'
  end;
$$;

-- loyalty_require_staff — 0206's, plus the MFA requirement.
create or replace function loyalty_require_staff()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
begin
  select email into v_email from platform_staff where user_id = auth.uid();
  if v_email is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'mfa_required' using errcode = '42501';
  end if;
  return v_email;
end;
$$;

revoke execute on function loyalty_staff_access() from public, anon;
grant execute on function loyalty_staff_access() to authenticated;
revoke execute on function loyalty_require_staff() from public, anon, authenticated;
