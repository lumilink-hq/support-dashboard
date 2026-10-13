-- =============================================================================
-- add-platform-staff.sql — give a LumiLink staff member the LL Loyalty admin
-- (/loyalty, needs 0206). Staff is NOT a workspace role: a client's own admin
-- never gets it. Only this script (SQL, service role) can add someone.
--
-- Supabase Dashboard -> SQL Editor. The person must already have a login
-- (signed up at https://www.lumilinkhub.com/signup). Run with v_dry_run = true
-- first, then flip it to false.
--
-- Remove someone:  delete from platform_staff where email = '…';
-- Who has it:      select * from platform_staff;
-- Who looked at what (plan §8b L2-6):
--   select at, staff_email, action, member_id, detail from loyalty_access_log order by at desc limit 100;
-- =============================================================================

do $$
declare
  v_dry_run boolean := true;                    -- set to false for the real run
  v_email   text    := 'someone@lumilinkhub.com';
  v_user    uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(v_email);
  if v_user is null then
    raise exception 'no login for % — they need to sign up first', v_email;
  end if;
  if v_dry_run then
    raise notice 'DRY RUN: would add % (%) to platform_staff', v_email, v_user;
    return;
  end if;
  insert into platform_staff (user_id, email, added_by) values (v_user, lower(v_email), 'add-platform-staff.sql')
  on conflict (user_id) do nothing;
  raise notice 'added % to platform_staff', v_email;
end $$;
