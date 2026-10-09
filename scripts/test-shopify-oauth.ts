// =============================================================================
// test-shopify-oauth.ts — unit tests for shopify-oauth/lib.ts (Connect Shopify,
// 0077).
//
//   npx tsx scripts/test-shopify-oauth.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  authorizeUrl,
  hmacHex,
  hmacMessage,
  parseAppCredentials,
  parseTokenResponse,
  portalUrl,
  readCookie,
  validShop,
  verifyHmac,
} from "../supabase/functions/shopify-oauth/lib.ts";

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
  // Shop validation (anchored: no lookalike hosts).
  eq("shop: lowercased", validShop("Packs-Club.myshopify.com"), "packs-club.myshopify.com");
  eq("shop: lookalike suffix refused", validShop("packs.myshopify.com.attacker.example"), null);
  eq("shop: custom domain refused", validShop("packsclub.com"), null);
  eq("shop: scheme refused", validShop("https://packs.myshopify.com"), null);
  eq("shop: empty", validShop(null), null);

  // Shopify's documented HMAC example (secret "hush").
  const doc = new URLSearchParams("code=0907a61c0c8d55e99db179b68161bc00&hmac=700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf&shop=some-shop.myshopify.com&state=0.6784241404160823&timestamp=1337178173");
  eq("hmac: message excludes hmac, sorted", hmacMessage(doc), "code=0907a61c0c8d55e99db179b68161bc00&shop=some-shop.myshopify.com&state=0.6784241404160823&timestamp=1337178173");
  ok("hmac: Shopify's example verifies", await verifyHmac(doc, "hush"));
  ok("hmac: wrong secret fails", !(await verifyHmac(doc, "hush2")));
  const tampered = new URLSearchParams(doc);
  tampered.set("shop", "evil.myshopify.com");
  ok("hmac: tampered shop fails", !(await verifyHmac(tampered, "hush")));
  const missing = new URLSearchParams(doc);
  missing.delete("hmac");
  ok("hmac: missing fails", !(await verifyHmac(missing, "hush")));

  // Sorting is by key, so the order params arrive in doesn't matter.
  const shuffled = new URLSearchParams("timestamp=1&shop=a.myshopify.com&host=xyz");
  shuffled.set("hmac", await hmacHex("s3cret", "host=xyz&shop=a.myshopify.com&timestamp=1"));
  ok("hmac: install-link params in any order", await verifyHmac(shuffled, "s3cret"));

  // Credentials.
  eq("creds: parsed", parseAppCredentials('{"client_id":"abc","client_secret":"shh"}'), { clientId: "abc", clientSecret: "shh" });
  eq("creds: access token only is not app credentials", parseAppCredentials('{"access_token":"shpat_x"}'), null);
  eq("creds: garbage", parseAppCredentials("nope"), null);

  // Authorize URL: offline (no per-user grant option).
  const a = new URL(authorizeUrl({ shop: "packs.myshopify.com", clientId: "abc", scopes: "write_products,write_content", redirectUri: "https://x.supabase.co/functions/v1/shopify-oauth/callback", state: "n0nce" }));
  eq("authorize: host and path", `${a.host}${a.pathname}`, "packs.myshopify.com/admin/oauth/authorize");
  eq("authorize: params", [a.searchParams.get("client_id"), a.searchParams.get("scope"), a.searchParams.get("redirect_uri"), a.searchParams.get("state")],
    ["abc", "write_products,write_content", "https://x.supabase.co/functions/v1/shopify-oauth/callback", "n0nce"]);
  ok("authorize: offline token (no grant_options)", !a.search.includes("grant_options"));

  // Token response.
  eq("token: ok", parseTokenResponse(200, '{"access_token":"shpat_abc","scope":"write_products,write_content"}'),
    { ok: true, token: "shpat_abc", scopes: ["write_products", "write_content"] });
  eq("token: error", parseTokenResponse(400, '{"error":"invalid_request","error_description":"The authorization code was not found or was already used"}'),
    { ok: false, error: "token endpoint 400: The authorization code was not found or was already used" });
  eq("token: html", parseTokenResponse(400, "<html>"), { ok: false, error: "token endpoint 400: not JSON" });

  // Cookie and the landing URL.
  eq("cookie: found", readCookie("a=1; lumilink_shopify_state=xyz; b=2", "lumilink_shopify_state"), "xyz");
  eq("cookie: absent", readCookie("a=1", "lumilink_shopify_state"), null);
  eq("portal: notice", portalUrl("https://www.lumilinkhub.com", { notice: "Shopify connected" }),
    "https://www.lumilinkhub.com/seo?tab=settings&notice=Shopify+connected#shopify");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
