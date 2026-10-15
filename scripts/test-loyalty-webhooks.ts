// =============================================================================
// test-loyalty-webhooks.ts — unit tests for loyalty-webhooks/lib.ts (0201):
// Shopify webhook HMAC, money parsing, and the order / refund / customer
// payload mapping.
//
//   npx tsx scripts/test-loyalty-webhooks.ts
//
// No network, no Deno, no database.
// =============================================================================

import { createHmac } from "node:crypto";
import {
  asTopic,
  hmacBase64,
  moneyToCents,
  parseCustomer,
  parseOrder,
  parseRedactCustomerId,
  parseRefund,
  verifyWebhook,
} from "../supabase/functions/loyalty-webhooks/lib.ts";

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

async function main() {
  // HMAC: base64 over the raw body, checked against Node's own implementation.
  const body = new TextEncoder().encode('{"id":1,"note":"héllo"}');
  const want = createHmac("sha256", "s3cret").update(body).digest("base64");
  eq("hmac: matches node crypto", await hmacBase64("s3cret", body), want);
  eq("verify: right secret", await verifyWebhook(body, want, ["s3cret"]), true);
  eq("verify: any of several app secrets", await verifyWebhook(body, want, ["other", "s3cret"]), true);
  eq("verify: wrong secret", await verifyWebhook(body, want, ["nope"]), false);
  eq("verify: no secrets", await verifyWebhook(body, want, []), false);
  eq("verify: missing header", await verifyWebhook(body, null, ["s3cret"]), false);
  eq("verify: hex digest is not accepted", await verifyWebhook(body, "a".repeat(64), ["s3cret"]), false);
  const tampered = new TextEncoder().encode('{"id":2,"note":"héllo"}');
  eq("verify: tampered body", await verifyWebhook(tampered, want, ["s3cret"]), false);

  eq("topic: known", asTopic("Orders/Paid"), "orders/paid");
  eq("topic: unknown", asTopic("products/update"), null);

  // Money: exact decimal to cents.
  eq("money: 12.30", moneyToCents("12.30"), 1230);
  eq("money: 12.3", moneyToCents("12.3"), 1230);
  eq("money: 12", moneyToCents("12"), 1200);
  eq("money: 0.1 + no float drift", moneyToCents("1234567.89"), 123456789);
  eq("money: 3 decimals round half up", moneyToCents("12.345"), 1235);
  eq("money: 3 decimals round down", moneyToCents("12.344"), 1234);
  eq("money: number input", moneyToCents(5), 500);
  eq("money: junk", moneyToCents("12,30"), null);
  eq("money: empty", moneyToCents(""), null);

  // orders/paid: shop money wins over presentment.
  eq(
    "order: parsed",
    parseOrder({
      id: 5512345,
      name: "#1042",
      processed_at: "2026-10-13T10:00:00-07:00",
      subtotal_price: "99.00",
      subtotal_price_set: { shop_money: { amount: "100.99" }, presentment_money: { amount: "140.00" } },
      total_price: "120.00",
      email: "alice@example.com",
      discount_codes: [{ code: " WAVE-REF-1 ", amount: "10.00", type: "fixed_amount" }, { code: "" }, {}],
      customer: { id: 77, email: " a@example.com ", first_name: "Alice", last_name: "", state: "enabled", created_at: "2026-01-01T00:00:00Z", phone: "+15555550100" },
    }),
    {
      id: 5512345,
      name: "#1042",
      processed_at: "2026-10-13T10:00:00-07:00",
      eligible_cents: 10099,
      email: "alice@example.com",
      discount_codes: ["WAVE-REF-1"],
      customer: { id: 77, email: "a@example.com", first_name: "Alice", last_name: null, state: "enabled", created_at: "2026-01-01T00:00:00Z", email_marketing_consent: null },
      line_items: [],
    },
  );
  eq(
    "order: line items after line + order discounts, shop money (0214)",
    parseOrder({
      id: 1,
      line_items: [
        { product_id: 111, quantity: 2, price: "9.99", price_set: { shop_money: { amount: "10.00" }, presentment_money: { amount: "14.00" } },
          discount_allocations: [{ amount: "1.00", amount_set: { shop_money: { amount: "1.50" } } }, { amount_set: { shop_money: { amount: "0.50" } } }] },
        { product_id: 222, quantity: 1, price: "5.00", discount_allocations: [] },
        { product_id: 333, quantity: 1, price: "3.00", discount_allocations: [{ amount: "9.00" }] },   // over-discounted -> 0
        { product_id: null, quantity: 1, price: "4.00" },   // custom item: no product, skipped
        { product_id: 444, quantity: 0, price: "4.00" },    // removed line, skipped
      ],
    })?.line_items,
    [{ product_id: 111, cents: 1800 }, { product_id: 222, cents: 500 }, { product_id: 333, cents: 0 }],
  );
  eq("order: no line items -> empty", parseOrder({ id: 1 })?.line_items, []);
  eq("order: no phone or address passed through", Object.keys(parseOrder({ id: 1, customer: { id: 2, phone: "x" } })!.customer!).includes("phone"), false);
  eq("order: plain subtotal fallback", parseOrder({ id: 1, subtotal_price: "10.00" })?.eligible_cents, 1000);
  eq("order: guest has no customer", parseOrder({ id: 1, subtotal_price: "10.00", customer: null })?.customer, null);
  eq("order: no id", parseOrder({ subtotal_price: "10.00" }), null);
  eq("order: negative subtotal floors at 0", parseOrder({ id: 1, subtotal_price: "-5.00" })?.eligible_cents, 0);

  // refunds/create: line subtotals only (no shipping, no tax).
  eq(
    "refund: line subtotals summed",
    parseRefund({
      id: 900,
      order_id: 5512345,
      created_at: "2026-10-14T00:00:00Z",
      refund_line_items: [
        { subtotal: 20, subtotal_set: { shop_money: { amount: "20.00" } }, total_tax: 2 },
        { subtotal: "5.50" },
      ],
      order_adjustments: [{ kind: "shipping_refund", amount: "-8.00" }],
    }),
    { id: 900, order_id: 5512345, created_at: "2026-10-14T00:00:00Z", cents: 2550 },
  );
  eq("refund: shipping-only refund is 0", parseRefund({ id: 1, order_id: 2, refund_line_items: [] })?.cents, 0);
  eq("refund: no order id", parseRefund({ id: 1 }), null);

  eq("customer: needs an id", parseCustomer({ email: "a@example.com" }), null);
  eq(
    "customer: marketing consent kept (state + when)",
    parseCustomer({ id: 5, email_marketing_consent: { state: "subscribed", opt_in_level: "single_opt_in", consent_updated_at: "2026-10-07T00:00:00Z" } })?.email_marketing_consent,
    { state: "subscribed", consent_updated_at: "2026-10-07T00:00:00Z" },
  );
  eq("order: no discount codes", parseOrder({ id: 1 })?.discount_codes, []);
  eq("redact: customer id", parseRedactCustomerId({ shop_domain: "x.myshopify.com", customer: { id: 191167, email: "j@example.com" } }), 191167);
  eq("redact: missing", parseRedactCustomerId({}), null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
