// GET /api/oauth/google/connect — starts the "Connect Google" flow.
//
// STATE COOKIE, NOT A BARE REDIRECT. Google's `state` param is this app's
// only CSRF defense on the callback: without it, an attacker could craft
// their own Google consent flow and trick a signed-in victim into landing on
// /api/oauth/google/callback with the attacker's authorization code, linking
// the attacker's Google account to the victim's LumiLink client. A random
// nonce, set in an httpOnly cookie here and compared against the `state`
// Google echoes back on /callback, closes that.
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { buildGoogleAuthUrl, GOOGLE_OAUTH_SCOPES_INITIAL, isGoogleOAuthConfigured } from "@/lib/google-oauth";

export const GOOGLE_OAUTH_STATE_COOKIE = "google_oauth_state";

export async function GET() {
  if (!isGoogleOAuthConfigured()) {
    return NextResponse.redirect(
      new URL("/settings?error=" + encodeURIComponent("Google connect isn't configured yet."), process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login?next=%2Fsettings", process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"));
  }

  const state = randomBytes(24).toString("hex");
  const authUrl = buildGoogleAuthUrl({ scopes: GOOGLE_OAUTH_SCOPES_INITIAL, state });

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(GOOGLE_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes — long enough for a real consent flow, short enough to limit replay
  });
  return response;
}
