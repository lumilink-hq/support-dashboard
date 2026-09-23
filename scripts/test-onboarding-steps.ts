// =============================================================================
// test-onboarding-steps.ts — unit tests for the product/industry split (0059)
// in lib/onboarding.ts and lib/catalog.ts.
//
//   npx tsx scripts/test-onboarding-steps.ts
//
// WHY THIS EXISTS: which onboarding steps a client sees, and where "Add
// <product>" sends them, used to hang off one value (business_type). Now it
// is two (industry and products), and the failure modes are quiet: a phone
// client that adds SEO never sees the location step, or a shop is asked for
// call-out fees.
// =============================================================================

import { readProfile, stepsFor, blockingRemaining, type StepKey } from "../lib/onboarding.ts";
import { addProductHref } from "../lib/catalog.ts";

let failures = 0;

function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}`, detail ?? "");
  }
}

const keys = (p: Parameters<typeof stepsFor>[0]): StepKey[] => stepsFor(p).map((s) => s.key);
const same = (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b);

console.log("readProfile");
ok("legacy row (no products) is a phone client", same(readProfile({ business_type: "service" }).products, ["voice"]));
ok("empty products is a phone client", same(readProfile({ products: [] }).products, ["voice"]));
ok("unknown products are dropped", same(readProfile({ products: ["seo", "chat"] }).products, ["seo"]));
ok("old business_type 'seo' is not an industry", readProfile({ business_type: "seo" }).industry === null);
ok("null row is a phone client with no industry", readProfile(null).industry === null && same(readProfile(null).products, ["voice"]));

console.log("stepsFor");
const service = keys({ industry: "service", products: ["voice"] });
ok("service phone client gets the price list", service.includes("services"));
ok("service phone client never sees the store step", !service.includes("store"));
ok("service phone client sees no SEO steps", !service.some((k) => k.startsWith("seo_")));

const shop = keys({ industry: "ecommerce", products: ["voice"] });
ok("shop gets the store step", shop.includes("store"));
ok("shop is never asked for call-out fees", !shop.includes("services"));

const seoOnly = keys({ industry: "service", products: ["seo"] });
ok("SEO-only client sees only SEO steps", same(seoOnly, ["seo_locations", "seo_keywords", "seo_competitors"]), seoOnly);

const both = keys({ industry: "service", products: ["voice", "seo"] });
ok("phone client that adds SEO gets the SEO steps", both.includes("seo_locations"));
ok("phone steps come before SEO steps", both.indexOf("basics") < both.indexOf("seo_locations"));

const unknown = keys({ industry: null, products: ["voice"] });
ok("unknown industry gets every phone step", unknown.includes("services") && unknown.includes("store"));

console.log("blockingRemaining");
const doneVoice = {
  steps: { basics: { done: true }, services: { done: true }, number: { done: true } },
};
const blockingAfterAdd = blockingRemaining(doneVoice, { industry: "service", products: ["voice", "seo"] });
ok(
  "a finished phone client that adds SEO is blocked only on locations",
  same(blockingAfterAdd.map((s) => s.key), ["seo_locations"]),
  blockingAfterAdd.map((s) => s.key),
);

console.log("addProductHref");
ok("SEO not set up -> add flow", addProductHref("seo", ["voice"]) === "/onboarding/add?product=seo");
ok("SEO set up, unpaid -> SEO checkout", addProductHref("seo", ["voice", "seo"]) === "/billing#seo");
ok("phone not set up -> add flow", addProductHref("voice", ["seo"]) === "/onboarding/add?product=voice");
ok("phone set up, unpaid -> plans", addProductHref("voice", ["voice"]) === "/plans");

if (failures) {
  console.log(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll onboarding-steps tests passed.");
