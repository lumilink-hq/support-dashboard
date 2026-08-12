"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/route-access";

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

  // The onboarding archetype. Asked here rather than in the wizard because it
  // decides WHICH wizard they see — an HVAC company should never be shown the
  // store-connection step, and a shop should never be asked for call-out fees.
  //
  // Validated here and again in handle_new_user (0034). This value travels
  // through auth metadata, which is client-supplied, so the trigger treats
  // anything unrecognised as null rather than trusting it.
  const rawType = String(formData.get("business_type") ?? "").trim().toLowerCase();
  const businessType =
    rawType === "service" || rawType === "ecommerce" ? rawType : null;

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

  // Guard against the most common misconfiguration: missing public env vars,
  // which otherwise produces an empty/unhelpful error from the Supabase client.
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    fail(
      "Server isn't configured: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are missing.",
    );
  }

  // Carry the post-confirmation destination through the email link, so someone
  // who started at /plans lands back on checkout instead of the conversations
  // list. /auth/confirm sanitises it again before redirecting.
  const next = safeNextPath(formData.get("next") as string | null);
  const confirmUrl =
    next === "/conversations"
      ? `${origin}/auth/confirm`
      : `${origin}/auth/confirm?next=${encodeURIComponent(next)}`;

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        business_name: businessName,
        full_name: fullName,
        // Read by handle_new_user (0034), which writes clients.business_type;
        // the 0032 trigger then derives the agent mode from it.
        ...(businessType ? { business_type: businessType } : {}),
      },
      emailRedirectTo: confirmUrl,
    },
  });

  if (error) {
    // Log the full error server-side (visible in the `next dev` terminal) and
    // show the user a readable message even when `message` is empty.
    console.error("[signup] auth.signUp failed:", error);
    const detail =
      error.message ||
      [error.name, error.status && `status ${error.status}`]
        .filter(Boolean)
        .join(" ") ||
      "Sign-up failed. Please try again.";
    fail(detail);
  }

  // ---------------------------------------------------------------------------
  // THE TWO SILENT SUCCESSES.
  //
  // signUp resolves without an error in two cases where NO EMAIL IS SENT, and
  // the old code redirected to "check your inbox" for both. Someone then waits
  // for a message that was never going to arrive, and the logs say nothing —
  // which is exactly how "our confirmation emails aren't working" turns into a
  // day of looking in the wrong place.
  //
  // 1. EMAIL ALREADY REGISTERED. With confirmation enabled, Supabase returns a
  //    success with an obfuscated user and an EMPTY `identities` array rather
  //    than admitting the address exists (user-enumeration protection). No mail
  //    is sent, because the account already exists.
  //
  //    We keep that protection — the message below does not confirm the address
  //    is registered, it just points at sign-in and reset, which is useful to
  //    both a returning user and a stranger, and reveals nothing either way.
  //
  // 2. EMAIL CONFIRMATION TURNED OFF in the project's Auth settings. Then
  //    signUp returns a live SESSION, the user is already signed in, and no
  //    confirmation mail exists to send. Telling them to check their inbox
  //    while they are holding a valid session is a config bug wearing a
  //    success message, so we log it loudly and send them into the app.
  // ---------------------------------------------------------------------------
  if (data?.user && (data.user.identities?.length ?? 0) === 0) {
    fail(
      "That email can't be signed up right now. If you already have an account, sign in instead — or reset your password.",
    );
  }

  if (data?.session) {
    console.warn(
      "[signup] Supabase returned a session on signUp, which means email " +
        "confirmation is DISABLED for this project. No confirmation email was " +
        "sent. Enable it under Authentication > Providers > Email, and make " +
        "sure custom SMTP is configured — the built-in service refuses to " +
        "deliver to addresses outside the project team. See docs/AUTH-EMAIL-SETUP.md.",
    );
    redirect(next);
  }

  redirect("/signup?confirm=1");
}
