// =============================================================================
// test-loyalty-ext.ts — unit tests for loyalty-ext/lib.ts (0212): Shopify
// session token verification (signature, alg, expiry, aud, dest, sub), GID
// parsing and the bearer header.
//
//   npx tsx scripts/test-loyalty-ext.ts
//
// No network, no Deno, no database.
// =============================================================================

import { createHmac } from "node:crypto";
import { bearer, gidId, peekClaims, verifySessionToken } from "../supabase/functions/loyalty-ext/lib.ts";

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

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function jwt(claims: Record<string, unknown>, secret: string, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }) {
  const head = `${b64(header)}.${b64(claims)}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}

async function main() {
  const now = 1_790_000_000;
  const app = "6bfc5441e16cbd1562db482f32edb56c";
  const base = { iss: "https://tsunami-test.myshopify.com", dest: "tsunami-test.myshopify.com", aud: app, exp: now + 300, nbf: now - 1, iat: now, jti: "x1" };

  eq("member: shop + customer from the claims",
    await verifySessionToken(jwt({ ...base, sub: "gid://shopify/Customer/77" }, "s3cret"), app, "s3cret", now),
    { ok: true, shop: "tsunami-test.myshopify.com", aud: app, customerId: 77 });
  eq("guest: no sub -> no customer",
    await verifySessionToken(jwt(base, "s3cret"), app, "s3cret", now),
    { ok: true, shop: "tsunami-test.myshopify.com", aud: app, customerId: null });
  eq("dest with https:// (other surfaces) is accepted",
    (await verifySessionToken(jwt({ ...base, dest: "https://tsunami-test.myshopify.com" }, "s3cret"), app, "s3cret", now)).ok, true);

  eq("wrong secret refused", await verifySessionToken(jwt(base, "other"), app, "s3cret", now), { ok: false, reason: "bad_signature" });
  const t = jwt({ ...base, sub: "gid://shopify/Customer/77" }, "s3cret");
  const [h, , s] = t.split(".");
  eq("claims swapped after signing (another customer) refused",
    await verifySessionToken(`${h}.${b64({ ...base, sub: "gid://shopify/Customer/78" })}.${s}`, app, "s3cret", now),
    { ok: false, reason: "bad_signature" });
  eq("alg none refused", await verifySessionToken(jwt(base, "s3cret", { alg: "none" }), app, "s3cret", now), { ok: false, reason: "bad_alg" });
  eq("expired refused", await verifySessionToken(jwt({ ...base, exp: now - 60 }, "s3cret"), app, "s3cret", now), { ok: false, reason: "expired" });
  eq("expiry leeway: 5s late still ok", (await verifySessionToken(jwt({ ...base, exp: now - 5 }, "s3cret"), app, "s3cret", now)).ok, true);
  eq("not yet valid refused", await verifySessionToken(jwt({ ...base, nbf: now + 60 }, "s3cret"), app, "s3cret", now), { ok: false, reason: "not_yet" });
  eq("another app's token refused (aud)", await verifySessionToken(jwt({ ...base, aud: "someoneelse" }, "s3cret"), app, "s3cret", now),
    { ok: false, reason: "bad_claims" });
  eq("dest not a myshopify domain refused", await verifySessionToken(jwt({ ...base, dest: "evil.com" }, "s3cret"), app, "s3cret", now),
    { ok: false, reason: "bad_claims" });
  eq("sub that isn't a customer GID refused",
    await verifySessionToken(jwt({ ...base, sub: "gid://shopify/Order/5" }, "s3cret"), app, "s3cret", now), { ok: false, reason: "bad_claims" });
  eq("no secret configured refused", await verifySessionToken(jwt(base, "s3cret"), app, "", now), { ok: false, reason: "malformed" });
  eq("garbage refused", await verifySessionToken("a.b", app, "s3cret", now), { ok: false, reason: "malformed" });

  eq("peek: aud + shop pick the app secret", peekClaims(jwt(base, "s3cret")), { aud: app, shop: "tsunami-test.myshopify.com" });
  eq("peek: garbage -> null", peekClaims("x.y.z"), null);

  eq("gid: order", gidId("gid://shopify/Order/6123456789012", "Order"), 6123456789012);
  eq("gid: bare id", gidId("42", "Order"), 42);
  eq("gid: wrong type", gidId("gid://shopify/Customer/42", "Order"), null);
  eq("gid: missing", gidId(null, "Order"), null);
  eq("gid: zero", gidId("0", "Order"), null);

  eq("bearer: token", bearer(`Bearer ${"a".repeat(30)}`), "a".repeat(30));
  eq("bearer: missing", bearer(null), null);
  eq("bearer: other scheme", bearer(`Basic ${"a".repeat(30)}`), null);

  console.log(`test-loyalty-ext: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
