// The auth-admin half of the team invite flow (0082). Service role, because
// creating, banning and deleting auth users has no RLS-scoped equivalent.
//
// NOTHING HERE DECIDES WHO MAY DO WHAT. Every function is called by
// app/(dashboard)/team/actions.ts only AFTER the matching RPC has run under
// the signed-in admin's own session and confirmed the target is on their team
// (team_require_admin / team_require_teammate in 0082). Calling these without
// that check is how one client removes another client's staff.

import { createServiceClient } from "@/lib/supabase/service";
import { siteOrigin } from "@/lib/google-oauth";

/** Where the invite email's link lands (via /auth/confirm) to set a password. */
export const SET_PASSWORD_PATH = "/account/password";

// Long enough to mean "until an admin reactivates". GoTrue takes a Go duration.
const BAN_FOREVER = "876000h";

/**
 * Send (or re-send) the Supabase invite email. Creates the auth user on first
 * send, which fires handle_new_user -> joins the invite's client.
 *
 * The email link only works if the "Invite user" template points at
 * /auth/confirm with token_hash (see supabase/templates/invite.html) — the
 * default template's ConfirmationURL puts the session in a URL fragment our
 * server route can't read.
 */
export async function sendInviteEmail(input: {
  email: string;
  fullName: string | null;
  clientName: string;
}): Promise<{ error: string | null }> {
  const service = createServiceClient();
  const { error } = await service.auth.admin.inviteUserByEmail(input.email, {
    redirectTo: `${siteOrigin()}${SET_PASSWORD_PATH}`,
    data: {
      ...(input.fullName ? { full_name: input.fullName } : {}),
      client_name: input.clientName,
    },
  });
  return { error: error?.message ?? null };
}

/**
 * Permanently delete a teammate's login (0086). public.users cascades; their
 * approvals, notes and keywords stay, with the "by" column set to null.
 */
export async function deleteTeamUser(userId: string): Promise<{ error: string | null }> {
  const { error } = await createServiceClient().auth.admin.deleteUser(userId);
  return { error: error?.message ?? null };
}

/** Block sign-in and token refresh for a removed teammate, or lift that. */
export async function setUserBanned(userId: string, banned: boolean): Promise<{ error: string | null }> {
  const { error } = await createServiceClient().auth.admin.updateUserById(userId, {
    ban_duration: banned ? BAN_FOREVER : "none",
  });
  return { error: error?.message ?? null };
}
