// test-seo-shopify.ts — lib/seo-shopify.ts (the Connect Shopify card).
//   npx tsx scripts/test-seo-shopify.ts
import { shopifyCard, shopifyConnectUrl } from "../lib/seo-shopify";

let failed = 0;
let passed = 0;
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label} — got ${JSON.stringify(got)}`);
  }
}

const info = { shop_domain: "packs.myshopify.com", connected_at: null, last_error: null };
const conn = (status: string, extra = {}) => ({ platform: "shopify", status, shop_domain: "packs.myshopify.com", last_error: null, ...extra });

eq("url", shopifyConnectUrl("https://x.supabase.co/", "packs.myshopify.com"), "https://x.supabase.co/functions/v1/shopify-oauth?shop=packs.myshopify.com");
eq("github site: hidden", shopifyCard({ info: null, conn: { ...conn("healthy"), platform: "github" } }).kind, "hidden");
eq("nothing registered", shopifyCard({ info: null, conn: null }).kind, "not_registered");
eq("hand-made connection, not registered", shopifyCard({ info: null, conn: conn("error") }).kind, "not_registered");
eq("registered, never connected", shopifyCard({ info, conn: null }), { kind: "connect", shop: "packs.myshopify.com", tone: "neutral", text: "Approve LumiLink's app on packs.myshopify.com once, in Shopify. You need to be the owner or a staff member who can install apps." });
eq("registered, last attempt failed", shopifyCard({ info: { ...info, last_error: "boom" }, conn: null }).kind, "connect");
const done = { ...info, connected_at: "2026-10-09T21:00:00Z" };
eq("connected, healthy", shopifyCard({ info: done, conn: conn("healthy") }).kind, "connected");
eq("connected, checking", shopifyCard({ info: done, conn: conn("unchecked") }).tone, "ok");
eq("connected, degraded", shopifyCard({ info: done, conn: conn("degraded") }).tone, "warn");
eq("connected but revoked: reconnect", shopifyCard({ info: done, conn: conn("revoked", { last_error: "401" }) }).kind, "connect");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
