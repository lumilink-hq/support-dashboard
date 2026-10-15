// Pure helpers for loyalty-proxy (0204). No database, no Deno APIs (Web
// Crypto only), so scripts/test-loyalty-proxy.ts tests them with tsx.
//
// App proxy signature (shopify.dev "Authenticate app proxies", read
// 2026-10-13): every query parameter except `signature`, values NOT
// url-encoded, repeated keys joined with ",", each as key=value, sorted, then
// concatenated with NO separator; hex HMAC-SHA256 with the app's client
// secret. Only the query string is signed: a POST body is not, so writes must
// never trust the body for identity (logged_in_customer_id is in the query).

import { validShop } from "../shopify-oauth/lib.ts";

export function proxyMessage(params: URLSearchParams): string {
  const grouped = new Map<string, string[]>();
  for (const [k, v] of params) {
    if (k === "signature") continue;
    grouped.set(k, [...(grouped.get(k) ?? []), v]);
  }
  return [...grouped.entries()]
    .map(([k, vs]) => `${k}=${vs.join(",")}`)
    .sort()
    .join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
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

export type ProxyAuth =
  | { ok: true; shop: string; customerId: number | null }
  | { ok: false; reason: "bad_shop" | "bad_signature" | "stale" };

/**
 * Verifies the proxy signature against any of the shop's app secrets and the
 * timestamp (maxAgeSec; Shopify signs each request as it proxies it, so a
 * fresh page never trips this). customerId null = not logged in.
 */
export async function verifyProxy(params: URLSearchParams, secrets: string[], nowSec: number, maxAgeSec = 300): Promise<ProxyAuth> {
  const shop = validShop(params.get("shop"));
  if (!shop) return { ok: false, reason: "bad_shop" };
  const given = (params.get("signature") ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return { ok: false, reason: "bad_signature" };
  const want = proxyMessage(params);
  let match = false;
  for (const s of secrets) if (s && constantTimeEqual(await hmacHex(s, want), given)) match = true;
  if (!match) return { ok: false, reason: "bad_signature" };
  const ts = Number(params.get("timestamp"));
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > maxAgeSec) return { ok: false, reason: "stale" };
  const raw = params.get("logged_in_customer_id") ?? "";
  const id = Number(raw);
  return { ok: true, shop, customerId: raw && Number.isSafeInteger(id) && id > 0 ? id : null };
}

export type Route = "state" | "redeem" | "birthday" | "claim" | "referral" | null;

/** The route after the function's own path: /loyalty-proxy/redeem -> "redeem". */
export function route(pathname: string, method: string): Route {
  const last = pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (method === "GET" && (last === "state" || last === "loyalty-proxy")) return "state";
  if (method === "POST" && ["redeem", "birthday", "claim", "referral"].includes(last)) return last as Route;
  return null;
}

/** YYYY-MM-DD that is a real calendar date, or null. */
export function parseBirthday(v: unknown): string | null {
  const s = String(v ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? s : null;
}

export function parseEmail(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
}

/** A client-generated idempotency key for a redeem (8-100 safe chars). */
export function parseRequestKey(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^[A-Za-z0-9_-]{8,100}$/.test(s) ? s : null;
}

export function parseKey(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^[a-z0-9_]{1,60}$/.test(s) ? s : null;
}

export function parseReferralCode(v: unknown): string | null {
  const s = String(v ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{4,20}$/.test(s) ? s : null;
}
