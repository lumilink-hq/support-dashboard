// GET /api/oauth/google/callback — Google redirects here after consent.
//
// Runs under the signed-in user's own session (this is a normal browser
// navigation with the app's session cookie attached, not a webhook) — so it
// calls store_google_oauth_tokens (0046) through the RLS-scoped server
// client, same as every onboarding action. No service-role client, matching
// lib/supabase/service.ts's "confined to lib/services/billing.ts" rule.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  exchangeGoogleAuthCode,
  fetchGoogleAccountEmail,
} from "@/lib/google-oauth";
import { GOOGLE_OAUTH_STATE_COOKIE } from "../connect/route";

function redirectToSettings(origin: string, params: Record<string, string>) {
  const url = new URL("/settings", origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);

  const error = searchParams.get("error");
  if (error) {
    // The user clicked "Cancel" on Google's consent screen, or denied a
    // scope. Not a bug — just tell them nothing was connected.
    return redirectToSettings(origin, { google_error: "Connection cancelled." });
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const cookieState = request.headers
    .get("cookie")
    ?.split("; ")
    .find((c) => c.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=`))
    ?.split("=")[1];

  if (!code || !state || !cookieState || state !== cookieState) {
    return redirectToSettings(origin, {
      google_error: "That connection link expired or was invalid — try again.",
    });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login?next=%2Fsettings", origin));
  }

  try {
    const token = await exchangeGoogleAuthCode(code);
    const email = await fetchGoogleAccountEmail(token.access_token);

    const { data, error: rpcError } = await supabase.rpc("store_google_oauth_tokens", {
      p_refresh_token: token.refresh_token ?? null,
      p_access_token: token.access_token,
      p_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      p_scopes: token.scope.split(" ").filter(Boolean),
      p_account_email: email,
    });

    if (rpcError || !data?.ok) {
      const reason = rpcError?.message ?? data?.error ?? "unknown_error";
      // no_refresh_token_on_first_connect: Google didn't issue one, which
      // only happens if prompt=consent somehow didn't take effect. Send them
      // through connect again rather than leaving a half-connected state.
      return redirectToSettings(origin, {
        google_error: `Couldn't finish connecting Google (${reason}). Try again.`,
      });
    }

    const response = redirectToSettings(origin, { google: "connected" });
    response.cookies.delete(GOOGLE_OAUTH_STATE_COOKIE);
    return response;
  } catch (e) {
    console.error("[google-oauth-callback] failed:", e);
    return redirectToSettings(origin, {
      google_error: "Couldn't finish connecting Google. Try again.",
    });
  }
}
