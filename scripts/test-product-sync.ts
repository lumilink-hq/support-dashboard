// =============================================================================
// test-product-sync.ts — unit tests for shopify-product-sync/lib.ts.
// No Deno, no Supabase, no network.
//
//   npx tsx scripts/test-product-sync.ts
//   (or: node --experimental-strip-types scripts/test-product-sync.ts)
//
// Fixtures mirror the REAL Tsunami catalog shape captured by
// scripts/check-shopify-scopes.mjs on 2026-07-29 — Flower products, variants
// named by weight, one variant at 0 while its siblings have stock, and a product
// whose status is UNLISTED rather than the documented ACTIVE/DRAFT/ARCHIVED.
// =============================================================================

import {
  isThrottled,
  mapShopifyProduct,
  pickShopifyCreds,
  productsPageFrom,
  shopifyErrorFrom,
  shopifyGraphqlUrl,
  stripHtml,
  throttleWaitMs,
} from "../supabase/functions/shopify-product-sync/lib.ts";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

// --- fixtures ---------------------------------------------------------------
const superRuntz = {
  id: "gid://shopify/Product/111",
  handle: "wave-super-runtz",
  title: "WAVE Super Runtz",
  productType: "Flower",
  vendor: "WAVE",
  status: "ACTIVE",
  tags: ["indica", "thca"],
  description: "<p>A <b>balanced</b> hybrid.</p><p>Smooth finish.</p>",
  onlineStoreUrl: "https://tsunami.store/products/wave-super-runtz",
  totalInventory: 26,
  tracksInventory: true,
  priceRangeV2: {
    minVariantPrice: { amount: "25.0", currencyCode: "USD" },
    maxVariantPrice: { amount: "125.0", currencyCode: "USD" },
  },
  variants: {
    edges: [
      { node: { id: "v1", title: "3.5g", sku: "SR-35", price: "25.0", availableForSale: true, inventoryQuantity: 9 } },
      { node: { id: "v2", title: "7g", sku: "SR-7", price: "45.0", availableForSale: true, inventoryQuantity: 9 } },
      { node: { id: "v3", title: "14g", sku: "SR-14", price: "80.0", availableForSale: true, inventoryQuantity: 8 } },
      // The case that matters: one size sold out while the product is not.
      { node: { id: "v4", title: "28g", sku: "SR-28", price: "125.0", availableForSale: false, inventoryQuantity: 0 } },
    ],
  },
};

const weddingCake = {
  ...superRuntz,
  id: "gid://shopify/Product/222",
  handle: "wave-wedding-cake",
  title: "WAVE Wedding Cake",
  status: "UNLISTED", // real value seen in the probe; not in the documented set
  totalInventory: 27,
};

const soldOut = {
  ...superRuntz,
  id: "gid://shopify/Product/333",
  title: "WAVE Sold Out",
  totalInventory: 0,
  variants: {
    edges: [
      { node: { id: "s1", title: "3.5g", price: "25.0", availableForSale: false, inventoryQuantity: 0 } },
    ],
  },
};

console.log("\nmapShopifyProduct — the variant/stock shape");
const m = mapShopifyProduct(superRuntz)!;
ok("product_ref is the gid", m.product_ref === "gid://shopify/Product/111");
ok("title carried", m.title === "WAVE Super Runtz");
ok("product_type carried", m.product_type === "Flower");
ok("tags carried as strings", Array.isArray(m.tags) && m.tags.includes("thca"));
ok("price band parsed as numbers", m.price_min === 25 && m.price_max === 125, [m.price_min, m.price_max]);
ok("currency from the price range", m.currency === "USD");
ok("total_inventory parsed", m.total_inventory === 26);
ok("tracks_inventory true", m.tracks_inventory === true);
ok("all 4 weight variants kept", m.variants.length === 4);
ok("variant titles are the weights", m.variants.map((v) => v.title).join(",") === "3.5g,7g,14g,28g");
ok("variant inventory parsed", m.variants[3].inventory === 0);
ok("variant price parsed", m.variants[0].price === 25);
ok(
  "available TRUE when only one size is out",
  m.available === true,
  m.available,
);

const so = mapShopifyProduct(soldOut)!;
ok("available FALSE when every variant is out", so.available === false, so.available);

console.log("\nstatus — never validated against an allow-list");
const wc = mapShopifyProduct(weddingCake)!;
ok("UNLISTED survives the mapping", wc.status === "UNLISTED", wc.status);
ok("UNLISTED is not coerced to ACTIVE", wc.status !== "ACTIVE");

console.log("\nstripHtml — descriptions get read out loud");
ok("tags removed", stripHtml("<p>Hello <b>world</b></p>") === "Hello world");
ok("block tags become spaces", stripHtml("<p>One</p><p>Two</p>") === "One Two");
ok("entities decoded", stripHtml("Salt &amp; Pepper &#39;n more") === "Salt & Pepper 'n more");
ok("<br> becomes a space", stripHtml("a<br/>b") === "a b");
ok("whitespace collapsed", stripHtml("  a\n\n   b  ") === "a b");
ok("null in, null out", stripHtml(null) === null);
ok("empty markup -> null", stripHtml("<p></p>") === null);
const long = stripHtml("x".repeat(900))!;
ok("truncated to the cap", long.length <= 600, long.length);
ok("truncation is marked", long.endsWith("…"));

console.log("\nedge cases that must not throw");
ok("no id -> skipped, not crashed", mapShopifyProduct({ title: "x" }) === null);
ok("no variants -> available null", mapShopifyProduct({ id: "g", title: "t" })!.available === null);
ok(
  "untracked inventory -> available true",
  mapShopifyProduct({ id: "g", title: "t", tracksInventory: false })!.available === true,
);
ok("missing price range tolerated", mapShopifyProduct({ id: "g", title: "t" })!.price_min === null);
ok("empty title falls back", mapShopifyProduct({ id: "g" })!.title === "(untitled)");
ok(
  "variant with unknown availability doesn't force false",
  mapShopifyProduct({
    id: "g",
    title: "t",
    variants: { edges: [{ node: { title: "a", inventoryQuantity: 3 } }] },
  })!.available === null,
);

console.log("\nproductsPageFrom — pagination");
const page = productsPageFrom({
  products: {
    pageInfo: { hasNextPage: true, endCursor: "CUR123" },
    edges: [{ node: superRuntz }, { node: weddingCake }, { node: { title: "no id" } }],
  },
});
ok("valid rows mapped", page.rows.length === 2, page.rows.length);
ok("unusable node dropped, page still returned", page.rows.every((r) => r.product_ref));
ok("cursor extracted", page.cursor === "CUR123");
ok("hasNext extracted", page.hasNext === true);
const empty = productsPageFrom(null);
ok("null data -> empty page, no throw", empty.rows.length === 0 && empty.hasNext === false);

console.log("\nShopify's 200-with-errors behaviour");
ok("clean body -> null", shopifyErrorFrom({ data: {} }) === null);
ok("errors array detected", shopifyErrorFrom({ errors: [{ message: "boom" }] }) === "boom");
ok("extension code preferred", shopifyErrorFrom({ errors: [{ extensions: { code: "ACCESS_DENIED" } }] }) === "ACCESS_DENIED");
ok("empty body flagged", shopifyErrorFrom(null) === "empty response");
ok("throttle detected by code", isThrottled({ errors: [{ extensions: { code: "THROTTLED" } }] }));
ok("throttle detected by message", isThrottled({ errors: [{ message: "Throttled" }] }));
ok("plain error is not a throttle", isThrottled({ errors: [{ message: "bad field" }] }) === false);
ok("clean body is not a throttle", isThrottled({ data: {} }) === false);

console.log("\nthrottle backoff");
const w1 = throttleWaitMs({ extensions: { cost: { throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } } } }, 0);
ok("derived from Shopify's restore rate", w1 > 0 && w1 <= 10_000, w1);
ok("capped at 10s", throttleWaitMs({ extensions: { cost: { throttleStatus: { currentlyAvailable: 0, restoreRate: 1 } } } }, 0) === 10_000);
ok("falls back to exponential", throttleWaitMs(null, 2) === 4000, throttleWaitMs(null, 2));
ok("fallback capped", throttleWaitMs(null, 10) === 8000);

console.log("\ncredentials — the woocommerce key trap");
ok("shopify key read", pickShopifyCreds({ shopify: { access_token: "a" } }).access_token === "a");
ok("store key read", pickShopifyCreds({ store: { access_token: "b" } }).access_token === "b");
ok(
  "woocommerce key read (what the RPC actually returns for Shopify)",
  pickShopifyCreds({ woocommerce: { access_token: "c" } }).access_token === "c",
);
ok("JSON string tolerated", pickShopifyCreds({ shopify: '{"access_token":"d"}' }).access_token === "d");
ok("garbage string -> empty, no throw", Object.keys(pickShopifyCreds({ shopify: "{oops" })).length === 0);
ok("null -> empty", Object.keys(pickShopifyCreds(null)).length === 0);

console.log("\nendpoint");
ok(
  "graphql url built at the pinned version",
  shopifyGraphqlUrl("https://tsunami-store-7957.myshopify.com") ===
    "https://tsunami-store-7957.myshopify.com/admin/api/2026-04/graphql.json",
);
ok(
  "trailing slash tolerated",
  shopifyGraphqlUrl("https://x.myshopify.com/") === "https://x.myshopify.com/admin/api/2026-04/graphql.json",
);

console.log(`\nproduct-sync: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
