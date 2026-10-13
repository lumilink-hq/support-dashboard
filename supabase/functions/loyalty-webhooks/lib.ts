// Pure helpers for loyalty-webhooks. No database, no Deno APIs (Web Crypto
// only), so scripts/test-loyalty-webhooks.ts tests them with tsx.
//
// Shopify webhook rules (shopify.dev "Deliver webhooks through HTTPS"): the
// X-Shopify-Hmac-Sha256 header is the BASE64 HMAC-SHA256 of the raw request
// body, keyed with the app's client secret. Verify against the raw bytes,
// before any JSON parsing.

export const TOPICS = [
  "orders/paid",
  "refunds/create",
  "customers/create",
  "customers/update",
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;
export type Topic = (typeof TOPICS)[number];

export function asTopic(t: string | null | undefined): Topic | null {
  const s = String(t ?? "").trim().toLowerCase();
  return (TOPICS as readonly string[]).includes(s) ? (s as Topic) : null;
}

export async function hmacBase64(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the header is Shopify's signature of the body under any of the secrets. */
export async function verifyWebhook(body: Uint8Array, header: string | null, secrets: string[]): Promise<boolean> {
  const given = (header ?? "").trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(given)) return false;
  let ok = false;
  for (const s of secrets) {
    if (s && constantTimeEqual(await hmacBase64(s, body), given)) ok = true;
  }
  return ok;
}

/** "12.3" -> 1230, "12.345" -> 1235 (half up), exact: no floating point. Null if not a decimal. */
export function moneyToCents(v: unknown): number | null {
  const s = String(v ?? "").trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[3] ?? "").padEnd(3, "0");
  let cents = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  return m[1] ? -cents : cents;
}

/** Shop-currency amount from a *_set object, falling back to the plain field. */
function shopMoney(set: unknown, plain: unknown): number | null {
  const amt = (set as { shop_money?: { amount?: unknown } } | null)?.shop_money?.amount;
  return moneyToCents(amt ?? plain);
}

export type CustomerIn = { id: number; email: string | null; first_name: string | null; last_name: string | null; state: string | null; created_at: string | null };

export function parseCustomer(c: unknown): CustomerIn | null {
  const o = c as Record<string, unknown> | null;
  const id = Number(o?.id);
  if (!o || !Number.isSafeInteger(id) || id <= 0) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    id,
    email: str(o.email),
    first_name: str(o.first_name),
    last_name: str(o.last_name),
    state: str(o.state),
    created_at: str(o.created_at),
  };
}

export type OrderIn = { id: number; name: string | null; processed_at: string | null; eligible_cents: number; customer: CustomerIn | null };

/**
 * orders/paid. Eligible = subtotal after discounts, before shipping and tax,
 * in the shop's currency.
 */
export function parseOrder(p: unknown): OrderIn | null {
  const o = p as Record<string, unknown> | null;
  const id = Number(o?.id);
  if (!o || !Number.isSafeInteger(id) || id <= 0) return null;
  const cents = shopMoney(o.subtotal_price_set, o.subtotal_price);
  return {
    id,
    name: typeof o.name === "string" ? o.name : null,
    processed_at: typeof o.processed_at === "string" ? o.processed_at : typeof o.created_at === "string" ? o.created_at : null,
    eligible_cents: Math.max(cents ?? 0, 0),
    customer: parseCustomer(o.customer),
  };
}

export type RefundIn = { id: number; order_id: number; created_at: string | null; cents: number };

/** refunds/create. Same basis as the order: refunded line subtotals, no shipping or tax. */
export function parseRefund(p: unknown): RefundIn | null {
  const o = p as Record<string, unknown> | null;
  const id = Number(o?.id);
  const orderId = Number(o?.order_id);
  if (!o || !Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(orderId) || orderId <= 0) return null;
  let cents = 0;
  for (const li of Array.isArray(o.refund_line_items) ? o.refund_line_items : []) {
    const l = li as Record<string, unknown>;
    cents += Math.max(shopMoney(l.subtotal_set, l.subtotal) ?? 0, 0);
  }
  return { id, order_id: orderId, created_at: typeof o.created_at === "string" ? o.created_at : null, cents };
}

/** customers/redact: the customer id to delete. */
export function parseRedactCustomerId(p: unknown): number | null {
  const id = Number((p as { customer?: { id?: unknown } } | null)?.customer?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
