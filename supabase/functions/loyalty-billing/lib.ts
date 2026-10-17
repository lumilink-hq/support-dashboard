// Pure helpers for loyalty-billing (0224). No database, no Deno APIs, so
// scripts/test-loyalty-billing.ts tests them with tsx.
//
// Shopify App Pricing (shopify.dev, checked 2026-10-16):
//   * Usage: POST https://api.shopify.com/app/<version>/events, one event per
//     request: {shop_id, event_handle, timestamp, idempotency_key (<= 64),
//     attributes: {value}}. 202 = received (billing errors show only in the Dev
//     Dashboard logs). 409 = same key still processing, 429 = rate limit.
//     Billing idempotency keys dedupe permanently.
//   * Auth for it: POST https://api.shopify.com/auth/access_token with
//     {client_id, client_secret, grant_type: "client_credentials"}, 60 min token.
//   * Plan: Partner API activeSubscription(appId, shopId) -> items[].handle,
//     null = no paid subscription. Public apps only.

export const APP_EVENTS_VERSION = "2026-10";
export const ORDER_METER = "orders";

export type UsageEvent = {
  shop_id: string;
  event_handle: string;
  timestamp: string;
  idempotency_key: string;
  attributes: { value: number };
};

/** Stable per program + order, at most 64 chars: a retry or a replayed webhook is the same event. */
export function idempotencyKey(programId: string, orderId: number | string): string {
  return `ll-order-${programId.replace(/-/g, "").slice(0, 16)}-${orderId}`.slice(0, 64);
}

/** Events can't be more than 5 minutes in the future, so a clock-skewed time is pulled back to now. */
export function usageEvent(input: { shopGid: string; programId: string; orderId: number | string; occurredAt: string; now?: Date }): UsageEvent {
  const now = input.now ?? new Date();
  const t = new Date(input.occurredAt);
  const ts = Number.isNaN(t.getTime()) || t.getTime() > now.getTime() ? now : t;
  return {
    shop_id: input.shopGid,
    event_handle: ORDER_METER,
    timestamp: ts.toISOString(),
    idempotency_key: idempotencyKey(input.programId, input.orderId),
    attributes: { value: 1 },
  };
}

/** sent: done. retry: try again later. fail: counts as an attempt with the error. */
export function classifyEventResponse(status: number): "sent" | "retry" | "fail" {
  if (status === 202 || status === 200) return "sent";
  if (status === 409 || status === 429 || status >= 500) return "retry";
  return "fail";
}

/**
 * The plan key for an activeSubscription result. handles maps Shopify plan
 * handle -> our plan key. No subscription = free. A subscription whose handle we
 * don't know returns null (leave the plan alone and log it).
 */
export function planFromSubscription(sub: unknown, handles: Record<string, string>): string | null {
  if (sub === null || sub === undefined) return "free";
  const items = (sub as { items?: { handle?: unknown }[] }).items ?? [];
  for (const it of items) {
    const h = typeof it?.handle === "string" ? it.handle : "";
    if (h && handles[h]) return handles[h];
  }
  return null;
}

export const ACTIVE_SUBSCRIPTION_QUERY = `query LoyaltyActiveSubscription($appId: ID!, $shopId: ID!) {
  activeSubscription(appId: $appId, shopId: $shopId) {
    cancelAtEndOfCycle
    trialEndsAt
    items { handle }
  }
}`;
