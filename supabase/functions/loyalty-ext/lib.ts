// Pure helpers for loyalty-ext (0212). No database, no Deno APIs (Web Crypto
// only), so scripts/test-loyalty-ext.ts tests them with tsx.
//
// Shopify session tokens (checkout and customer account UI extensions,
// shopify.dev "Session Token API", read 2026-10-15): a JWT signed HS256 with
// the app's client secret. aud = the app's client id, dest = the shop
// (checkout: "store.myshopify.com"; some surfaces send "https://..."),
// sub = the customer's GID, absent for a guest buyer. Expires 5 minutes
// after issue. Only the verified claims are trusted, never the request.

import { validShop } from "../shopify-oauth/lib.ts";

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  try {
    const bin = atob(pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

const b64urlJson = (s: string): Record<string, unknown> | null => {
  const bytes = b64urlToBytes(s);
  if (!bytes) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

/** Claims a token carries before it's verified: picks the app secret by aud. */
export function peekClaims(token: string): { aud: string; shop: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const c = b64urlJson(parts[1]);
  const aud = Array.isArray(c?.aud) ? String(c?.aud[0] ?? "") : String(c?.aud ?? "");
  const shop = validShop(String(c?.dest ?? "").replace(/^https:\/\//, "").replace(/\/+$/, ""));
  return aud && shop ? { aud, shop } : null;
}

export type ExtAuth =
  | { ok: true; shop: string; aud: string; customerId: number | null }
  | { ok: false; reason: "malformed" | "bad_alg" | "bad_signature" | "expired" | "not_yet" | "bad_claims" };

/** Verifies an HS256 session token for this app (aud) and returns its shop and customer. */
export async function verifySessionToken(token: string, clientId: string, secret: string, nowSec: number, leewaySec = 10): Promise<ExtAuth> {
  const parts = token.split(".");
  if (parts.length !== 3 || !secret) return { ok: false, reason: "malformed" };
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  const sig = b64urlToBytes(parts[2]);
  if (!header || !claims || !sig) return { ok: false, reason: "malformed" };
  if (header.alg !== "HS256") return { ok: false, reason: "bad_alg" };

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))) {
    return { ok: false, reason: "bad_signature" };
  }

  const exp = Number(claims.exp);
  const nbf = claims.nbf === undefined ? null : Number(claims.nbf);
  if (!Number.isFinite(exp) || nowSec > exp + leewaySec) return { ok: false, reason: "expired" };
  if (nbf !== null && (!Number.isFinite(nbf) || nowSec + leewaySec < nbf)) return { ok: false, reason: "not_yet" };

  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud ?? "")];
  const shop = validShop(String(claims.dest ?? "").replace(/^https:\/\//, "").replace(/\/+$/, ""));
  if (!aud.includes(clientId) || !shop) return { ok: false, reason: "bad_claims" };

  let customerId: number | null = null;
  if (claims.sub !== undefined && claims.sub !== null && claims.sub !== "") {
    customerId = gidId(String(claims.sub), "Customer");
    if (customerId === null) return { ok: false, reason: "bad_claims" };
  }
  return { ok: true, shop, aud: clientId, customerId };
}

/** gid://shopify/<type>/<id> -> id, or null. A bare positive integer is accepted too. */
export function gidId(v: unknown, type: string): number | null {
  const s = String(v ?? "").trim();
  const m = new RegExp(`^(?:gid://shopify/${type}/)?(\\d{1,19})$`).exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function bearer(header: string | null): string | null {
  const m = /^Bearer\s+([A-Za-z0-9_\-.]{20,4096})$/.exec(header ?? "");
  return m ? m[1] : null;
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};
