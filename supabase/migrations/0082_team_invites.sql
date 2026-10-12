-- =============================================================================
-- 0082_team_invites.sql — client admins invite and manage their own team from
-- /team, instead of us running scripts/add-staff.sql.
--
-- Builds on 0080: client_invites stays the pre-approved list, and
-- handle_new_user still does the joining. What's new is a self-scoped way for a
-- client ADMIN to write that list and to manage the people already on it. The
-- app (app/(dashboard)/team/actions.ts) then calls auth.admin.inviteUserByEmail,
-- which creates the auth user -> the trigger puts them on the client -> Supabase
-- emails them a link to /auth/confirm -> they set a password at /account/password.
--
-- Everything goes through SECURITY DEFINER functions scoped by
-- current_client_id(); client_invites keeps RLS on with no tenant policies.
--
-- ALSO FIXES users_update_self (0004). That policy limits WHICH ROW a user can
-- update (their own) but not WHICH COLUMNS, and `authenticated` had UPDATE on
-- the whole table. Any signed-in user could set their own role to 'admin', or
-- their own client_id to another tenant's. With invited agents/viewers that
-- stops being theoretical. Nothing in the app writes users as the signed-in
-- user (checked 2026-10-12), so the column grant narrows to full_name only.
-- =============================================================================

revoke update on public.users from authenticated;
grant update (full_name) on public.users to authenticated;


-- -----------------------------------------------------------------------------
-- Caller must be an active admin. Returns their client.
-- -----------------------------------------------------------------------------
create or replace function public.team_require_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid;
begin
  select client_id into v_client
    from public.users
   where id = auth.uid() and role = 'admin' and is_active;
  if v_client is null then
    raise exception 'Only admins can manage the team.' using errcode = '42501';
  end if;
  return v_client;
end;
$$;

revoke all on function public.team_require_admin() from public, anon;


-- -----------------------------------------------------------------------------
-- team_members() — everyone on the caller's client, plus invites nobody has
-- used yet. Any member can read it; only admins see the buttons.
--
-- status:
--   active      — has signed in at least once
--   invited     — auth user exists (invite email sent) but never signed in, OR
--                 a 0080-style invite row with no auth user yet (user_id null)
--   deactivated — removed by an admin (is_active = false)
-- -----------------------------------------------------------------------------
create or replace function public.team_members()
returns table (
  user_id     uuid,
  email       text,
  full_name   text,
  role        public.user_role_t,
  status      text,
  invited_at  timestamptz,
  last_sign_in_at timestamptz,
  is_me       boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id,
         u.email,
         u.full_name,
         u.role,
         case
           when not u.is_active then 'deactivated'
           when a.last_sign_in_at is null then 'invited'
           else 'active'
         end,
         i.created_at,
         a.last_sign_in_at,
         u.id = auth.uid()
    from public.users u
    join auth.users a on a.id = u.id
    left join lateral (
      select ci.created_at from public.client_invites ci
       where ci.user_id = u.id order by ci.created_at desc limit 1
    ) i on true
   where u.client_id = public.current_client_id()
  union all
  select null, ci.email, ci.full_name, ci.role, 'invited', ci.created_at, null, false
    from public.client_invites ci
   where ci.client_id = public.current_client_id()
     and ci.accepted_at is null
$$;

revoke all on function public.team_members() from public, anon;
grant execute on function public.team_members() to authenticated;


-- -----------------------------------------------------------------------------
-- create_team_invite(email, full_name, role) — admin only. Writes (or updates)
-- the pending invite for the caller's client. The app sends the email after.
--
-- Refuses an email that already has a LumiLink login: the trigger only fires on
-- a NEW auth user, so that person would never join. Moving an existing account
-- between clients is still ours to do (scripts/add-user-to-client.sql).
-- -----------------------------------------------------------------------------
create or replace function public.create_team_invite(
  p_email     text,
  p_full_name text,
  p_role      public.user_role_t
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid := public.team_require_admin();
  v_email  text := lower(trim(p_email));
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;

  if exists (select 1 from auth.users where lower(email) = v_email) then
    if exists (select 1 from public.users where lower(email) = v_email and client_id = v_client) then
      raise exception '% is already on your team.', v_email using errcode = '23505';
    end if;
    raise exception '% already has a LumiLink account. Contact us and we''ll move it onto your team.', v_email
      using errcode = '23505';
  end if;

  if exists (select 1 from public.client_invites
              where email = v_email and accepted_at is null and client_id <> v_client) then
    raise exception '% already has a pending invite from another workspace.', v_email
      using errcode = '23505';
  end if;

  insert into public.client_invites (client_id, email, full_name, role)
  values (v_client, v_email, nullif(trim(p_full_name), ''), p_role)
  on conflict (email) where accepted_at is null
  do update set full_name = excluded.full_name, role = excluded.role;
end;
$$;

revoke all on function public.create_team_invite(text, text, public.user_role_t) from public, anon;
grant execute on function public.create_team_invite(text, text, public.user_role_t) to authenticated;


-- -----------------------------------------------------------------------------
-- Shared guard for acting on a teammate: admin only, same client, not yourself.
-- "Not yourself" is also what keeps a client from losing its last admin: the
-- caller is an admin, and nobody can demote or remove the caller but another.
-- -----------------------------------------------------------------------------
create or replace function public.team_require_teammate(p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid := public.team_require_admin();
begin
  if p_user_id = auth.uid() then
    raise exception 'You can''t change your own access. Ask another admin.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.users where id = p_user_id and client_id = v_client) then
    raise exception 'That person isn''t on your team.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.team_require_teammate(uuid) from public, anon;


-- -----------------------------------------------------------------------------
-- set_team_member_role(user_id, role) — admin only.
-- -----------------------------------------------------------------------------
create or replace function public.set_team_member_role(p_user_id uuid, p_role public.user_role_t)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.team_require_teammate(p_user_id);
  update public.users set role = p_role where id = p_user_id;
end;
$$;

revoke all on function public.set_team_member_role(uuid, public.user_role_t) from public, anon;
grant execute on function public.set_team_member_role(uuid, public.user_role_t) to authenticated;


-- -----------------------------------------------------------------------------
-- remove_team_member(user_id) — admin only. Returns what the app must do to
-- the auth user next (service role only):
--   'delete'     — never signed in: an unused invite. Delete the auth user;
--                  public.users goes with it (on delete cascade).
--   'deactivate' — has signed in: keep the row (their name is on approvals,
--                  notes, etc.), mark inactive, and ban the auth user.
-- -----------------------------------------------------------------------------
create or replace function public.remove_team_member(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.team_require_teammate(p_user_id);

  if exists (select 1 from auth.users where id = p_user_id and last_sign_in_at is null) then
    return 'delete';
  end if;

  update public.users set is_active = false where id = p_user_id;
  return 'deactivate';
end;
$$;

revoke all on function public.remove_team_member(uuid) from public, anon;
grant execute on function public.remove_team_member(uuid) to authenticated;


-- -----------------------------------------------------------------------------
-- reactivate_team_member(user_id) — admin only. The app unbans the auth user.
-- -----------------------------------------------------------------------------
create or replace function public.reactivate_team_member(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.team_require_teammate(p_user_id);
  update public.users set is_active = true where id = p_user_id;
end;
$$;

revoke all on function public.reactivate_team_member(uuid) from public, anon;
grant execute on function public.reactivate_team_member(uuid) to authenticated;


-- -----------------------------------------------------------------------------
-- withdraw_team_invite(email) — admin only. For an invite row with no auth
-- user yet (made by add-staff.sql, or the email send failed).
-- -----------------------------------------------------------------------------
create or replace function public.withdraw_team_invite(p_email text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid := public.team_require_admin();
begin
  delete from public.client_invites
   where client_id = v_client and email = lower(trim(p_email)) and accepted_at is null;
end;
$$;

revoke all on function public.withdraw_team_invite(text) from public, anon;
grant execute on function public.withdraw_team_invite(text) to authenticated;


-- -----------------------------------------------------------------------------
-- team_invite_resendable(email) — admin only. True when the email belongs to
-- the caller's team (pending invite row, or an invited user who never signed
-- in), so the app may call inviteUserByEmail for it again.
-- -----------------------------------------------------------------------------
create or replace function public.team_invite_resendable(p_email text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid := public.team_require_admin();
  v_email  text := lower(trim(p_email));
begin
  return exists (
    select 1 from public.client_invites
     where client_id = v_client and email = v_email and accepted_at is null
  ) or exists (
    select 1 from public.users u join auth.users a on a.id = u.id
     where u.client_id = v_client and lower(u.email) = v_email
       and u.is_active and a.last_sign_in_at is null
  );
end;
$$;

revoke all on function public.team_invite_resendable(text) from public, anon;
grant execute on function public.team_invite_resendable(text) to authenticated;

-- Verify: scripts/test_team_invites.sql (runs in a rolled-back transaction).

-- End of 0082.
