-- =============================================================================
-- 0087_signup_pending_invite.sql — /signup can tell an invited email apart.
--
-- An invite (0082, inviteUserByEmail) creates the auth user straight away,
-- unconfirmed. If that person goes to /signup instead of using the invite
-- link, Supabase (with "Confirm email" on, as in production):
--   * answers like an existing account (empty identities), so /signup said
--     "That email can't be signed up right now", AND
--   * quietly sends a "Confirm your email address" mail, whose link signs
--     them in to the INVITING workspace, not the one they were creating.
-- Checked locally 2026-10-12 with confirmations on.
--
-- signup_email_status(email) lets the signup action check first and skip
-- signUp entirely for a pending invite, with a message that says what to do.
-- It answers only 'invited' or null: never which workspace, never whether a
-- normal account exists (Supabase's own enumeration protection stays intact
-- for those). It does reveal that an unused invite exists for an address.
-- =============================================================================

create or replace function public.signup_email_status(p_email text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when exists (
    select 1
      from auth.users a
      join public.users u on u.id = a.id
     where lower(a.email) = lower(trim(p_email))
       and a.invited_at is not null
       and a.last_sign_in_at is null
  ) then 'invited' end;
$$;

revoke all on function public.signup_email_status(text) from public;
grant execute on function public.signup_email_status(text) to anon, authenticated;

-- Verify: scripts/test_team_invites.sql (runs in a rolled-back transaction).

-- End of 0087.
