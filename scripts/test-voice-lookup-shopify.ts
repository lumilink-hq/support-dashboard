// =============================================================================
// test-voice-lookup-shopify.ts — unit tests for the voice-order-lookup pure
// helpers. No Supabase / Deno / network needed. Run with tsx:
//   npx tsx scripts/test-voice-lookup-shopify.ts
//
// Covers the things that actually break on a live call: order numbers the caller
// mumbles, Shopify's two status enums, split-shipment tracking, token-vs-exact
// order matching, and the "200 OK but body says error" case.
// =============================================================================

import {
  ALLOWED_STATUSES,
  buildShopifySearchQuery,
  extractClientRef,
  mapShopifyOrder,
  mapWooOrder,
  normalizeOrderNumber,
  normalizeWooStatus,
  orderNumberCandidates,
  normalizeStatus,
  parseCreds,
  pickExactOrder,
  pickFulfillment,
  pickShipment,
  pickShopifyCreds,
  pickWooOrder,
  shipStationOrderNumber,
  WOO_STATUS_MAP,
  wooOrderUrl,
  SHOPIFY_API_VERSION,
  SHOPIFY_ORDER_QUERY,
  SHOPIFY_POLICIES_QUERY,
  shopifyDisplayStatus,
  shopifyErrorFrom,
  shopifyGraphqlUrl,
  stripHash,
  stripTrailingSlash,
  verifyCaller,
} from "../supabase/functions/voice-order-lookup/lib.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// -----------------------------------------------------------------------------
console.log("\nnormalizeOrderNumber — what the caller actually says");
// -----------------------------------------------------------------------------
check("plain digits", normalizeOrderNumber("1001") === "1001");
check("leading hash", normalizeOrderNumber("#1001") === "1001");
check("whitespace", normalizeOrderNumber("  1001  ") === "1001");
check('"order #1001"', normalizeOrderNumber("order #1001") === "1001");
check('"Order Number 1001"', normalizeOrderNumber("Order Number 1001") === "1001");
check("internal dash kept", normalizeOrderNumber("#1001-A") === "1001-A");
check("letter prefix kept", normalizeOrderNumber("TS1001") === "TS1001");
check("spoken punctuation stripped", normalizeOrderNumber("1001.") === "1001");
check("empty -> null", normalizeOrderNumber("") === null);
check("whitespace only -> null", normalizeOrderNumber("   ") === null);
check("null -> null", normalizeOrderNumber(null) === null);
check("undefined -> null", normalizeOrderNumber(undefined) === null);
check("hash only -> null", normalizeOrderNumber("#") === null);
check("number type coerced", normalizeOrderNumber(1001 as unknown) === "1001");

// -----------------------------------------------------------------------------
console.log("\nstripHash / search query / endpoint");
// -----------------------------------------------------------------------------
check("stripHash removes leading #", stripHash("#1001") === "1001");
check("stripHash tolerates missing #", stripHash("1001") === "1001");
check("stripHash on null", stripHash(null) === "");
check(
  "search query has no #",
  buildShopifySearchQuery("1001") === "name:1001",
  buildShopifySearchQuery("1001"),
);
check(
  "graphql url is versioned",
  shopifyGraphqlUrl("https://x.myshopify.com") ===
    `https://x.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
);
check(
  "graphql url tolerates trailing slash",
  shopifyGraphqlUrl("https://x.myshopify.com/") ===
    `https://x.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
);
check("api version is pinned, not 'latest'", /^\d{4}-\d{2}$/.test(SHOPIFY_API_VERSION));
check(
  "query asks for tracking + both status enums",
  SHOPIFY_ORDER_QUERY.includes("trackingInfo") &&
    SHOPIFY_ORDER_QUERY.includes("displayFinancialStatus") &&
    SHOPIFY_ORDER_QUERY.includes("displayFulfillmentStatus"),
);
check("stripTrailingSlash", stripTrailingSlash("https://a/b///") === "https://a/b");

// -----------------------------------------------------------------------------
console.log("\nshopifyDisplayStatus — two enums collapsed into one");
// -----------------------------------------------------------------------------
check(
  "refund outranks fulfillment",
  shopifyDisplayStatus("REFUNDED", "FULFILLED") === "REFUNDED",
);
check(
  "partial refund outranks fulfillment",
  shopifyDisplayStatus("PARTIALLY_REFUNDED", "FULFILLED") === "PARTIALLY_REFUNDED",
);
check("voided outranks", shopifyDisplayStatus("VOIDED", "UNFULFILLED") === "VOIDED");
check(
  "paid falls through to fulfillment",
  shopifyDisplayStatus("PAID", "UNFULFILLED") === "UNFULFILLED",
);
check(
  "paid + fulfilled -> FULFILLED",
  shopifyDisplayStatus("PAID", "FULFILLED") === "FULFILLED",
);
check(
  "lowercase input normalized",
  shopifyDisplayStatus("refunded", "fulfilled") === "REFUNDED",
);
check(
  "missing fulfillment falls back to financial",
  shopifyDisplayStatus("PENDING", null) === "PENDING",
);
check("both missing -> null", shopifyDisplayStatus(null, null) === null);
// The flag rule is what makes escalation work — these must land inside the
// client's abnormal_statuses array from seed_clients.sql.
const ABNORMAL = ["ON_HOLD", "RESTOCKED", "REFUNDED", "VOIDED", "PARTIALLY_REFUNDED"];
check(
  "refunded order lands in abnormal_statuses",
  ABNORMAL.includes(shopifyDisplayStatus("REFUNDED", "FULFILLED")!),
);
check(
  "on-hold fulfillment lands in abnormal_statuses",
  ABNORMAL.includes(shopifyDisplayStatus("PAID", "ON_HOLD")!),
);
check(
  "healthy order does NOT flag",
  !ABNORMAL.includes(shopifyDisplayStatus("PAID", "FULFILLED")!),
);

// -----------------------------------------------------------------------------
console.log("\npickExactOrder — token match must not leak a stranger's order");
// -----------------------------------------------------------------------------
const nodes = [{ name: "#1001-A" }, { name: "#1001" }];
check("exact match preferred over prefix", pickExactOrder(nodes, "1001")?.name === "#1001");
check("caller's hash tolerated", pickExactOrder(nodes, "#1001")?.name === "#1001");
check("suffixed order matched exactly", pickExactOrder(nodes, "1001-A")?.name === "#1001-A");
check("no exact match -> null", pickExactOrder([{ name: "#1001-A" }], "1001") === null);
check("empty list -> null", pickExactOrder([], "1001") === null);

// --- Order-name PREFIX (Tsunami: orders are named "TSU#1749") ---------------
// Regression guard for 2026-07-29. Both halves of the lookup assumed Shopify's
// default "#1234" shape: normalizeOrderNumber drops "#" as punctuation, so we
// searched name:TSU1749 (nonexistent), and pickExactOrder compared "TSU#1749"
// against "TSU1749" and discarded the real order as a near-miss.
console.log("\norder-name prefix — the store calls it TSU#1749");
const PFX = "TSU#";
const tsu = [{ name: "TSU#1749" }, { name: "TSU#1749-A" }];

check("prefix re-attached when the caller omits it",
  buildShopifySearchQuery(normalizeOrderNumber("1749")!, PFX) === 'name:"TSU#1749"',
  buildShopifySearchQuery(normalizeOrderNumber("1749")!, PFX));
check("prefix not doubled when the caller says it",
  buildShopifySearchQuery(normalizeOrderNumber("TSU#1749")!, PFX) === 'name:"TSU#1749"',
  buildShopifySearchQuery(normalizeOrderNumber("TSU#1749")!, PFX));
check("spoken form 'tsu 1749' resolves",
  buildShopifySearchQuery(normalizeOrderNumber("tsu 1749")!, PFX) === 'name:"TSU#1749"',
  buildShopifySearchQuery(normalizeOrderNumber("tsu 1749")!, PFX));
check("no prefix configured -> unchanged query",
  buildShopifySearchQuery("1001", null) === "name:1001",
  buildShopifySearchQuery("1001", null));

check("digits alone match the prefixed order",
  pickExactOrder(tsu, normalizeOrderNumber("1749")!, PFX)?.name === "TSU#1749");
check("full name matches",
  pickExactOrder(tsu, normalizeOrderNumber("TSU#1749")!, PFX)?.name === "TSU#1749");
check("prefix without punctuation matches",
  pickExactOrder(tsu, normalizeOrderNumber("tsu1749")!, PFX)?.name === "TSU#1749");
check("suffixed near-miss STILL rejected under a prefix",
  pickExactOrder([{ name: "TSU#1749-A" }], normalizeOrderNumber("1749")!, PFX) === null);
check("prefix arg is optional — old call sites unaffected",
  pickExactOrder([{ name: "#1001" }], "1001")?.name === "#1001");
check("case insensitive", pickExactOrder([{ name: "#ts1001" }], "TS1001")?.name === "#ts1001");

// -----------------------------------------------------------------------------
console.log("\npickFulfillment — split shipments");
// -----------------------------------------------------------------------------
check("none -> null", pickFulfillment([]) === null);
check("undefined -> null", pickFulfillment(undefined) === null);
check(
  "prefers the fulfillment that has tracking",
  pickFulfillment([
    { createdAt: "2026-07-20T00:00:00Z", trackingInfo: [] },
    { createdAt: "2026-07-10T00:00:00Z", trackingInfo: [{ number: "1Z1" }] },
  ])?.trackingInfo?.[0]?.number === "1Z1",
);
check(
  "among tracked, picks most recent",
  pickFulfillment([
    { createdAt: "2026-07-10T00:00:00Z", trackingInfo: [{ number: "OLD" }] },
    { createdAt: "2026-07-20T00:00:00Z", trackingInfo: [{ number: "NEW" }] },
  ])?.trackingInfo?.[0]?.number === "NEW",
);
check(
  "falls back to untracked when nothing has tracking",
  pickFulfillment([{ displayStatus: "IN_TRANSIT" }])?.displayStatus === "IN_TRANSIT",
);

// -----------------------------------------------------------------------------
console.log("\nmapShopifyOrder — full node");
// -----------------------------------------------------------------------------
const node = {
  id: "gid://shopify/Order/123",
  name: "#1001",
  createdAt: "2026-07-25T10:00:00Z",
  email: "buyer@example.com",
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "FULFILLED",
  currentTotalPriceSet: { shopMoney: { amount: "142.50", currencyCode: "USD" } },
  customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  shippingAddress: { zip: "94110", city: "SF", province: "CA" },
  lineItems: {
    edges: [
      { node: { name: "Surf Wax", quantity: 2 } },
      { node: { name: "Leash", quantity: 1 } },
    ],
  },
  fulfillments: [
    {
      status: "SUCCESS",
      displayStatus: "IN_TRANSIT",
      createdAt: "2026-07-26T09:00:00Z",
      estimatedDeliveryAt: "2026-07-30T00:00:00Z",
      trackingInfo: [{ number: "1Z999AA", company: "UPS", url: "https://ups.com/x" }],
    },
  ],
};
const m = mapShopifyOrder(node);
check("status", m.store_status === "FULFILLED");
check("customer name", m.customer_name === "Ada Lovelace");
// Zap precedence: customer.email wins over the order-level email.
check("email prefers customer.email", m.customer_email === "ada@example.com");
check("total is a number", m.order_total === 142.5);
check("currency", m.currency === "USD");
check("placed_at is ISO", m.order_placed_at === "2026-07-25T10:00:00.000Z");
check("line items", m.line_items.length === 2 && m.line_items[0].name === "Surf Wax");
check("tracking number", m.tracking_number === "1Z999AA");
check("carrier", m.carrier === "UPS");
// Zap-aligned: shipping_status is the fulfillment's `status`, not displayStatus.
check("shipping status from fulfillment.status", m.shipping_status === "SUCCESS");
check("shipped_at", m.shipped_at === "2026-07-26T09:00:00.000Z");
check("estimated delivery", m.estimated_delivery === "2026-07-30T00:00:00.000Z");
check("raw_store retained", (m.raw_store as any).id === "gid://shopify/Order/123");

console.log("\nmapShopifyOrder — sparse node (unfulfilled, no customer record)");
const sparse = mapShopifyOrder({
  name: "#1002",
  createdAt: "2026-07-28T00:00:00Z",
  displayFinancialStatus: "PENDING",
  displayFulfillmentStatus: "UNFULFILLED",
  currentTotalPriceSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } },
  lineItems: { edges: [] },
  fulfillments: [],
});
check("no tracking -> null", sparse.tracking_number === null);
check("no carrier -> null", sparse.carrier === null);
check("no shipping status -> null", sparse.shipping_status === null);
check("empty line items", sparse.line_items.length === 0);
check("customer name null, not 'undefined undefined'", sparse.customer_name === null);
check("status still resolves", sparse.store_status === "UNFULFILLED");
check("raw_shipping is an object", typeof sparse.raw_shipping === "object");

console.log("\nmapShopifyOrder — falls back to totalPriceSet + shipping address name");
const fallback = mapShopifyOrder({
  name: "#1003",
  createdAt: "bogus-date",
  totalPriceSet: { shopMoney: { amount: "5.00", currencyCode: "EUR" } },
  shippingAddress: { firstName: "Grace", lastName: "Hopper" },
  lineItems: { edges: [] },
  fulfillments: [],
});
check("totalPriceSet fallback", fallback.order_total === 5 && fallback.currency === "EUR");
check("shipping address name fallback", fallback.customer_name === "Grace Hopper");
check("unparseable date -> null, not Invalid Date", fallback.order_placed_at === null);

// -----------------------------------------------------------------------------
console.log("\nmapWooOrder");
// -----------------------------------------------------------------------------
const woo = mapWooOrder(
  {
    status: "processing",
    date_created: "2026-07-25T10:00:00",
    date_created_gmt: "2026-07-25T17:00:00",
    total: "99.99",
    currency: "USD",
    billing: { first_name: "Alan", last_name: "Turing", email: "alan@example.com" },
    line_items: [{ name: "Widget", quantity: 3, total: "89.97" }],
  },
  { trackingNumber: "1Z888", carrierCode: "fedex", shipmentStatus: "shipped", shipDate: "2026-07-26" },
);
check("woo status mapped into the shared token set", woo.store_status === "IN_PROGRESS");
check("woo name", woo.customer_name === "Alan Turing");
check("woo total numeric", woo.order_total === 99.99);
check("woo tracking from shipstation", woo.tracking_number === "1Z888");
check("woo carrier", woo.carrier === "fedex");
check("woo estimated_delivery always null", woo.estimated_delivery === null);
check(
  "woo line items carry a UNIT price like Shopify's",
  woo.line_items[0].price === 29.99,
);
check(
  "date_created_gmt is read as UTC, not as server-local time",
  woo.order_placed_at === "2026-07-25T17:00:00.000Z",
);
const wooNoTrack = mapWooOrder({ status: "on-hold", line_items: [] }, null);
check("woo without tracking", wooNoTrack.tracking_number === null);
check("woo raw_shipping defaults to {}", JSON.stringify(wooNoTrack.raw_shipping) === "{}");
check("woo on-hold maps to ON_HOLD", wooNoTrack.store_status === "ON_HOLD");
check("woo currency defaults to USD, not null", wooNoTrack.currency === "USD");
check("woo total defaults to 0, not null", wooNoTrack.order_total === 0);
check(
  "shipping_status inferred when ShipStation omits it",
  mapWooOrder({}, { trackingNumber: "1Z1" }).shipping_status === "shipped",
);

// -----------------------------------------------------------------------------
console.log("\nnormalizeWooStatus — Woo's vocabulary must join Shopify's");
//
// This is the fix for the highest-impact Woo divergence: evaluate_flag and
// 0013's stale_exempt_statuses both do a JSONB membership test against the
// UPPERCASE token set, so raw Woo statuses could never match a rule — no Woo
// order could flag as abnormal, and no completed Woo order could ever stop the
// staleness clock.
// -----------------------------------------------------------------------------
check("completed -> FULFILLED (this is what stops the staleness clock)",
  normalizeWooStatus("completed") === "FULFILLED");
check("pending -> PENDING", normalizeWooStatus("pending") === "PENDING");
check("processing -> IN_PROGRESS", normalizeWooStatus("processing") === "IN_PROGRESS");
check("on-hold -> ON_HOLD", normalizeWooStatus("on-hold") === "ON_HOLD");
check("refunded -> REFUNDED", normalizeWooStatus("refunded") === "REFUNDED");
check("cancelled -> VOIDED", normalizeWooStatus("cancelled") === "VOIDED");
check("US spelling accepted", normalizeWooStatus("canceled") === "VOIDED");
check("failed -> VOIDED", normalizeWooStatus("failed") === "VOIDED");
check("wc- prefix tolerated", normalizeWooStatus("wc-completed") === "FULFILLED");
check("case-insensitive", normalizeWooStatus("COMPLETED") === "FULFILLED");
check(
  "an unknown plugin status returns null rather than an invented token",
  normalizeWooStatus("awaiting-warehouse") === null,
);
check("empty -> null", normalizeWooStatus("") === null);
check(
  "every mapped value is inside ALLOWED_STATUSES",
  Object.values(WOO_STATUS_MAP).every((v) => ALLOWED_STATUSES.has(v)),
);

// -----------------------------------------------------------------------------
console.log("\nwooOrderUrl — the three lookup schemes the Zap already had");
// -----------------------------------------------------------------------------
check("default is the id path",
  wooOrderUrl("https://budclub.example", "1749").url ===
    "https://budclub.example/wp-json/wc/v3/orders/1749");
check("id path is not a list", wooOrderUrl("https://x.example", "1").returnsList === false);
check("trailing slash tolerated",
  wooOrderUrl("https://budclub.example/", "1749", "id").url.includes("/wp-json/wc/v3/orders/1749"));
check("search scheme",
  wooOrderUrl("https://budclub.example", "1749", "search").url ===
    "https://budclub.example/wp-json/wc/v3/orders?search=1749");
check("search returns a list", wooOrderUrl("https://x.example", "1", "search").returnsList === true);
check("meta scheme carries the key",
  wooOrderUrl("https://budclub.example", "1749", "meta:_order_number").url ===
    "https://budclub.example/wp-json/wc/v3/orders?meta_key=_order_number&meta_value=1749");
check("order numbers are url-encoded",
  wooOrderUrl("https://x.example", "17 49", "search").url.includes("17%2049"));

// -----------------------------------------------------------------------------
console.log("\npickWooOrder — 'search' is full-text and WILL return neighbours");
// -----------------------------------------------------------------------------
check("exact match on the customer-facing number",
  pickWooOrder([{ id: 55, number: "1748" }, { id: 56, number: "1749" }], "1749")?.id === 56);
check("no exact match in a list -> null, never the first result",
  pickWooOrder([{ id: 55, number: "1748" }], "1749") === null);
check("a single object from /orders/{id} is the order",
  pickWooOrder({ id: 812, number: "1749" }, "812")?.id === 812);
check("matches on id when number is absent",
  pickWooOrder([{ id: 1749 }], "1749")?.id === 1749);
check("prefix tolerated on the caller's side",
  pickWooOrder([{ id: 1, number: "1749" }], "TSU1749", "TSU#")?.number === "1749");
check("prefix tolerated on the store's side",
  pickWooOrder([{ id: 1, number: "TSU#1749" }], "1749", "TSU#")?.number === "TSU#1749");
check("empty payload -> null", pickWooOrder([], "1749") === null);
check("null payload -> null", pickWooOrder(null, "1749") === null);

// -----------------------------------------------------------------------------
console.log("\npickShipment — voided labels and split shipments");
// -----------------------------------------------------------------------------
check(
  "a voided label is never read out",
  pickShipment([
    { voided: true, trackingNumber: "VOIDED1", createDate: "2026-07-28" },
    { voided: false, trackingNumber: "REAL1", createDate: "2026-07-27" },
  ])?.trackingNumber === "REAL1",
);
check(
  "most recent shipment wins (the response is unsorted)",
  pickShipment([
    { trackingNumber: "OLD", createDate: "2026-07-20" },
    { trackingNumber: "NEW", createDate: "2026-07-28" },
  ])?.trackingNumber === "NEW",
);
check(
  "prefers a shipment that actually has tracking",
  pickShipment([
    { createDate: "2026-07-28" },
    { trackingNumber: "T1", createDate: "2026-07-20" },
  ])?.trackingNumber === "T1",
);
check("all voided -> null", pickShipment([{ voided: true, trackingNumber: "X" }]) === null);
check("empty -> null", pickShipment([]) === null);
check("undefined -> null", pickShipment(undefined) === null);

// -----------------------------------------------------------------------------
console.log("\nshipStationOrderNumber — the silent no-tracking bug");
//
// ShipStation keys on the CUSTOMER-FACING number. Querying it with Woo's post id
// returned nothing on any store with a sequential-order-number plugin, so every
// WISMO call answered "no tracking yet" while the label existed all along.
// -----------------------------------------------------------------------------
check("prefers the customer-facing number over the post id",
  shipStationOrderNumber({ id: 812, number: "1749" }, "812") === "1749");
check("falls back when the order has no number",
  shipStationOrderNumber({ id: 812 }, "812") === "812");
check("blank number falls back", shipStationOrderNumber({ number: "  " }, "812") === "812");
check("numeric number stringified", shipStationOrderNumber({ number: 1749 }, "812") === "1749");
check("null order falls back", shipStationOrderNumber(null, "812") === "812");

// -----------------------------------------------------------------------------
console.log("\nshopifyErrorFrom — 200 OK is not success");
// -----------------------------------------------------------------------------
check("clean body -> null", shopifyErrorFrom({ data: { orders: { edges: [] } } }) === null);
check("null body -> error", shopifyErrorFrom(null) === "empty response");
check(
  "throttled -> error",
  shopifyErrorFrom({ errors: [{ extensions: { code: "THROTTLED" } }] }) === "THROTTLED",
);
check(
  "message-only error surfaces",
  (shopifyErrorFrom({ errors: [{ message: "Field 'x' doesn't exist" }] }) ?? "").includes(
    "doesn't exist",
  ),
);
check("empty errors array is fine", shopifyErrorFrom({ errors: [], data: {} }) === null);

// -----------------------------------------------------------------------------
console.log("\nparseCreds — a malformed Vault secret must not throw");
// -----------------------------------------------------------------------------
check(
  "valid json",
  parseCreds<{ access_token: string }>('{"access_token":"shpat_x"}').access_token ===
    "shpat_x",
);
check("garbage -> {}", Object.keys(parseCreds("not json")).length === 0);
check("undefined -> {}", Object.keys(parseCreds(undefined)).length === 0);
check("null -> {}", Object.keys(parseCreds(null)).length === 0);
check("json array -> object-ish, no throw", typeof parseCreds("[1,2]") === "object");
check("json scalar -> {}", Object.keys(parseCreds("42")).length === 0);

// -----------------------------------------------------------------------------
console.log("\npickShopifyCreds — the RPC returns the store blob as 'woocommerce'");
// -----------------------------------------------------------------------------
const SHOP_JSON = '{"access_token":"shpat_x","base_url":"https://t.myshopify.com"}';
check(
  "reads the misnamed 'woocommerce' key (current DB behavior)",
  pickShopifyCreds({ woocommerce: SHOP_JSON, shipstation: null }).access_token ===
    "shpat_x",
);
check(
  "prefers an explicit 'shopify' key when present (future-proof)",
  pickShopifyCreds({
    shopify: SHOP_JSON,
    woocommerce: '{"access_token":"wrong"}',
  }).access_token === "shpat_x",
);
check(
  "accepts a generic 'store' key",
  pickShopifyCreds({ store: SHOP_JSON }).access_token === "shpat_x",
);
check("base_url carried through", pickShopifyCreds({ woocommerce: SHOP_JSON }).base_url === "https://t.myshopify.com");
check("no secrets -> {}", Object.keys(pickShopifyCreds(null)).length === 0);
check("empty object -> {}", Object.keys(pickShopifyCreds({})).length === 0);
check(
  "woo creds in the slot -> no token, falls through to env",
  pickShopifyCreds({ woocommerce: '{"consumer_key":"ck_x"}' }).access_token === undefined,
);

// -----------------------------------------------------------------------------
console.log("\nextractClientRef — ElevenLabs sends EMPTY STRINGS, not omissions");
// -----------------------------------------------------------------------------
const phoneBody = {
  called_number: "+14155550123",
  client_ref: "",
  call_sid: "CA_1",
  conversation_id: "",
};
const webBody = {
  called_number: "",
  client_ref: "shopify-store",
  call_sid: "",
  conversation_id: "conv_abc",
};
check("phone: number extracted", extractClientRef(phoneBody).calledNumber === "+14155550123");
check("phone: empty slug is ABSENT, not ''", extractClientRef(phoneBody).clientSlug === null);
check("phone: call sid used as ref", extractClientRef(phoneBody).conversationRef === "CA_1");
check("web: slug extracted", extractClientRef(webBody).clientSlug === "shopify-store");
check("web: empty number is ABSENT", extractClientRef(webBody).calledNumber === null);
check(
  "web: falls back to conversation id for the ref",
  extractClientRef(webBody).conversationRef === "conv_abc",
);
check("client_slug alias accepted", extractClientRef({ client_slug: "x" }).clientSlug === "x");
check("whitespace-only treated as absent", extractClientRef({ client_ref: "   " }).clientSlug === null);
check("empty body -> all null", extractClientRef({}).calledNumber === null);
check("null body doesn't throw", extractClientRef(null).clientSlug === null);
check(
  "system__ variants accepted",
  extractClientRef({ system__called_number: "+1999" }).calledNumber === "+1999",
);

// -----------------------------------------------------------------------------
console.log("\nverifyCaller — the gate protecting live orders on a public page");
// -----------------------------------------------------------------------------
const vNode = {
  email: "buyer@example.com",
  customer: { email: "Ada@Example.com" },
  shippingAddress: { zip: "94110-1234" },
  billingAddress: { zip: "10001" },
};
check("no factor supplied -> missing", verifyCaller(vNode, {}).reason === "missing");
check("blank strings -> missing", verifyCaller(vNode, { email: " ", zip: "" }).reason === "missing");
check("matching customer email (case-insensitive)", verifyCaller(vNode, { email: "ada@example.com" }).ok);
check("matching order-level email", verifyCaller(vNode, { email: "buyer@example.com" }).ok);
check("email with padding", verifyCaller(vNode, { email: "  ADA@example.com " }).ok);
check("wrong email -> mismatch", verifyCaller(vNode, { email: "nope@example.com" }).reason === "mismatch");
check("matching shipping zip, ZIP+4 tolerated", verifyCaller(vNode, { zip: "94110" }).ok);
check("zip given as ZIP+4", verifyCaller(vNode, { zip: "94110-1234" }).ok);
check("spoken zip with spaces", verifyCaller(vNode, { zip: "9 4 1 1 0" }).ok);
check("matching billing zip", verifyCaller(vNode, { zip: "10001" }).ok);
check("wrong zip -> mismatch", verifyCaller(vNode, { zip: "99999" }).reason === "mismatch");
check("partial zip must not pass", verifyCaller(vNode, { zip: "941" }).reason === "mismatch");
check(
  "one right factor is enough",
  verifyCaller(vNode, { email: "wrong@example.com", zip: "94110" }).ok,
);
check("order with no email or zip cannot be verified", verifyCaller({}, { email: "a@b.c" }).reason === "mismatch");
check("null node -> mismatch, never a pass", verifyCaller(null, { zip: "94110" }).reason === "mismatch");

// -----------------------------------------------------------------------------
console.log("\nnormalizeStatus — deterministic replacement for the Zap's Gemini step");
// -----------------------------------------------------------------------------
check(
  "refund still outranks fulfillment",
  normalizeStatus("REFUNDED", "FULFILLED", null) === "REFUNDED",
);
check(
  "fulfillment ON_HOLD surfaces even when displayFulfillmentStatus looks routine",
  normalizeStatus("PAID", "UNFULFILLED", [{ status: "ON_HOLD" }]) === "ON_HOLD",
);
check(
  "RESTOCKED surfaces from a fulfillment",
  normalizeStatus("PAID", "FULFILLED", [{ displayStatus: "RESTOCKED" }]) === "RESTOCKED",
);
check(
  "refund still beats a fulfillment-level hold",
  normalizeStatus("REFUNDED", "FULFILLED", [{ status: "ON_HOLD" }]) === "REFUNDED",
);
check(
  "routine order unaffected by healthy fulfillments",
  normalizeStatus("PAID", "FULFILLED", [{ status: "SUCCESS" }]) === "FULFILLED",
);
check("every output token is in the Zap's ALLOWED set", ALLOWED_STATUSES.has(
  normalizeStatus("PAID", "UNFULFILLED", [{ status: "ON_HOLD" }])!,
));
check("ALLOWED matches the Zap's list size", ALLOWED_STATUSES.size === 15);
check(
  "abnormal_statuses membership still works for Tsunami",
  ["ON_HOLD","RESTOCKED","REFUNDED","VOIDED","PARTIALLY_REFUNDED"]
    .includes(normalizeStatus("PAID", "UNFULFILLED", [{ status: "ON_HOLD" }])!),
);

// -----------------------------------------------------------------------------
console.log("\nZap alignment — both channels write the same orders_cache row");
// -----------------------------------------------------------------------------
check("API version matches the production Zap", SHOPIFY_API_VERSION === "2026-04");
check("query asks for lineItems title", SHOPIFY_ORDER_QUERY.includes("title"));
check("query asks for unit price", SHOPIFY_ORDER_QUERY.includes("originalUnitPriceSet"));
check("query asks for fulfillment status", /fulfillments[\s\S]*status/.test(SHOPIFY_ORDER_QUERY));
check("query asks for zip (verification)", SHOPIFY_ORDER_QUERY.includes("zip"));
check("policies query targets shopPolicies", SHOPIFY_POLICIES_QUERY.includes("shopPolicies"));

const zapShaped = mapShopifyOrder({
  name: "#1001",
  createdAt: "2026-07-25T10:00:00Z",
  email: "order@example.com",
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "FULFILLED",
  currentTotalPriceSet: { shopMoney: { amount: "142.50", currencyCode: "USD" } },
  customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  lineItems: {
    edges: [
      { node: { title: "Wave 7g", quantity: 2, originalUnitPriceSet: { shopMoney: { amount: "45.00" } } } },
    ],
  },
  fulfillments: [
    { status: "SUCCESS", createdAt: "2026-07-26T09:00:00Z", trackingInfo: [{ number: "1Z1", company: "UPS" }] },
  ],
});
check("line item name comes from title", zapShaped.line_items[0].name === "Wave 7g");
check("line item carries price", zapShaped.line_items[0].price === 45);
check("customer.email preferred over order email", zapShaped.customer_email === "ada@example.com");
check("shipping_status from fulfillment.status", zapShaped.shipping_status === "SUCCESS");
check("currency defaults to USD", mapShopifyOrder({ lineItems: { edges: [] } }).currency === "USD");
check("order_total defaults to 0 not null", mapShopifyOrder({ lineItems: { edges: [] } }).order_total === 0);
check(
  "order email used when there is no customer record",
  mapShopifyOrder({ email: "guest@example.com", lineItems: { edges: [] } }).customer_email ===
    "guest@example.com",
);

// -----------------------------------------------------------------------------
// --- orderNumberCandidates -------------------------------------------------
// Callers read "TSU#1749" off a confirmation; Shopify names that order "#1749".
// orders_cache is keyed on the store's canonical name and holds bare digits
// (1491, 1699, 1749), which is how we know the prefix is spoken, not stored.
console.log("\ncandidates — caller says a prefix the store doesn't keep");
check("plain digits -> single attempt",
  orderNumberCandidates("1749").join("|") === "1749",
  orderNumberCandidates("1749").join("|"));
check("letters present -> falls back to digits",
  orderNumberCandidates("TSU1749").join("|") === "TSU1749|1749",
  orderNumberCandidates("TSU1749").join("|"));
check("normalized TSU#1749 yields both forms",
  orderNumberCandidates(normalizeOrderNumber("TSU#1749")!).join("|") === "TSU1749|1749",
  orderNumberCandidates(normalizeOrderNumber("TSU#1749")!).join("|"));
check("lowercase spoken form works",
  orderNumberCandidates(normalizeOrderNumber("tsu 1749")!).join("|") === "tsu1749|1749");
check("no duplicate attempt when digits equal the input",
  orderNumberCandidates("1749").length === 1);
check("suffixed order keeps its shape (no digit-stripping surprise)",
  orderNumberCandidates("1001-A").join("|") === "1001-A|1001");
check("empty -> no attempts", orderNumberCandidates("").length === 0);
// The safety property: a wider ASK must not widen what we ACCEPT.
console.log("\ncandidates must not loosen exact matching");
check("digits candidate still rejects a suffixed near-miss",
  pickExactOrder([{ name: "#1749-A" }], "1749") === null);
check("digits candidate matches the real order",
  pickExactOrder([{ name: "#1749" }], "1749")?.name === "#1749");
check("letter form does NOT match a bare-digit order",
  pickExactOrder([{ name: "#1749" }], "TSU1749") === null);

console.log(
  failures === 0
    ? `\nAll checks passed.`
    : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
