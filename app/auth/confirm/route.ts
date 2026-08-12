import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/route-access";
import { landingPathAfterAuth } from "@/lib/post-auth";

/**
 * Email confirmation landing route.
 *
 * Supabase can send the user back here two ways depending on the email
 * template, so handle both:
 *   * PKCE link:  ?code=...                       -> exchangeCodeForSession
 *   * OTP link:   ?token_hash=...&type=signup     -> verifyOtp
 * On success the session cookie is set and we send them into the dashboard;
 * otherwise back to /login with an error.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);

  // MUST be sanitised: this value is concatenated onto `origin` below, and
  // `${origin}@evil.example` parses as userinfo + host — the browser goes to
  // evil.example while the link looked like ours. safeNextPath allows only
  // same-site absolute paths.
  const next = safeNextPath(searchParams.get("next"));

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const supabase = await createClient();

  // Where to land once the session exists. This is a brand-new customer's very
  // first authenticated request, so it is the single most important place to
  // send someone into onboarding rather than an empty dashboard.
  const landing = async () => `${origin}${await landingPathAfterAuth(next)}`;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(await landing());
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) return NextResponse.redirect(await landing());
  }

  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent(
      "Email confirmation link is invalid or has expired.",
    )}`,
  );
}
