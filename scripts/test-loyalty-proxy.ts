// =============================================================================
// test-loyalty-proxy.ts — unit tests for loyalty-proxy/lib.ts (0204): the app
// proxy signature (checked against Shopify's documented example), timestamp,
// logged-in customer, routing and input validation.
//
//   npx tsx scripts/test-loyalty-proxy.ts
//
// No network, no Deno, no database.
// =============================================================================

import { createHmac } from "node:crypto";
import {
  parseBirthday,
  parseEmail,
  parseKey,
  parseReferralCode,
  parseRequestKey,
  proxyMessage,
  route,
  verifyProxy,
} from "../supabase/functions/loyalty-proxy/lib.ts";

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

const sign = (params: URLSearchParams, secret: string) => createHmac("sha256", secret).update(proxyMessage(params)).digest("hex");

async function main() {
  // Shopify's documented example (shopify.dev "Authenticate app proxies").
  const doc = new URLSearchParams("extra=1&extra=2&shop={shop}.myshopify.com&logged_in_customer_id=1&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555&signature=x");
  eq("message: Shopify's example, decoded, sorted, repeated keys joined, no separator", proxyMessage(doc),
    "extra=1,2logged_in_customer_id=1path_prefix=/apps/awesome_reviewsshop={shop}.myshopify.comtimestamp=1317327555");

  const now = 1_790_000_000;
  const q = new URLSearchParams({ shop: "tsunami-test.myshopify.com", logged_in_customer_id: "77", path_prefix: "/apps/loyalty", timestamp: String(now) });
  q.set("signature", sign(q, "s3cret"));
  eq("verify: good signature, logged in", await verifyProxy(q, ["s3cret"], now), { ok: true, shop: "tsunami-test.myshopify.com", customerId: 77 });
  eq("verify: any of the shop's app secrets", (await verifyProxy(q, ["other", "s3cret"], now)).ok, true);
  eq("verify: wrong secret", await verifyProxy(q, ["nope"], now), { ok: false, reason: "bad_signature" });
  eq("verify: no secrets", (await verifyProxy(q, [], now)).ok, false);
  eq("verify: stale timestamp", await verifyProxy(q, ["s3cret"], now + 301), { ok: false, reason: "stale" });
  eq("verify: small clock skew is fine", (await verifyProxy(q, ["s3cret"], now - 60)).ok, true);

  const forged = new URLSearchParams(q);
  forged.set("logged_in_customer_id", "78");
  eq("verify: changing the customer breaks the signature", (await verifyProxy(forged, ["s3cret"], now)).ok, false);

  const anon = new URLSearchParams({ shop: "tsunami-test.myshopify.com", logged_in_customer_id: "", path_prefix: "/apps/loyalty", timestamp: String(now) });
  anon.set("signature", sign(anon, "s3cret"));
  eq("verify: logged out = null customer", await verifyProxy(anon, ["s3cret"], now), { ok: true, shop: "tsunami-test.myshopify.com", customerId: null });

  const badShop = new URLSearchParams({ shop: "evil.example.com", timestamp: String(now) });
  badShop.set("signature", sign(badShop, "s3cret"));
  eq("verify: shop must be *.myshopify.com", await verifyProxy(badShop, ["s3cret"], now), { ok: false, reason: "bad_shop" });
  const noSig = new URLSearchParams(q);
  noSig.delete("signature");
  eq("verify: missing signature", (await verifyProxy(noSig, ["s3cret"], now)).ok, false);

  eq("route: state", route("/loyalty-proxy/state", "GET"), "state");
  eq("route: bare path is state", route("/loyalty-proxy", "GET"), "state");
  eq("route: redeem", route("/loyalty-proxy/redeem/", "POST"), "redeem");
  eq("route: wrong method", route("/loyalty-proxy/redeem", "GET"), null);
  eq("route: unknown", route("/loyalty-proxy/admin", "POST"), null);

  eq("birthday: valid", parseBirthday("1990-10-20"), "1990-10-20");
  eq("birthday: Feb 29 in a leap year", parseBirthday("2000-02-29"), "2000-02-29");
  eq("birthday: Feb 29 not a leap year", parseBirthday("2001-02-29"), null);
  eq("birthday: US format refused", parseBirthday("10/20/1990"), null);
  eq("email: ok", parseEmail(" a@b.co "), "a@b.co");
  eq("email: junk", parseEmail("nope"), null);
  eq("request key: uuid", parseRequestKey("c40f430c-aea9-48fe-9b03-3f16729c1d79"), "c40f430c-aea9-48fe-9b03-3f16729c1d79");
  eq("request key: too short", parseRequestKey("abc"), null);
  eq("request key: unsafe chars", parseRequestKey("abc'; drop--"), null);
  eq("key: rule key", parseKey("instagram_follow"), "instagram_follow");
  eq("key: refused", parseKey("Instagram Follow"), null);
  eq("referral code: uppercased", parseReferralCode(" ab12cd34 "), "AB12CD34");
  eq("referral code: junk", parseReferralCode("../x"), null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
