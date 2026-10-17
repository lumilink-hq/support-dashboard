// Shopify admin session tokens for the LL Loyalty embedded admin (0225).
// Pure (node:crypto only), so scripts/test-loyalty-embedded-token.ts tests it.
//
// App Bridge's shopify.idToken() returns a JWT signed HS256 with the app's
// client secret: iss = https://<shop>/admin, dest = https://<shop>, aud = the
// app's client id, sub = the Shopify staff user id, exp about 1 minute after
// issue. Only the verified claims are trusted, never anything else the
// request says.

import { createHmac, timingSafeEqual } from "node:crypto";

export type AdminSession = { shop: string; userId: string; clientId: string };
export type VerifyResult =
  | ({ ok: true } & AdminSession)
  | { ok: false; reason: "malformed" | "bad_alg" | "bad_signature" | "expired" | "not_yet" | "bad_claims" };

const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function b64urlJson(s: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function shopFrom(url: unknown, suffix = ""): string | null {
  const m = /^https:\/\/([^/]+)(\/.*)?$/.exec(String(url ?? ""));
  if (!m || (m[2] ?? "") !== suffix) return null;
  const shop = m[1].toLowerCase();
  return SHOP.test(shop) ? shop : null;
}

/** Claims before verification, to pick the app secret by aud. Never trust these. */
export function peekSession(token: string): { clientId: string; shop: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const c = b64urlJson(parts[1]);
  const clientId = Array.isArray(c?.aud) ? String(c?.aud[0] ?? "") : String(c?.aud ?? "");
  const shop = shopFrom(c?.dest);
  return clientId && shop ? { clientId, shop } : null;
}

export function verifyAdminSession(token: string, clientId: string, secret: string, nowSec: number, leewaySec = 10): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3 || !secret) return { ok: false, reason: "malformed" };
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  if (!header || !claims || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return { ok: false, reason: "malformed" };
  if (header.alg !== "HS256") return { ok: false, reason: "bad_alg" };

  const want = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "bad_signature" };

  const exp = Number(claims.exp);
  const nbf = claims.nbf === undefined ? null : Number(claims.nbf);
  if (!Number.isFinite(exp) || nowSec > exp + leewaySec) return { ok: false, reason: "expired" };
  if (nbf !== null && (!Number.isFinite(nbf) || nowSec + leewaySec < nbf)) return { ok: false, reason: "not_yet" };

  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud ?? "")];
  const shop = shopFrom(claims.dest);
  const issShop = shopFrom(claims.iss, "/admin");
  const userId = String(claims.sub ?? "");
  if (!aud.includes(clientId) || !shop || issShop !== shop || !/^[0-9]{1,20}$/.test(userId)) {
    return { ok: false, reason: "bad_claims" };
  }
  return { ok: true, shop, userId, clientId };
}

export function bearer(header: string | null): string | null {
  const m = /^Bearer\s+([A-Za-z0-9_\-.]{20,4096})$/.exec(header ?? "");
  return m ? m[1] : null;
}
