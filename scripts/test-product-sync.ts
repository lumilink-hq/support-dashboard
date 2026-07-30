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
} from "../supabase/functions/product-sync/shopify.ts";
import {
  mapWooProduct,
  needsVariations,
  pickWooCreds,
  wooAvailable,
  wooCurrencyFrom,
  wooProductStatus,
  wooProductType,
  wooProductsPageFrom,
  wooProductsUrl,
  wooTags,
  wooTotalPages,
  wooTracksInventory,
  wooVariationsUrl,
} from "../supabase/functions/product-sync/woo.ts";
import {
  mapStoreProduct,
  minorToMajor,
  storeProbeUrl,
  storeProductsPageFrom,
  storeProductsUrl,
  storeTotalPages,
} from "../supabase/functions/product-sync/woo-store.ts";
import {
  cleanTitle,
  decodeEntities,
  saleFrom,
} from "../supabase/functions/product-sync/types.ts";

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

// =============================================================================
// WooCommerce adapter
//
// Fixtures follow the wc/v3 REST shape: money as STRINGS, categories/tags as
// {id,name,slug} objects, `manage_stock` that can be the string "parent", and a
// variable product whose variations are a separate payload.
// =============================================================================

const wooVariable = {
  id: 812,
  name: "Super Runtz",
  slug: "super-runtz",
  permalink: "https://budclub.example/product/super-runtz/",
  type: "variable",
  status: "publish",
  description: "<p>A <strong>hybrid</strong> strain.</p>",
  short_description: "<p>Hybrid flower.</p>",
  price: "34.99",
  stock_status: "outofstock", // parent lies; variations are the truth
  manage_stock: false,
  stock_quantity: null,
  categories: [{ id: 9, name: "Flower", slug: "format-flower" }],
  tags: [
    { id: 21, name: "Indica", slug: "strain-indica" },
    { id: 22, name: "Sleep", slug: "effect-sleep" },
  ],
  variations: [901, 902],
};

const wooVariations = [
  {
    id: 901,
    sku: "SR-3.5",
    price: "34.99",
    stock_status: "instock",
    stock_quantity: 9,
    manage_stock: true,
    attributes: [{ name: "Weight", option: "3.5g" }],
  },
  {
    id: 902,
    sku: "SR-28",
    price: "199.99",
    stock_status: "outofstock",
    stock_quantity: 0,
    manage_stock: true,
    attributes: [{ name: "Weight", option: "28g" }],
  },
];

const wooSimple = {
  id: 55,
  name: "Grinder",
  slug: "grinder",
  permalink: "https://budclub.example/product/grinder/",
  type: "simple",
  status: "publish",
  short_description: "Four-piece aluminium grinder.",
  sku: "GR-1",
  price: "12.00",
  stock_status: "instock",
  stock_quantity: 40,
  manage_stock: true,
  categories: [{ id: 3, name: "Uncategorized", slug: "uncategorized" }],
  tags: [],
  variations: [],
};

console.log("\nwoo — status + availability");
ok("publish -> ACTIVE", wooProductStatus(wooSimple) === "ACTIVE");
ok("draft -> DRAFT", wooProductStatus({ status: "draft" }) === "DRAFT");
ok(
  "private -> ARCHIVED (exists, never offered)",
  wooProductStatus({ status: "private" }) === "ARCHIVED",
);
ok("instock -> available", wooAvailable({ stock_status: "instock" }) === true);
ok(
  "onbackorder is NOT available (ships later, not now)",
  wooAvailable({ stock_status: "onbackorder" }) === false,
);
ok(
  'manage_stock "parent" counts as tracked',
  wooTracksInventory({ manage_stock: "parent" }) === true,
);
ok("manage_stock false -> untracked", wooTracksInventory({ manage_stock: false }) === false);

console.log("\nwoo — tags and type");
ok(
  "categories + tags flattened to slugs",
  JSON.stringify(wooTags(wooVariable)) ===
    JSON.stringify(["format-flower", "strain-indica", "effect-sleep"]),
);
ok("first real category becomes product_type", wooProductType(wooVariable) === "Flower");
ok(
  "Uncategorized is not a real type (0020 derives one from tags instead)",
  wooProductType(wooSimple) === null,
);

console.log("\nwoo — variable product mapping");
const vmapped = mapWooProduct(wooVariable, {
  currency: "USD",
  variations: wooVariations,
})!;
ok("product_ref is the numeric id as text", vmapped.product_ref === "812");
ok("title from name", vmapped.title === "Super Runtz");
ok("vendor stays null (Woo core has none)", vmapped.vendor === null);
ok("description prefers short_description, HTML stripped", vmapped.description === "Hybrid flower.");
ok("currency injected from store settings", vmapped.currency === "USD");
ok("price band spans the variations", vmapped.price_min === 34.99 && vmapped.price_max === 199.99);
ok("variant titles come from the attribute option", vmapped.variants[0].title === "3.5g");
ok("per-variant stock survives", vmapped.variants[0].inventory === 9);
ok(
  "available if ANY variation is, even when the parent says outofstock",
  vmapped.available === true,
);
ok("total_inventory sums the variations", vmapped.total_inventory === 9);
ok("tracks_inventory from the variations' own flag is not assumed on the parent", vmapped.tracks_inventory === false);

console.log("\nwoo — simple product mapping");
const smapped = mapWooProduct(wooSimple, { currency: "USD" })!;
ok("one synthetic variant so the shape matches Shopify", smapped.variants.length === 1);
ok("simple variant carries the sku", smapped.variants[0].sku === "GR-1");
ok("price band collapses to the single price", smapped.price_min === 12 && smapped.price_max === 12);
ok("string price parsed to a number", typeof smapped.price_min === "number");
ok("stock_quantity carried", smapped.total_inventory === 40);

console.log("\nwoo — null discipline");
ok("no id -> dropped", mapWooProduct({ name: "x" }) === null);
ok("no name -> dropped", mapWooProduct({ id: 1 }) === null);
const untracked = mapWooProduct({
  id: 7,
  name: "Sticker",
  stock_status: "instock",
  manage_stock: false,
  stock_quantity: null,
})!;
ok(
  'untracked stock is null, not 0 ("not counted" != "none left")',
  untracked.total_inventory === null,
);

console.log("\nwoo — paging");
ok(
  "products url is 1-based with status=any",
  wooProductsUrl("https://budclub.example", 2) ===
    "https://budclub.example/wp-json/wc/v3/products?per_page=100&page=2&status=any&orderby=id&order=asc",
);
ok(
  "page 0 clamps to 1",
  wooProductsUrl("https://budclub.example/", 0).includes("page=1"),
);
ok(
  "variations url",
  wooVariationsUrl("https://budclub.example", 812) ===
    "https://budclub.example/wp-json/wc/v3/products/812/variations?per_page=100",
);
const hdr = (v: Record<string, string>) => ({ get: (k: string) => v[k.toLowerCase()] ?? null });
ok("total pages read from the header", wooTotalPages(hdr({ "x-wp-totalpages": "3" })) === 3);
ok(
  "missing header -> null, so the caller must not prune",
  wooTotalPages(hdr({})) === null,
);
ok("garbage header -> null", wooTotalPages(hdr({ "x-wp-totalpages": "many" })) === null);

console.log("\nwoo — currency + creds");
ok(
  "currency from settings/general",
  wooCurrencyFrom([{ id: "woocommerce_currency", value: "CAD" }]) === "CAD",
);
ok("missing currency defaults to USD", wooCurrencyFrom([]) === "USD");
ok("garbage currency defaults to USD", wooCurrencyFrom([{ id: "woocommerce_currency", value: "??" }]) === "USD");
ok(
  "creds read from the woocommerce key",
  pickWooCreds({ woocommerce: { consumer_key: "ck", consumer_secret: "cs" } }).consumer_key === "ck",
);
ok(
  "creds tolerate a JSON string",
  pickWooCreds({ woocommerce: '{"consumer_key":"ck2"}' }).consumer_key === "ck2",
);
ok("garbage creds -> empty, no throw", Object.keys(pickWooCreds({ woocommerce: "{oops" })).length === 0);
ok("needsVariations only for variable products", needsVariations(wooVariable) === true && needsVariations(wooSimple) === false);

console.log("\nwoo — page mapping");
const wpage = wooProductsPageFrom([wooVariable, wooSimple, { id: 3 }], {
  currency: "USD",
  variationsById: { "812": wooVariations },
});
ok("unusable products dropped, not written blank", wpage.rows.length === 2);
ok("variations matched to their parent by id", wpage.rows[0].variants.length === 2);

// =============================================================================
// Public Store API adapter
//
// Fixture is a VERBATIM trim of a real budclub.com response captured 2026-07-30.
// Note the things that only show up against a live store: prices in MINOR UNITS
// as strings, an entity-encoded name (&#8211;), merchandising categories
// ("BOGO Deal") sitting where a product type should be, a `brands` array, and a
// "simple" product that still advertises sizes through attribute terms.
// =============================================================================

const storeProduct = {
  id: 87142,
  name: "Milk and Cookies &#8211; Hybrid – 3.5G",
  slug: "milk-and-cookies-hybrid-ounce-special-copy",
  type: "simple",
  permalink: "https://budclub.com/product/milk-and-cookies-hybrid-ounce-special-copy/",
  sku: "BC-M&#038;C-3.5G-BOGO",
  short_description: "",
  description: "<p>Hints of vanilla, sweet cream, and baked dough give Milk and Cookies a smooth finish.</p>",
  prices: {
    price: "2500",
    regular_price: "5000",
    sale_price: "2500",
    price_range: null,
    currency_code: "USD",
    currency_minor_unit: 2,
  },
  categories: [
    { id: 391, name: "BOGO Deal", slug: "bogo-deal" },
    { id: 401, name: "BUD CLUB", slug: "budclub" },
  ],
  tags: [{ id: 396, name: "BUDCLUB", slug: "budclub" }],
  brands: [{ id: 387, name: "BUDCLUB", slug: "budclub" }],
  attributes: [
    {
      id: 18,
      name: "Flower Size Options",
      taxonomy: "pa_flower-size-options",
      has_variations: true,
      terms: [
        { id: 394, name: "14G", slug: "14g" },
        { id: 395, name: "28G", slug: "28g" },
        { id: 392, name: "3.5G", slug: "3-5g" },
        { id: 393, name: "7G", slug: "7g" },
      ],
    },
  ],
  variations: [],
  is_in_stock: false,
  is_on_backorder: false,
  low_stock_remaining: null,
};

console.log("\nstore api — minor units (the hundredfold-error field)");
ok('"2500" at minor_unit 2 is 25.00, not 2500', minorToMajor("2500", 2) === 25);
ok("minor_unit 0 (JPY) is not divided", minorToMajor("2500", 0) === 2500);
ok("minor_unit 3 supported", minorToMajor("2500", 3) === 2.5);
ok("absent minor_unit defaults to 2", minorToMajor("2500", undefined) === 25);
ok("garbage minor_unit falls back to 2", minorToMajor("2500", "abc") === 25);
ok("null price -> null", minorToMajor(null, 2) === null);

console.log("\nstore api — entity + typography decoding");
ok("numeric entity decoded", decodeEntities("A &#8211; B") === "A – B");
ok("hex entity decoded", decodeEntities("&#x2019;") === "’");
ok("named entity decoded", decodeEntities("Tom &amp; Jerry") === "Tom & Jerry");
ok(
  "double-encoded entity does not become live",
  decodeEntities("&amp;#8211;") === "&#8211;",
);
ok("en dash normalized to hyphen for matching", cleanTitle("A – B") === "A - B");
ok("curly apostrophe normalized", cleanTitle("Devil’s Lettuce") === "Devil's Lettuce");
ok(
  "real product name cleaned end to end",
  cleanTitle(storeProduct.name) === "Milk and Cookies - Hybrid - 3.5G",
);

console.log("\nstore api — product mapping");
const smap = mapStoreProduct(storeProduct)!;
ok("id preserved so auth/public syncs UPDATE the same row", smap.product_ref === "87142");
ok("price read as dollars", smap.price_min === 25 && smap.price_max === 25);
ok("currency from the payload", smap.currency === "USD");
ok("status is always ACTIVE (only published products are returned)", smap.status === "ACTIVE");
ok("brand becomes vendor", smap.vendor === "BUDCLUB");
ok(
  'merchandising category "BOGO Deal" is NOT the product type',
  smap.product_type !== "BOGO Deal",
);
ok(
  "brand-named category is not the product type either",
  smap.product_type === null,
);
ok("out of stock respected", smap.available === false);
ok(
  "tracks_inventory false — the public API has no counts, so never claim one",
  smap.tracks_inventory === false,
);
ok("no count available", smap.total_inventory === null);
ok("description falls back from empty short_description", (smap.description ?? "").startsWith("Hints of vanilla"));
ok(
  "attribute term slugs are searchable tags",
  smap.tags.includes("3-5g") && smap.tags.includes("28g"),
);
ok("brand slug in tags", smap.tags.includes("budclub"));
ok(
  "sizes surface as variants even on a 'simple' product",
  smap.variants.length === 4 && smap.variants.some((v) => v.title === "3.5G"),
);
ok(
  "variant prices are null, never the parent's (would misquote a size)",
  smap.variants.every((v) => v.price === null),
);

console.log("\nstore api — price ranges and stock");
const ranged = mapStoreProduct({
  ...storeProduct,
  id: 1,
  prices: {
    price: "2500",
    price_range: { min_amount: "2500", max_amount: "11000" },
    currency_code: "USD",
    currency_minor_unit: 2,
  },
  is_in_stock: true,
})!;
ok("price_range drives the band", ranged.price_min === 25 && ranged.price_max === 110);
ok("in stock respected", ranged.available === true);
ok(
  "backorder is not available",
  mapStoreProduct({ ...storeProduct, id: 2, is_in_stock: true, is_on_backorder: true })!
    .available === false,
);
ok(
  "low_stock_remaining used when the store opts into showing it",
  mapStoreProduct({ ...storeProduct, id: 3, low_stock_remaining: 4 })!.total_inventory === 4,
);

console.log("\nstore api — null discipline and paging");
ok("no id -> dropped", mapStoreProduct({ name: "x" }) === null);
ok("no name -> dropped", mapStoreProduct({ id: 1 }) === null);
ok(
  "a variation row is never synced as a product",
  mapStoreProduct({ ...storeProduct, id: 9, type: "variation" }) === null,
);
ok(
  "products url is 1-based",
  storeProductsUrl("https://budclub.com", 2) ===
    "https://budclub.com/wp-json/wc/store/v1/products?per_page=100&page=2&orderby=id&order=asc",
);
ok("probe url asks for one product", storeProbeUrl("https://budclub.com").endsWith("per_page=1"));
ok("total pages from header", storeTotalPages(hdr({ "x-wp-totalpages": "5" })) === 5);
ok("missing header -> null (suppresses the prune)", storeTotalPages(hdr({})) === null);
const spage = storeProductsPageFrom([storeProduct, { id: 5 }, { name: "no id" }]);
ok("unusable rows dropped", spage.rows.length === 1 && spage.count === 3);

// =============================================================================
// Sale detection (0024) — shared by all three adapters
// =============================================================================
console.log("\nsale detection");
ok("higher reference price is a discount", saleFrom(25, 50).on_sale === true);
ok("and it is carried through", saleFrom(25, 50).compare_at === 50);
ok(
  'compare-at EQUAL to price is not a sale (would announce "0% off")',
  saleFrom(25, 25).on_sale === false,
);
ok("compare-at BELOW price is not a sale", saleFrom(25, 20).on_sale === false);
ok("no compare-at -> not a sale", saleFrom(25, null).on_sale === false);
ok("no price -> not a sale", saleFrom(null, 50).on_sale === false);
ok("non-sale returns a null reference, not a stale number", saleFrom(25, 25).compare_at === null);

ok(
  "store api: sale read from minor-unit regular_price",
  mapStoreProduct(storeProduct)!.on_sale === true,
);
ok(
  "store api: was-price converted from minor units",
  mapStoreProduct(storeProduct)!.compare_at_min === 50,
);
ok(
  "store api: on_sale=true with no reference price is not trusted alone",
  mapStoreProduct({
    ...storeProduct,
    id: 77,
    on_sale: true,
    prices: { price: "2500", currency_code: "USD", currency_minor_unit: 2 },
  })!.on_sale === false,
);
ok(
  "woo rest: regular_price drives the discount",
  mapWooProduct({ id: 1, name: "X", price: "25", regular_price: "50", on_sale: true })!
    .compare_at_min === 50,
);
ok(
  "woo rest: equal regular_price is not a sale",
  mapWooProduct({ id: 1, name: "X", price: "25", regular_price: "25", on_sale: true })!
    .on_sale === false,
);
ok(
  "shopify: compareAtPriceRange drives the discount",
  mapShopifyProduct({
    ...superRuntz,
    compareAtPriceRange: {
      minVariantCompareAtPrice: { amount: "70.00" },
      maxVariantCompareAtPrice: { amount: "90.00" },
    },
  })!.on_sale === true,
);
ok(
  "shopify: no compare-at -> not on sale",
  mapShopifyProduct(superRuntz)!.on_sale === false,
);

console.log("\nparity — all three adapters produce the same row shape");
const shopifyKeys = JSON.stringify(Object.keys(mapShopifyProduct(superRuntz)!).sort());
const wooKeys = JSON.stringify(Object.keys(vmapped).sort());
const storeKeys = JSON.stringify(Object.keys(smap).sort());
ok(
  "identical ProductRow keys (this is what keeps products_cache platform-agnostic)",
  shopifyKeys === wooKeys && wooKeys === storeKeys,
  { shopifyKeys, wooKeys, storeKeys },
);
const variantKeys = (r: any) => JSON.stringify(Object.keys(r.variants[0]).sort());
ok(
  "identical variant keys across all three adapters",
  variantKeys(mapShopifyProduct(superRuntz)!) === variantKeys(vmapped) &&
    variantKeys(vmapped) === variantKeys(smap),
);

console.log(`\nproduct-sync: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
