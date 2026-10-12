-- =============================================================================
-- 0086_team_remove_permanently.sql — Remove on /team deletes the person.
--
-- 0082 deactivated anyone who had ever signed in (is_active = false + a ban)
-- and only deleted never-used invites. In use (2026-10-12) that read as "not
-- really removed": the person stayed listed, the email couldn't be invited
-- again, and signing in said "User is banned".
--
-- Now remove_team_member always answers 'delete' and the app deletes the auth
-- user; public.users goes with it (on delete cascade). Their history stays:
-- every reference to users is ON DELETE SET NULL (approved_by, author_id,
-- enabled_by, ...), so approvals and notes remain, unattributed. Checked
-- 2026-10-12 against an agent with an approval and a ticket note.
--
-- People 0082 already deactivated are still listed as Removed, with
-- Reactivate (reactivate_team_member, unchanged) or Remove permanently (this).
-- =============================================================================

create or replace function public.remove_team_member(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.team_require_teammate(p_user_id);
  return 'delete';
end;
$$;

revoke all on function public.remove_team_member(uuid) from public, anon;
grant execute on function public.remove_team_member(uuid) to authenticated;

-- Verify: scripts/test_team_invites.sql (runs in a rolled-back transaction).

-- End of 0086.
