// Unit tests for lib/billing-activation.ts: which Stripe subscription states
// grant access. The one that matters most: an ACH subscription that is
// "active" while its first invoice is still processing must NOT activate.
// Run: npx tsx scripts/test-billing-activation.ts
import assert from "node:assert/strict";

async function main() {
  const { subscriptionAction, subscriptionIdFromInvoice } = await import("../lib/billing-activation");

  // Paid: grant.
  assert.equal(subscriptionAction("active", { status: "paid" }), "activate");
  assert.equal(subscriptionAction("trialing", { status: "paid" }), "activate", "a trial's $0 invoice is paid");

  // ACH still clearing (or any unpaid latest invoice): wait.
  assert.equal(subscriptionAction("active", { status: "open" }), "await_payment", "ACH processing must not activate");
  assert.equal(subscriptionAction("active", { status: "draft" }), "await_payment");
  assert.equal(subscriptionAction("active", { status: "uncollectible" }), "await_payment");
  assert.equal(subscriptionAction("active", { status: null }), "await_payment");
  assert.equal(subscriptionAction("active", null), "await_payment", "no invoice known: don't guess");
  assert.equal(subscriptionAction("trialing", { status: "open" }), "await_payment");
  assert.equal(subscriptionAction("incomplete", { status: "open" }), "await_payment");
  assert.equal(subscriptionAction("incomplete", null), "await_payment");
  assert.equal(subscriptionAction("incomplete_expired", { status: "void" }), "await_payment");

  // Failed payments.
  assert.equal(subscriptionAction("past_due", { status: "open" }), "payment_failed");
  assert.equal(subscriptionAction("past_due", null), "payment_failed");
  assert.equal(subscriptionAction("unpaid", null), "payment_failed");

  // Left to their own handlers.
  assert.equal(subscriptionAction("canceled", { status: "paid" }), "ignore");
  assert.equal(subscriptionAction("paused", { status: "paid" }), "ignore");

  // Invoice -> subscription id, across API versions.
  assert.equal(
    subscriptionIdFromInvoice({ parent: { subscription_details: { subscription: "sub_new" } } }),
    "sub_new",
  );
  assert.equal(
    subscriptionIdFromInvoice({ parent: { subscription_details: { subscription: { id: "sub_exp" } } } }),
    "sub_exp",
  );
  assert.equal(subscriptionIdFromInvoice({ subscription: "sub_old" }), "sub_old");
  assert.equal(subscriptionIdFromInvoice({ subscription: { id: "sub_old_exp" } }), "sub_old_exp");
  assert.equal(subscriptionIdFromInvoice({ parent: null, subscription: null }), null, "one-off invoice");
  assert.equal(subscriptionIdFromInvoice({}), null);

  console.log("billing-activation: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
