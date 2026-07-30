// =============================================================================
// test-product-lookup.ts — unit tests for voice-product-lookup/lib.ts.
//
//   npx tsx scripts/test-product-lookup.ts
//   (or: node --experimental-strip-types scripts/test-product-lookup.ts)
//
// The behaviour under test that matters most: STALE STOCK MUST NOT REACH THE
// AGENT AT ALL. Not softened, not hedged — removed. A hedged "it might be in
// stock" is heard as yes by a caller, and for a store that ships discreetly a
// wrong yes is a refund and a complaint.
// =============================================================================

import {
  buildProductResponse,
  extractClientRef,
  normalizeProductQuery,
  toCatalogOverview,
  toSpokenProduct,
} from "../supabase/functions/voice-product-lookup/lib.ts";

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

// Mirrors the real Tsunami catalogue: 28g out, smaller sizes in.
const freshMatch = {
  title: "WAVE Super Runtz",
  product_type: "Flower",
  currency: "USD",
  price_min: 25,
  price_max: 125,
  description: "A balanced hybrid.",
  available: true,
  stock_confidence: "fresh",
  total_inventory: 26,
  variants: [
    { title: "3.5g", price: 25, available: true, inventory: 9 },
    { title: "7g", price: 45, available: true, inventory: 9 },
    { title: "14g", price: 80, available: true, inventory: 8 },
    { title: "28g", price: 125, available: false, inventory: 0 },
  ],
};
const staleMatch = { ...freshMatch, stock_confidence: "stale", total_inventory: null };
const untrackedMatch = { ...freshMatch, stock_confidence: "none", available: null };

console.log("\nextractClientRef — empty strings are absent");
ok("phone shape", (() => { const r = extractClientRef({ called_number: "+12135332469", client_ref: "" }); return r.calledNumber === "+12135332469" && r.clientSlug === null; })());
ok("web shape", (() => { const r = extractClientRef({ called_number: "", client_ref: "shopify-store" }); return r.calledNumber === null && r.clientSlug === "shopify-store"; })());
ok("client_slug alias accepted", extractClientRef({ client_slug: "x" }).clientSlug === "x");
ok("whitespace-only is absent", extractClientRef({ called_number: "   " }).calledNumber === null);
ok("call_sid preferred as the ref", extractClientRef({ call_sid: "CA1", conversation_id: "conv_1" }).conversationRef === "CA1");
ok("conversation_id falls back (web)", extractClientRef({ call_sid: "", conversation_id: "conv_1" }).conversationRef === "conv_1");
ok("empty body doesn't throw", extractClientRef({}).calledNumber === null);
ok("null body doesn't throw", extractClientRef(null).clientSlug === null);

console.log("\nnormalizeProductQuery");
ok("plain name kept", normalizeProductQuery("Super Runtz") === "Super Runtz");
ok("conversational prefix stripped", normalizeProductQuery("do you have gummies") === "gummies");
ok("'do you sell' stripped", normalizeProductQuery("do you sell pre-rolls") === "pre-rolls");
ok("'got any' stripped", normalizeProductQuery("got any Zoap") === "Zoap");
ok("trailing question mark dropped", normalizeProductQuery("gummies?") === "gummies");
ok("weights survive", normalizeProductQuery("3.5g Wedding Cake") === "3.5g Wedding Cake");
ok("hyphen survives", normalizeProductQuery("pre-roll") === "pre-roll");
ok("ampersand survives", normalizeProductQuery("Salt & Pepper") === "Salt & Pepper");
ok("punctuation scrubbed", normalizeProductQuery("what about #WAVE!!") === "what about WAVE");
ok("empty -> null", normalizeProductQuery("") === null);
ok("whitespace -> null", normalizeProductQuery("   ") === null);
ok("null -> null", normalizeProductQuery(null) === null);

console.log("\ntoSpokenProduct — FRESH cache");
const sp = toSpokenProduct(freshMatch);
ok("name carried", sp.name === "WAVE Super Runtz");
ok("price band carried", sp.price_from === 25 && sp.price_to === 125);
ok("in_stock stated when fresh", sp.in_stock === true);
ok("in-stock sizes listed", sp.sizes_in_stock.join(",") === "3.5g,7g,14g", sp.sizes_in_stock);
ok("out-of-stock size listed separately", sp.sizes_out_of_stock.join(",") === "28g", sp.sizes_out_of_stock);
ok("per-size availability present", sp.sizes[3].available === false);
ok("confidence reported", sp.stock_confidence === "fresh");

console.log("\ntoSpokenProduct — STALE cache (stock must vanish)");
const st = toSpokenProduct(staleMatch);
ok("in_stock withheld", st.in_stock === null, st.in_stock);
ok("in-stock size list EMPTY", st.sizes_in_stock.length === 0, st.sizes_in_stock);
ok("out-of-stock size list EMPTY", st.sizes_out_of_stock.length === 0, st.sizes_out_of_stock);
ok("per-size availability nulled", st.sizes.every((v) => v.available === null));
ok("sizes themselves still offered", st.sizes.map((v) => v.size).join(",") === "3.5g,7g,14g,28g");
ok("prices survive staleness", st.price_from === 25 && st.sizes[0].price === 25);
ok("description survives staleness", st.description === "A balanced hybrid.");
ok("confidence says stale", st.stock_confidence === "stale");

console.log("\ntoSpokenProduct — untracked inventory");
const un = toSpokenProduct(untrackedMatch);
ok("in_stock null when untracked", un.in_stock === null);
ok("confidence says none", un.stock_confidence === "none");
ok("no size lists asserted", un.sizes_in_stock.length === 0 && un.sizes_out_of_stock.length === 0);

console.log("\ntoSpokenProduct — malformed input");
ok("no variants doesn't throw", toSpokenProduct({ title: "x", stock_confidence: "fresh" }).sizes.length === 0);
ok("variants not an array doesn't throw", toSpokenProduct({ title: "x", variants: "nope" }).sizes.length === 0);
ok("missing title falls back", toSpokenProduct({}).name === "(unnamed)");

console.log("\nbuildProductResponse — the four outcomes");
const found = buildProductResponse({ ok: true, fresh: true, matches: [freshMatch] });
ok("found true", found.found === true);
ok("stock_known true when fresh", found.stock_known === true);
ok("products mapped", found.products?.length === 1);
ok("message permits stating stock", /may say whether/i.test(found.message ?? ""));

const staleRes = buildProductResponse({ ok: true, fresh: false, matches: [staleMatch] });
ok("stale: still found", staleRes.found === true);
ok("stale: stock_known false", staleRes.stock_known === false);
ok("stale: message FORBIDS stating stock", /do NOT say whether it is in stock/i.test(staleRes.message ?? ""), staleRes.message);
ok("stale: no size claims leak through", staleRes.products![0].sizes_in_stock.length === 0);

const none = buildProductResponse({ ok: true, fresh: true, matches: [] });
ok("no match: found false", none.found === false);
ok("no match: count zero", none.match_count === 0);
ok("no match: forbids speculation", /do not speculate/i.test(none.message ?? ""));
ok("no match: NOT flagged as catalogue failure", none.catalog_unavailable === undefined);

const unsynced = buildProductResponse({ ok: false, error: "catalog_not_synced" });
ok("unsynced: found false", unsynced.found === false);
ok("unsynced: flagged as unavailable", unsynced.catalog_unavailable === true);
ok(
  "unsynced: explicitly forbids 'we don't sell that'",
  /Do NOT tell the caller the item does not exist/i.test(unsynced.message ?? ""),
  unsynced.message,
);
ok(
  "unsynced is DISTINGUISHABLE from a genuine no-match",
  unsynced.catalog_unavailable === true && none.catalog_unavailable === undefined,
);

const needName = buildProductResponse({ ok: false, error: "need_product_name" });
ok("need_product_name flagged", needName.need_product_name === true);
ok("need_product_name is not a catalogue failure", needName.catalog_unavailable === undefined);

const unknownErr = buildProductResponse({ ok: false, error: "something_else" });
ok("unknown error -> catalogue unavailable", unknownErr.catalog_unavailable === true);
ok("unknown error forbids guessing", /Do NOT guess/i.test(unknownErr.message ?? ""));
ok("garbage rpc doesn't throw", buildProductResponse(null).found === false);


// =============================================================================
// 0019 — loose matching and the catalogue fallback.
//
// The catalogue spans several brands, and callers say short names ("Runtz"),
// tags ("indica"), or a brand alone. A miss must offer options, never assert the
// store doesn't sell something.
// =============================================================================
console.log("\ntoCatalogOverview");
const rawCat = {
  types: [
    { type: "Flower", n: 12, examples: ["WAVE Super Runtz", "WAVE Zoap"] },
    { type: "Pre-Roll", n: 3, examples: ["Sunset Pre-Roll"] },
  ],
  brands: ["WAVE", "Sunset"],
};
const cat = toCatalogOverview(rawCat)!;
ok("types mapped", cat.types.length === 2);
ok("counts coerced to numbers", cat.types[0].n === 12);
ok("examples carried", cat.types[0].examples[0] === "WAVE Super Runtz");
ok("brands carried (multi-brand catalogue)", cat.brands.join(",") === "WAVE,Sunset");
ok("null -> undefined", toCatalogOverview(null) === undefined);
ok("empty shape -> undefined", toCatalogOverview({ types: [], brands: [] }) === undefined);
ok("garbage -> undefined", toCatalogOverview("nope") === undefined);
ok("partial shape tolerated", toCatalogOverview({ brands: ["X"] })!.brands[0] === "X");
ok("missing examples tolerated", toCatalogOverview({ types: [{ type: "T" }] })!.types[0].examples.length === 0);

console.log("\nbuildProductResponse — miss WITH a catalogue");
const missWithCat = buildProductResponse({ ok: true, fresh: true, matches: [], catalog: rawCat });
ok("still found:false", missWithCat.found === false);
ok("catalog attached", missWithCat.catalog?.types.length === 2);
ok("message FORBIDS 'we don't sell it'", /Do NOT say the store doesn't sell it/i.test(missWithCat.message ?? ""), missWithCat.message);
ok("message names the real types", /Flower, Pre-Roll/.test(missWithCat.message ?? ""), missWithCat.message);
ok("message forbids inventing products", /Never invent a product/i.test(missWithCat.message ?? ""));
ok("not flagged as a catalogue failure", missWithCat.catalog_unavailable === undefined);

console.log("\nbuildProductResponse — miss with NO catalogue (empty store)");
const missNoCat = buildProductResponse({ ok: true, fresh: true, matches: [], catalog: null });
ok("falls back to the older wording", /describe it differently/i.test(missNoCat.message ?? ""));
ok("no catalog key when there's nothing to offer", missNoCat.catalog === undefined);

console.log("\ncatalogue is absent on a HIT (payload stays small for voice)");
const hitWithCat = buildProductResponse({ ok: true, fresh: true, matches: [freshMatch], catalog: rawCat });
ok("hit ignores the catalog field", hitWithCat.catalog === undefined);
ok("hit still returns products", hitWithCat.products?.length === 1);


console.log("\nbuildProductResponse — BROAD hit (0020)");
const broad = buildProductResponse({ ok: true, fresh: true, broad: true, total_matches: 52,
  matches: [freshMatch], catalog: rawCat });
ok("broad: found true", broad.found === true);
ok("broad: flag surfaced", broad.broad === true);
ok("broad: total_matches carried", broad.total_matches === 52);
ok("broad: catalogue attached for narrowing", broad.catalog?.types.length === 2);
ok("broad: message states the real count", /matched 52 products/.test(broad.message ?? ""), broad.message);
ok("broad: forbids reading the few as the whole range", /do NOT just read these few out/i.test(broad.message ?? ""));
ok("broad: asks exactly one narrowing question", /ONE narrowing question/.test(broad.message ?? ""));
ok("broad: still carries the stock verdict", /Stock figures are current/.test(broad.message ?? ""));

const broadStale = buildProductResponse({ ok: true, fresh: false, broad: true, total_matches: 52,
  matches: [staleMatch], catalog: rawCat });
ok("broad+stale: stock still withheld", broadStale.stock_known === false);
ok("broad+stale: stock prohibition survives", /do NOT say whether it is in stock/i.test(broadStale.message ?? ""));

const narrow = buildProductResponse({ ok: true, fresh: true, total_matches: 1, matches: [freshMatch] });
ok("narrow hit: no broad flag", narrow.broad === undefined);
ok("narrow hit: no catalogue attached", narrow.catalog === undefined);
ok("narrow hit: total_matches carried", narrow.total_matches === 1);
ok("narrow hit: falls back to match_count when total absent",
   buildProductResponse({ ok: true, fresh: true, matches: [freshMatch] }).total_matches === 1);

console.log(`\nproduct-lookup: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
