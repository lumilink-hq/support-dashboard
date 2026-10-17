// =============================================================================
// test-loyalty-embedded-token.ts — unit tests for lib/loyalty-embedded/
// session-token.ts (0225): Shopify admin session token verification.
//
//   npx tsx scripts/test-loyalty-embedded-token.ts
//
// No network, no database.
// =============================================================================

import { createHmac } from "node:crypto";
import { bearer, peekSession, verifyAdminSession } from "../lib/loyalty-embedded/session-token";

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

const SECRET = "app-secret-123";
const CLIENT = "client-abc";
const NOW = 1_800_000_000;

function sign(claims: Record<string, unknown>, opts: { secret?: string; alg?: string } = {}): string {
  const h = Buffer.from(JSON.stringify({ alg: opts.alg ?? "HS256", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = createHmac("sha256", opts.secret ?? SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

const good = {
  iss: "https://cool-shop.myshopify.com/admin",
  dest: "https://cool-shop.myshopify.com",
  aud: CLIENT,
  sub: "4242",
  exp: NOW + 60,
  nbf: NOW - 5,
  iat: NOW - 5,
};

eq("valid", verifyAdminSession(sign(good), CLIENT, SECRET, NOW), { ok: true, shop: "cool-shop.myshopify.com", userId: "4242", clientId: CLIENT });
eq("wrong secret", verifyAdminSession(sign(good, { secret: "other" }), CLIENT, SECRET, NOW), { ok: false, reason: "bad_signature" });
eq("alg none refused", verifyAdminSession(sign(good, { alg: "none" }), CLIENT, SECRET, NOW), { ok: false, reason: "bad_alg" });
eq("expired", verifyAdminSession(sign({ ...good, exp: NOW - 30 }), CLIENT, SECRET, NOW), { ok: false, reason: "expired" });
eq("within leeway", verifyAdminSession(sign({ ...good, exp: NOW - 5 }), CLIENT, SECRET, NOW).ok, true);
eq("not yet", verifyAdminSession(sign({ ...good, nbf: NOW + 60 }), CLIENT, SECRET, NOW), { ok: false, reason: "not_yet" });
eq("other app", verifyAdminSession(sign({ ...good, aud: "someone-else" }), CLIENT, SECRET, NOW), { ok: false, reason: "bad_claims" });
eq("iss shop differs from dest", verifyAdminSession(sign({ ...good, iss: "https://evil.myshopify.com/admin" }), CLIENT, SECRET, NOW), { ok: false, reason: "bad_claims" });
eq("dest not a shop", verifyAdminSession(sign({ ...good, dest: "https://example.com", iss: "https://example.com/admin" }), CLIENT, SECRET, NOW), { ok: false, reason: "bad_claims" });
eq("no user", verifyAdminSession(sign({ ...good, sub: undefined }), CLIENT, SECRET, NOW), { ok: false, reason: "bad_claims" });
eq("customer gid is not a staff user", verifyAdminSession(sign({ ...good, sub: "gid://shopify/Customer/1" }), CLIENT, SECRET, NOW), { ok: false, reason: "bad_claims" });
const t = sign(good);
eq("tampered payload", verifyAdminSession(t.split(".")[0] + "." + Buffer.from(JSON.stringify({ ...good, sub: "1" })).toString("base64url") + "." + t.split(".")[2], CLIENT, SECRET, NOW), { ok: false, reason: "bad_signature" });
eq("garbage", verifyAdminSession("a.b", CLIENT, SECRET, NOW), { ok: false, reason: "malformed" });
eq("no secret", verifyAdminSession(t, CLIENT, "", NOW), { ok: false, reason: "malformed" });

eq("peek", peekSession(t), { clientId: CLIENT, shop: "cool-shop.myshopify.com" });
eq("peek garbage", peekSession("x"), null);
eq("bearer", bearer(`Bearer ${t}`), t);
eq("bearer missing", bearer(null), null);
eq("bearer wrong scheme", bearer(`Basic ${t}`), null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
