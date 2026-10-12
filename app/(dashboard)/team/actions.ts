"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { deleteInvitedUser, sendInviteEmail, setUserBanned } from "@/lib/services/team-invites";

// Every action runs its 0082 RPC under the admin's own session FIRST. The RPC
// is the authorization (admin, same client, not yourself); the service-role
// call in lib/services/team-invites.ts only follows once it has passed.

const ROLES = ["admin", "agent", "viewer"] as const;
type Role = (typeof ROLES)[number];

function done(query: string): never {
  revalidatePath("/team");
  redirect(`/team?${query}`);
}

function fail(message: string): never {
  redirect(`/team?error=${encodeURIComponent(message)}`);
}

function readRole(formData: FormData): Role {
  const role = String(formData.get("role") ?? "");
  if (!(ROLES as readonly string[]).includes(role)) fail("Pick a role.");
  return role as Role;
}

async function clientName(supabase: Awaited<ReturnType<typeof createClient>>): Promise<string> {
  const { data } = await supabase.from("clients").select("name").maybeSingle();
  return (data?.name as string | undefined) ?? "your team";
}

export async function inviteTeammate(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const fullName = String(formData.get("full_name") ?? "").trim() || null;
  const role = readRole(formData);

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_team_invite", {
    p_email: email,
    p_full_name: fullName ?? "",
    p_role: role,
  });
  if (error) fail(error.message);

  const sent = await sendInviteEmail({ email, fullName, clientName: await clientName(supabase) });
  if (sent.error) {
    // The invite row is saved, so it shows as Invited with a Resend button.
    fail(`Invite saved, but the email didn't send: ${sent.error}. Try Resend in a minute.`);
  }

  done(`invited=${encodeURIComponent(email)}`);
}

export async function resendInvite(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();

  const supabase = await createClient();
  const { data: ok, error } = await supabase.rpc("team_invite_resendable", { p_email: email });
  if (error) fail(error.message);
  if (!ok) fail("That invite has already been used or withdrawn.");

  const sent = await sendInviteEmail({ email, fullName: null, clientName: await clientName(supabase) });
  if (sent.error) fail(`The email didn't send: ${sent.error}`);

  done(`invited=${encodeURIComponent(email)}`);
}

export async function changeRole(formData: FormData) {
  const userId = String(formData.get("user_id") ?? "");
  const role = readRole(formData);

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_team_member_role", { p_user_id: userId, p_role: role });
  if (error) fail(error.message);

  done("saved=1");
}

export async function removeTeammate(formData: FormData) {
  const userId = String(formData.get("user_id") ?? "");
  const email = String(formData.get("email") ?? "");

  const supabase = await createClient();

  // An invite row with no auth user yet: nothing to ban or delete.
  if (!userId) {
    const { error } = await supabase.rpc("withdraw_team_invite", { p_email: email });
    if (error) fail(error.message);
    done("removed=1");
  }

  const { data: next, error } = await supabase.rpc("remove_team_member", { p_user_id: userId });
  if (error) fail(error.message);

  const result = next === "delete" ? await deleteInvitedUser(userId) : await setUserBanned(userId, true);
  if (result.error) fail(`Removed from the team, but signing them out failed: ${result.error}`);

  done("removed=1");
}

export async function reactivateTeammate(formData: FormData) {
  const userId = String(formData.get("user_id") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.rpc("reactivate_team_member", { p_user_id: userId });
  if (error) fail(error.message);

  const result = await setUserBanned(userId, false);
  if (result.error) fail(`Reactivated, but restoring their sign-in failed: ${result.error}`);

  done("saved=1");
}
