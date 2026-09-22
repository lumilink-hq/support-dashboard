// lib/google-oauth.ts — per-tenant Google OAuth (module 2, plan.md).
//
// INCREMENTAL SCOPES BY DESIGN. Search Console needs no special API grant;
// Business Profile does (plan.md: up to 14 days, quota is zero until
// granted). So the initial "Connect Google" flow only ever requests the
// Search Console scope — GOOGLE_OAUTH_SCOPES_INITIAL — and a later,
// separate flow (built once the grant lands, Phase 4 / module 11's finish)
// requests GOOGLE_OAUTH_SCOPES_BUSINESS_PROFILE on top. The DB side already
// handles this: store_google_oauth_tokens (0046) UNIONS granted_scopes
// rather than overwriting, so the second grant doesn't drop the first.
//
// access_type=offline + prompt=consent are both required to reliably get a
// refresh token — Google only issues one on the FIRST consent by default;
// without prompt=consent, a user who already granted access silently gets
// an access-token-only response on re-auth.

export const GOOGLE_OAUTH_SCOPES_INITIAL = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/webmasters.readonly",
];

export const GOOGLE_OAUTH_SCOPES_BUSINESS_PROFILE = [
  "https://www.googleapis.com/auth/business.manage",
];

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export class GoogleOAuthError extends Error {}

function clientId(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!v) throw new GoogleOAuthError("GOOGLE_OAUTH_CLIENT_ID is not set.");
  return v;
}

function clientSecret(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!v) throw new GoogleOAuthError("GOOGLE_OAUTH_CLIENT_SECRET is not set.");
  return v;
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

/** Absolute origin this app is running at. Same var lib/services/billing.ts's
 * signup redirect construction relies on — see .env.local's own comment. */
export function siteOrigin(): string {
  const v = process.env.NEXT_PUBLIC_SITE_URL;
  if (!v) throw new GoogleOAuthError("NEXT_PUBLIC_SITE_URL is not set.");
  return v.replace(/\/$/, "");
}

export function googleOAuthRedirectUri(): string {
  return `${siteOrigin()}/api/oauth/google/callback`;
}

export function buildGoogleAuthUrl(input: { scopes: string[]; state: string }): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: googleOAuthRedirectUri(),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: input.scopes.join(" "),
    state: input.state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
};

/** Exchanges an authorization `code` for tokens. Called once, from the
 * callback route, right after Google redirects back with `code`. */
export async function exchangeGoogleAuthCode(code: string): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: googleOAuthRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new GoogleOAuthError(`Google token exchange failed: ${body.error ?? res.status} ${body.error_description ?? ""}`);
  }
  return body as GoogleTokenResponse;
}

export type GoogleRefreshError = { code: "invalid_grant" | "other"; message: string };

/** Exchanges a stored refresh token for a fresh access token. Called by the
 * scheduled edge function (google-token-refresh), never from a user request.
 * invalid_grant is Google's own signal that the grant was revoked — the
 * caller maps that specifically to status='revoked' (0046's
 * mark_google_oauth_error), everything else to a retryable 'error'. */
export async function refreshGoogleAccessToken(
  refreshToken: string,
): Promise<{ ok: true; token: GoogleTokenResponse } | { ok: false; error: GoogleRefreshError }> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    const code = body.error === "invalid_grant" ? "invalid_grant" : "other";
    return { ok: false, error: { code, message: `${body.error ?? res.status} ${body.error_description ?? ""}`.trim() } };
  }
  return { ok: true, token: body as GoogleTokenResponse };
}

/** Revokes the grant with Google itself. Best-effort: a failure here (e.g.
 * the token was already revoked) should never block the local disconnect
 * that follows it. */
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch (e) {
    console.warn("[google-oauth] revoke call failed (continuing with local disconnect):", String(e));
  }
}

export async function fetchGoogleAccountEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const body = await res.json();
  return typeof body.email === "string" ? body.email : null;
}
