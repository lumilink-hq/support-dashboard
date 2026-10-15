// =============================================================================
// test-loyalty-shopify.ts — unit tests for loyalty-shopify/lib.ts (0203): tier
// tags and segment queries, the aliased tag mutation, metafield inputs, and the
// discount inputs for codes and perks.
//
//   npx tsx scripts/test-loyalty-shopify.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  codeDiscountInput,
  customerGid,
  isCodeTaken,
  memberMetafields,
  METAFIELD_DEFINITIONS,
  perkDiscountInput,
  programMetafield,
  tierSegmentQuery,
  tierTag,
  tierTagsMutation,
  userErrorText,
} from "../supabase/functions/loyalty-shopify/lib.ts";

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

function throws(label: string, fn: () => unknown, match: RegExp) {
  try {
    fn();
    ok(label, false, "no error");
  } catch (e) {
    ok(label, match.test(String(e)), String(e));
  }
}

function main() {
  eq("gid", customerGid(77), "gid://shopify/Customer/77");
  eq("tag", tierTag("Gold"), "LL Tier Gold");
  eq("segment: one tier", tierSegmentQuery(["Gold"]), "customer_tags CONTAINS 'LL Tier Gold'");
  eq("segment: several tiers", tierSegmentQuery(["Silver", "Gold"]), "customer_tags CONTAINS 'LL Tier Silver' OR customer_tags CONTAINS 'LL Tier Gold'");
  eq("segment: quote escaped", tierSegmentQuery(["O'Brien"]), "customer_tags CONTAINS 'LL Tier O\\'Brien'");

  const t = tierTagsMutation([{ customerId: 1, tierName: "Gold" }, { customerId: 2, tierName: "Bronze" }], ["Bronze", "Silver", "Gold"]);
  ok("tags: aliased per member", t.query.includes("a0: tagsAdd(id: $id0") && t.query.includes("r1: tagsRemove(id: $id1"), t.query);
  eq("tags: add the current tier", t.variables.add0, ["LL Tier Gold"]);
  eq("tags: remove every other tier", t.variables.rm0, ["LL Tier Bronze", "LL Tier Silver"]);
  eq("tags: second member", [t.variables.id1, t.variables.add1], ["gid://shopify/Customer/2", ["LL Tier Bronze"]]);

  eq("metafields: tier, points, tier spend, group per member",
    memberMetafields([{ customerId: 7, tierName: "Silver", points: 1234.9, tierSpendCents: 61250, group: "holdout" }]), [
      { ownerId: "gid://shopify/Customer/7", namespace: "ll_loyalty", key: "tier", type: "single_line_text_field", value: "Silver" },
      { ownerId: "gid://shopify/Customer/7", namespace: "ll_loyalty", key: "points", type: "number_integer", value: "1234" },
      { ownerId: "gid://shopify/Customer/7", namespace: "ll_loyalty", key: "tier_spend_cents", type: "number_integer", value: "61250" },
      { ownerId: "gid://shopify/Customer/7", namespace: "ll_loyalty", key: "group", type: "single_line_text_field", value: "holdout" },
    ]);
  ok("metafields: 6 members fit one metafieldsSet (max 25)",
    memberMetafields(Array.from({ length: 6 }, (_, i) => ({ customerId: i + 1, tierName: "Gold", points: 1, tierSpendCents: 1, group: "treatment" }))).length <= 25);
  ok("definitions: merchant namespace, storefront readable",
    METAFIELD_DEFINITIONS.every((d) => d.namespace === "ll_loyalty" && d.access.storefront === "PUBLIC_READ"));
  eq("definitions: four on the customer, the program on the shop",
    METAFIELD_DEFINITIONS.map((d) => `${d.ownerType}:${d.key}:${d.type}`),
    ["CUSTOMER:tier:single_line_text_field", "CUSTOMER:points:number_integer", "CUSTOMER:tier_spend_cents:number_integer",
     "CUSTOMER:group:single_line_text_field", "SHOP:program:json"]);
  eq("program metafield: json on the shop, value serialized",
    programMetafield("gid://shopify/Shop/1", { points_per_dollar: 3 }),
    { ownerId: "gid://shopify/Shop/1", namespace: "ll_loyalty", key: "program", type: "json", value: "{\"points_per_dollar\":3}" });

  const at = "2026-10-13T00:00:00Z";
  const member = codeDiscountInput({ code: "WAVE-ABCD2345", title: "Wave Rewards: $5 off", value_cents: 500, min_order_cents: 0, customer_id: 77, ends_at: null, combines: {} }, at);
  eq("code: this customer only", member.context, { customers: { add: ["gid://shopify/Customer/77"] } });
  eq("code: $5 once off the order", member.customerGets, { value: { discountAmount: { amount: "5.00", appliesOnEachItem: false } }, items: { all: true } });
  eq("code: single use", [member.usageLimit, member.appliesOncePerCustomer], [1, true]);
  eq("code: no minimum", member.minimumRequirement, null);
  eq("code: combines with shipping only by default", member.combinesWith, { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true });
  const friend = codeDiscountInput({ code: "WAVE-REF-X", title: "t", value_cents: 1000, min_order_cents: 2500, customer_id: null, ends_at: "2027-01-01T00:00:00Z", combines: { orderDiscounts: true } }, at);
  eq("code: friend coupon open to anyone", friend.context, { all: "ALL" });
  eq("code: minimum subtotal", friend.minimumRequirement, { subtotal: { greaterThanOrEqualToSubtotal: "25.00" } });
  eq("code: combines override", friend.combinesWith.orderDiscounts, true);
  eq("code: expiry passed through", friend.endsAt, "2027-01-01T00:00:00Z");

  const base = { key: "p", title: "Gold perk", min_subtotal_cents: 7500, percent: null, collection_gids: [] as string[], product_gids: [] as string[], combines: {} };
  const fs = perkDiscountInput({ ...base, kind: "free_shipping" }, ["gid://shopify/Segment/2"], at) as Record<string, unknown>;
  eq("perk: segment context", fs.context, { customerSegments: { add: ["gid://shopify/Segment/2"] } });
  eq("perk: free shipping everywhere over $75", [fs.destination, fs.minimumRequirement], [{ all: true }, { subtotal: { greaterThanOrEqualToSubtotal: "75.00" } }]);
  const pct = perkDiscountInput({ ...base, kind: "percent_off_products", percent: 15, min_subtotal_cents: 0, collection_gids: ["gid://shopify/Collection/9"] }, ["s"], at) as Record<string, unknown>;
  eq("perk: 15% off a collection", pct.customerGets, { value: { percentage: 0.15 }, items: { collections: { add: ["gid://shopify/Collection/9"] } } });
  const prod = perkDiscountInput({ ...base, kind: "percent_off_products", percent: 10, product_gids: ["gid://shopify/Product/1"] }, ["s"], at) as { customerGets: { items: unknown } };
  eq("perk: or specific products", prod.customerGets.items, { products: { productsToAdd: ["gid://shopify/Product/1"] } });
  throws("perk: percent needs products", () => perkDiscountInput({ ...base, kind: "percent_off_products", percent: 10 }, ["s"], at), /needs products/);
  throws("perk: percent range", () => perkDiscountInput({ ...base, kind: "percent_off_products", percent: 150, product_gids: ["x"] }, ["s"], at), /1-100/);

  eq("userErrors: none", userErrorText([]), "");
  eq("userErrors: flattened", userErrorText([{ field: ["basicCodeDiscount", "code"], message: "Code must be unique", code: "TAKEN" }]),
    "basicCodeDiscount.code Code must be unique (TAKEN)");
  eq("code taken: unique message", isCodeTaken([{ message: "Code must be unique. Please try a different code." }]), true);
  eq("code taken: other error", isCodeTaken([{ message: "Customer does not exist" }]), false);
  eq("code taken: no errors", isCodeTaken([]), false);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
