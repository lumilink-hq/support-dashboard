// =============================================================================
// test-loyalty-backfill.ts — unit tests for loyalty-backfill/lib.ts (0201):
// the order search string, GraphQL node mapping and throttle maths.
//
//   npx tsx scripts/test-loyalty-backfill.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  customerJson,
  isThrottled,
  ordersSearch,
  parseCustomersPage,
  parseOrdersPage,
  throttleWaitMs,
} from "../supabase/functions/loyalty-backfill/lib.ts";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, got?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
  }
}

function eq(label: string, got: unknown, want: unknown) {
  ok(label, JSON.stringify(got) === JSON.stringify(want), got);
}

function main() {
  eq(
    "search: paid-ever orders before the cut-off, UTC",
    ordersSearch("2026-10-13T08:30:00-07:00"),
    "processed_at:<'2026-10-13T15:30:00.000Z' AND (financial_status:paid OR financial_status:partially_refunded OR financial_status:refunded)",
  );

  const alice = { legacyResourceId: "77", firstName: "Alice", lastName: null, state: "ENABLED", createdAt: "2026-01-01T00:00:00Z", defaultEmailAddress: { emailAddress: "a@example.com" } };
  eq("customer: mapped like the REST webhook", customerJson(alice), {
    id: 77, email: "a@example.com", first_name: "Alice", last_name: null, state: "enabled", created_at: "2026-01-01T00:00:00Z",
  });
  eq("customer: no email address", customerJson({ legacyResourceId: "5", state: "DISABLED" })?.email, null);
  eq("customer: bad id", customerJson({ legacyResourceId: "x" }), null);

  const cp = parseCustomersPage({ customers: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [alice, { legacyResourceId: "" }] } });
  eq("customers page: cursor + bad node dropped", [cp.hasNext, cp.cursor, cp.nodes.length], [true, "c1", 1]);

  const op = parseOrdersPage({
    orders: {
      pageInfo: { hasNextPage: false, endCursor: "o9" },
      nodes: [
        { legacyResourceId: "1001", name: "#1001", processedAt: "2026-07-01T00:00:00Z",
          subtotalPriceSet: { shopMoney: { amount: "60.00" } }, currentSubtotalPriceSet: { shopMoney: { amount: "45.00" } }, customer: alice },
        { legacyResourceId: "1002", name: "#1002", processedAt: "2026-07-02T00:00:00Z",
          subtotalPriceSet: { shopMoney: { amount: "30.00" } }, currentSubtotalPriceSet: null, customer: alice },
        { legacyResourceId: "1003", subtotalPriceSet: { shopMoney: { amount: "10.00" } }, customer: null },
        { legacyResourceId: "1004", subtotalPriceSet: { shopMoney: { amount: "10.00" } },
          currentSubtotalPriceSet: { shopMoney: { amount: "12.00" } }, customer: alice },
      ],
    },
  });
  eq("orders page: guest order dropped", op.nodes.map((o) => o.id), [1001, 1002, 1004]);
  eq("orders page: net after refunds", [op.nodes[0].eligible_cents, op.nodes[0].net_eligible_cents], [6000, 4500]);
  eq("orders page: no current subtotal = nothing refunded", op.nodes[1].net_eligible_cents, 3000);
  eq("orders page: net never above eligible", op.nodes[2].net_eligible_cents, 1000);
  eq("orders page: last page", [op.hasNext, op.cursor], [false, "o9"]);
  eq("orders page: empty data", parseOrdersPage(null).nodes, []);

  const ext = (cost: number, have: number, rate: number) => ({ cost: { requestedQueryCost: cost, throttleStatus: { currentlyAvailable: have, restoreRate: rate } } });
  eq("throttle: plenty left", throttleWaitMs(ext(100, 900, 50)), 0);
  eq("throttle: wait for 2x cost to refill", throttleWaitMs(ext(100, 50, 50)), 3000);
  eq("throttle: no extensions", throttleWaitMs(undefined), 0);
  eq("throttled: only THROTTLED errors", isThrottled([{ message: "Throttled", extensions: { code: "THROTTLED" } }]), true);
  eq("throttled: other error", isThrottled([{ message: "Field doesn't exist" }]), false);
  eq("throttled: none", isThrottled(undefined), false);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
