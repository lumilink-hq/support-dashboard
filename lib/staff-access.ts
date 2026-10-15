import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Who may open a LumiLink-staff page: /loyalty (0206 + 0210) and /outbound
// (0307). Both use platform_staff plus MFA, and the database enforces the same
// thing inside every staff RPC; this only picks the right page:
//   not staff                      -> 404 (tenants never learn it exists)
//   staff, no authenticator yet    -> the security page to set one up
//   staff, session not MFA-checked -> the security page to enter a code
// The MFA step lives at /loyalty/security for both areas. app/(dashboard)/loyalty/
// access.ts is the loyalty branch's own copy of this; it can switch to this file.
export type StaffAccess = "none" | "enroll" | "verify" | "ok";

/** Areas a staff page may live in; ?next= can only point inside one. */
export const STAFF_AREAS = ["/loyalty", "/outbound"] as const;

export async function staffAccess(): Promise<StaffAccess> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("loyalty_staff_access");
  return (["none", "enroll", "verify", "ok"].includes(data as string) ? data : "none") as StaffAccess;
}

export function securityPath(next: string): string {
  return `/loyalty/security?next=${encodeURIComponent(next)}`;
}

/** Call at the top of every staff page except the security page. */
export async function requireStaffPage(path: string): Promise<void> {
  const access = await staffAccess();
  if (access === "none") notFound();
  if (access !== "ok") redirect(securityPath(path));
}

/** Only paths inside a staff area, so ?next= can't send anyone off-site. */
export function safeNext(next: string | undefined): string {
  if (!next || !/^\/[\w\-/]*(\?[\w=&%\-]*)?$/.test(next)) return "/loyalty";
  const path = next.split("?")[0];
  return STAFF_AREAS.some((area) => path === area || path.startsWith(`${area}/`)) ? next : "/loyalty";
}
