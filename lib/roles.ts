// Who may do what in a workspace (0082 / 0083). The labels match /team:
//   admin  — everything, including settings, billing and the team
//   agent  — day-to-day use: approvals, the review queue
//   viewer — read only
//
// These checks are for the UI and for writes the app makes with the service
// role (billing, draft edits). Tenant writes through PostgREST are gated in the
// database too (current_user_can_act(), 0083), because the anon key is public.

import { createClient } from "@/lib/supabase/server";

export type Role = "admin" | "agent" | "viewer";

export type Membership = { userId: string; clientId: string; role: Role };

/** The signed-in user's client and role, or null if signed out, unlinked or removed. */
export async function getMembership(): Promise<Membership | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("users")
    .select("client_id, role, is_active")
    .eq("id", user.id)
    .maybeSingle();
  if (!data || !data.is_active) return null;
  return { userId: user.id, clientId: data.client_id as string, role: data.role as Role };
}

/** Day-to-day actions: approve drafts, work the review queue. */
export function canAct(role: Role | null | undefined): boolean {
  return role === "admin" || role === "agent";
}

/** Billing, settings, the team. */
export function isAdmin(role: Role | null | undefined): boolean {
  return role === "admin";
}

export const READ_ONLY_MESSAGE = "You have view-only access. Ask an admin on your team to change your role.";
export const ADMIN_ONLY_BILLING_MESSAGE = "Only admins can change billing. Ask an admin on your team.";
