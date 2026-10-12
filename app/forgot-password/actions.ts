"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

/**
 * Send a password-reset email. The link goes through /auth/confirm (which
 * handles both the PKCE `code` link the default template sends and a
 * `token_hash` link from supabase/templates/recovery.html) and lands on
 * /account/password, signed in, to choose a new password.
 *
 * ALWAYS the same answer, whatever happened, so this page can't be used to
 * find out which emails have accounts. Failures are logged, not shown.
 */
export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) {
    redirect(`/forgot-password?error=${encodeURIComponent("Enter the email address you sign in with.")}`);
  }

  const hdrs = await headers();
  const origin = (
    process.env.NEXT_PUBLIC_SITE_URL ??
    (hdrs.get("origin") || `https://${hdrs.get("host") ?? "localhost:3000"}`)
  ).replace(/\/$/, "");

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/confirm?next=${encodeURIComponent("/account/password")}`,
  });
  if (error) console.error("[forgot-password] resetPasswordForEmail failed:", error.message);

  redirect("/forgot-password?sent=1");
}
