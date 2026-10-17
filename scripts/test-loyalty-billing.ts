// =============================================================================
// test-loyalty-billing.ts — unit tests for loyalty-billing/lib.ts (0224):
// App Events usage event shape, idempotency keys, response handling, and the
// Partner API plan mapping.
//
//   npx tsx scripts/test-loyalty-billing.ts
//
// No network, no Deno, no database.
// =============================================================================

import { classifyEventResponse, idempotencyKey, planFromSubscription, usageEvent } from "../supabase/functions/loyalty-billing/lib.ts";

let passed = 0;
let failed = 0;

function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

const prog = "9be3a5fe-da1d-4b2b-b09d-f3f6f5d5903a";

// Idempotency: stable, per program + order, within Shopify's 64 characters.
eq("key: stable", idempotencyKey(prog, 1234), idempotencyKey(prog, "1234"));
eq("key: differs by order", idempotencyKey(prog, 1) === idempotencyKey(prog, 2), false);
eq("key: differs by program", idempotencyKey(prog, 1) === idempotencyKey("00000000-0000-0000-0000-000000000001", 1), false);
eq("key: at most 64 chars", idempotencyKey(prog, 9_999_999_999_999).length <= 64, true);

// Event body.
const now = new Date("2026-10-16T20:00:00Z");
eq("event: shape", usageEvent({ shopGid: "gid://shopify/Shop/1", programId: prog, orderId: 55, occurredAt: "2026-10-16T19:59:00Z", now }), {
  shop_id: "gid://shopify/Shop/1",
  event_handle: "orders",
  timestamp: "2026-10-16T19:59:00.000Z",
  idempotency_key: idempotencyKey(prog, 55),
  attributes: { value: 1 },
});
eq("event: future time pulled back to now",
  usageEvent({ shopGid: "g", programId: prog, orderId: 1, occurredAt: "2026-10-16T21:00:00Z", now }).timestamp, now.toISOString());
eq("event: bad time -> now", usageEvent({ shopGid: "g", programId: prog, orderId: 1, occurredAt: "nope", now }).timestamp, now.toISOString());

// Responses.
eq("202 sent", classifyEventResponse(202), "sent");
eq("409 retry", classifyEventResponse(409), "retry");
eq("429 retry", classifyEventResponse(429), "retry");
eq("503 retry", classifyEventResponse(503), "retry");
eq("400 fail", classifyEventResponse(400), "fail");
eq("403 fail", classifyEventResponse(403), "fail");

// Plan mapping.
const handles = { free: "free", starter: "starter", growth: "growth", pro: "pro" };
eq("plan: none = free", planFromSubscription(null, handles), "free");
eq("plan: growth", planFromSubscription({ items: [{ handle: "growth" }] }, handles), "growth");
eq("plan: usage item first, plan second", planFromSubscription({ items: [{ handle: "orders" }, { handle: "pro" }] }, handles), "pro");
eq("plan: unknown handle", planFromSubscription({ items: [{ handle: "legacy-gold" }] }, handles), null);
eq("plan: no items", planFromSubscription({ items: [] }, handles), null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
