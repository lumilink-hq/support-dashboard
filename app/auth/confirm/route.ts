import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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
  const next = searchParams.get("next") ?? "/conversations";

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }

  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent(
      "Email confirmation link is invalid or has expired.",
    )}`,
  );
}
