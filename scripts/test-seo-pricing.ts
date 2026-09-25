// Unit tests for lib/seo-pricing.ts: plan totals, the Stripe line items each
// plan checks out with, and how a subscription's items map back to a plan and
// a location count. Run: npx tsx scripts/test-seo-pricing.ts
import assert from "node:assert/strict";

process.env.STRIPE_PRICE_SEO_WEBSITE = "price_web";
process.env.STRIPE_PRICE_SEO_LOCAL = "price_local";
process.env.STRIPE_PRICE_SEO_BUNDLE = "price_bundle";
process.env.STRIPE_PRICE_SEO_EXTRA_LOCATION = "price_extra";
process.env.STRIPE_PRICE_SEO_PACKS_STORE = "price_packs";

async function main() {
  const p = await import("../lib/seo-pricing");

  // Totals, per the catalog.
  assert.equal(p.seoMonthlyUsd("website", 5), 1995);
  assert.equal(p.seoMonthlyUsd("local", 1), 495);
  assert.equal(p.seoMonthlyUsd("local", 3), 1485);
  assert.equal(p.seoMonthlyUsd("bundle", 1), 2400);
  assert.equal(p.seoMonthlyUsd("bundle", 0), 2400);
  assert.equal(p.seoMonthlyUsd("bundle", 3), 3200);
  // Bundle savings claim: website + one local location, minus bundle = $90.
  assert.equal(p.seoMonthlyUsd("website", 0) + p.seoMonthlyUsd("local", 1) - p.seoMonthlyUsd("bundle", 1), 90);

  // Line items.
  assert.deepEqual(p.seoCheckoutLineItems("website", 4), [{ price: "price_web", quantity: 1 }]);
  assert.deepEqual(p.seoCheckoutLineItems("local", 4), [{ price: "price_local", quantity: 4 }]);
  assert.deepEqual(p.seoCheckoutLineItems("bundle", 1), [{ price: "price_bundle", quantity: 1 }]);
  assert.deepEqual(p.seoCheckoutLineItems("bundle", 4), [
    { price: "price_bundle", quantity: 1 },
    { price: "price_extra", quantity: 3 },
  ]);

  // Subscription items -> plan and locations.
  const items = (x: [string, number][]) => x.map(([priceId, quantity]) => ({ priceId, quantity }));
  assert.equal(p.seoPlanFromItems(items([["price_web", 1]])), "website");
  assert.equal(p.seoLocationsFromItems(items([["price_web", 1]])), 0);
  assert.equal(p.seoLocationsFromItems(items([["price_local", 4]])), 4);
  assert.equal(p.seoPlanFromItems(items([["price_bundle", 1], ["price_extra", 3]])), "bundle");
  assert.equal(p.seoLocationsFromItems(items([["price_bundle", 1], ["price_extra", 3]])), 4);
  assert.equal(p.seoPlanFromItems(items([["price_packs", 1]])), null);
  assert.equal(p.seoLocationsFromItems(items([["price_packs", 1]])), 1);
  assert.equal(p.seoLocationsFromItems(items([["price_voice", 1]])), null);

  assert.deepEqual(p.availableSeoPlans().map((x) => x.key), ["website", "local", "bundle"]);
  console.log("seo-pricing: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
