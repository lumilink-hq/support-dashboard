import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Who may open a /loyalty page (0206 staff + 0210 MFA, 0223 merchant admins of
// their own program). The database enforces the same thing inside every staff
// RPC, scoped to the program; this only picks the right page:
//   neither                        -> 404 (tenants never learn it exists)
//   staff, no authenticator yet    -> /loyalty/security to set one up
//   staff, session not MFA-checked -> /loyalty/security to enter a code
export type StaffAccess = "none" | "enroll" | "verify" | "ok";

export async function staffAccess(): Promise<StaffAccess> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("loyalty_staff_access");
  return (["none", "enroll", "verify", "ok"].includes(data as string) ? data : "none") as StaffAccess;
}

/** staff (every program) or merchant (their own only). For staff-only parts of a page. */
export async function managerRole(): Promise<"staff" | "merchant" | "none"> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("loyalty_manager_role");
  return data === "staff" || data === "merchant" ? data : "none";
}

export function securityPath(next: string): string {
  return `/loyalty/security?next=${encodeURIComponent(next)}`;
}

/** Call at the top of every /loyalty page except /loyalty/security. */
export async function requireStaffPage(path: string): Promise<void> {
  const access = await staffAccess();
  if (access === "none") notFound();
  if (access !== "ok") redirect(securityPath(path));
}

/** Only same-area paths, so ?next= can't send anyone off-site. */
export function safeNext(next: string | undefined): string {
  return next && /^\/loyalty(\/[\w\-/]*)?(\?[\w=&%\-]*)?$/.test(next) ? next : "/loyalty";
}
