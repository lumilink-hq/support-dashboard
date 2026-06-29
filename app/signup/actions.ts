"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Self-serve signup. Creates the auth user with the workspace + name in
 * metadata; the `handle_new_user` trigger (migration 0003) provisions the
 * matching clients + users rows. Email confirmation is required, so we don't
 * get a session here — we send the user to a "check your inbox" state.
 */
export async function signup(formData: FormData) {
  const businessName = String(formData.get("business_name") ?? "").trim();
  const fullName = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  const fail = (message: string) =>
    redirect(`/signup?error=${encodeURIComponent(message)}`);

  if (!businessName) fail("Enter your business name.");
  if (!email) fail("Enter your email address.");
  if (password.length < 8) fail("Password must be at least 8 characters.");

  // Where Supabase sends the user after they click the confirmation link.
  // Prefer an explicit site URL; fall back to the request's own origin.
  const hdrs = await headers();
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (hdrs.get("origin") ||
      `https://${hdrs.get("host") ?? "localhost:3000"}`);

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { business_name: businessName, full_name: fullName },
      emailRedirectTo: `${origin}/auth/confirm`,
    },
  });

  if (error) {
    fail(error.message || "Sign-up failed. Please try again.");
  }

  redirect("/signup?confirm=1");
}
