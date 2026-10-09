// Pure helpers for shopify-oauth. No database, no Deno APIs (Web Crypto only,
// which Node 20 also has), so scripts/test-shopify-oauth.ts tests them with tsx.
// Rules from Shopify's "implement authorization code grants manually"
// (read 2026-10-09): HMAC-SHA256 over every query parameter except hmac,
// sorted by key and joined as key=value with &, hex digest, compared in
// constant time; shop must match the anchored *.myshopify.com pattern.

/** Shopify's own pattern, anchored at both ends. Lowercased before storing. */
export function validShop(shop: string | null | undefined): string | null {
  const s = String(shop ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null;
}

/** The message Shopify signs: every param but hmac (and the legacy signature), sorted, key=value&... */
export function hmacMessage(params: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of params) {
    if (k === "hmac" || k === "signature") continue;
    pairs.push([k, v]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the request's hmac is Shopify's signature with this app's secret. */
export async function verifyHmac(params: URLSearchParams, secret: string): Promise<boolean> {
  const given = (params.get("hmac") ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  return constantTimeEqual(await hmacHex(secret, hmacMessage(params)), given);
}

/** The app's credentials from Vault: JSON {"client_id","client_secret"}. */
export function parseAppCredentials(secret: string | null): { clientId: string; clientSecret: string } | null {
  if (!secret) return null;
  try {
    const p = JSON.parse(secret);
    if (typeof p?.client_id === "string" && p.client_id && typeof p?.client_secret === "string" && p.client_secret) {
      return { clientId: p.client_id, clientSecret: p.client_secret };
    }
  } catch {
    // not JSON
  }
  return null;
}

/** Offline (no grant_options[]=per-user) authorize URL. */
export function authorizeUrl(input: { shop: string; clientId: string; scopes: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: input.clientId,
    scope: input.scopes,
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `https://${input.shop}/admin/oauth/authorize?${q.toString()}`;
}

export type TokenResult = { ok: true; token: string; scopes: string[] } | { ok: false; error: string };

/** The token endpoint's answer. Non-expiring offline token: no `expiring=1` is sent. */
export function parseTokenResponse(status: number, body: string): TokenResult {
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(body);
  } catch {
    return { ok: false, error: `token endpoint ${status}: not JSON` };
  }
  if (status < 200 || status >= 300 || typeof j.access_token !== "string" || !j.access_token) {
    const why = typeof j.error_description === "string" ? j.error_description : typeof j.error === "string" ? j.error : "no access_token";
    return { ok: false, error: `token endpoint ${status}: ${why}` };
  }
  const scopes = typeof j.scope === "string" ? j.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return { ok: true, token: j.access_token, scopes };
}

export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

/** Where the person lands afterwards: /seo > Settings with a notice or an error. */
export function portalUrl(base: string, outcome: { notice?: string; error?: string }): string {
  const u = new URL("/seo", base);
  u.searchParams.set("tab", "settings");
  if (outcome.notice) u.searchParams.set("notice", outcome.notice);
  if (outcome.error) u.searchParams.set("error", outcome.error);
  u.hash = "shopify";
  return u.toString();
}
