// =============================================================================
// test-seo-search-console.ts — unit tests for module 21's pure helpers
// (seo-search-console/lib.ts and insights.ts).
//
//   npx tsx scripts/test-seo-search-console.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  addMonths,
  classifyStatus,
  dailyRows,
  keywordCounts,
  latestDate,
  mergeTop,
  monthEnd,
  monthsBetween,
  normalisePageUrl,
  normaliseQuery,
  pendingMonths,
  syncWindow,
} from "../supabase/functions/seo-search-console/lib.ts";
import {
  brandHeadline,
  brandLead,
  brandSource,
  brandSplit,
  brandTerms,
  comparisonRange,
  ctrUpside,
  headlinePeriod,
  heroSentence,
  isBrandQuery,
  markers,
  monthlyTotals,
  periodForMonth,
  rangeLabel,
  searchSummary,
  siteBrandTerm,
  storeHeadline,
  storeTraffic,
  sumRange,
  underPage,
  type DayTotal,
  type KeywordCountRow,
} from "../supabase/functions/seo-search-console/insights.ts";

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

// -----------------------------------------------------------------------------
// Dates and the sync window
// -----------------------------------------------------------------------------
eq("monthEnd: leap February", monthEnd("2028-02-10"), "2028-02-29");
eq("addMonths: back across a year", addMonths("2026-01-15", -2), "2025-11-01");
eq("monthsBetween", monthsBetween("2026-07-29", "2026-09-02"), ["2026-07-01", "2026-08-01", "2026-09-01"]);

eq("syncWindow: never pulled backfills 16 months",
  syncWindow({ data_through: null, backfilled_at: null }, "2026-10-01"),
  { start: "2025-07-01", end: "2026-10-01", backfill: true });
eq("syncWindow: an unfinished backfill starts over",
  syncWindow({ data_through: "2026-09-20", backfilled_at: null }, "2026-10-01").backfill, true);
eq("syncWindow: after the backfill, re-pull the trailing 4 days",
  syncWindow({ data_through: "2026-09-28", backfilled_at: "2026-09-29T00:00:00Z" }, "2026-10-01"),
  { start: "2026-09-25", end: "2026-10-01", backfill: false });

// -----------------------------------------------------------------------------
// Rows
// -----------------------------------------------------------------------------
const d = dailyRows(
  [
    { keys: ["2026-09-01"], clicks: 10, impressions: 200, ctr: 0.05, position: 6.123 },
    { keys: ["not-a-date"], clicks: 1, impressions: 1 },
    { keys: ["2026-09-02"], clicks: 0, impressions: 0, ctr: 0, position: 0 },
  ],
  false,
);
eq("dailyRows: skips a malformed date", d.length, 2);
eq("dailyRows: rounds position", d[0].position, 6.12);
eq("dailyRows: no impressions means no ctr or position, not zero", [d[1].ctr, d[1].position], [null, null]);
eq("dailyRows: device rows", dailyRows([{ keys: ["2026-09-01", "MOBILE"], clicks: 3, impressions: 9 }, { keys: ["2026-09-01", "TV"], clicks: 1, impressions: 1 }], true).map((r) => r.device), ["mobile"]);
eq("latestDate", latestDate([{ date: "2026-09-02" }, { date: "2026-09-28" }, { date: "2026-09-10" }]), "2026-09-28");

// -----------------------------------------------------------------------------
// URL normalising: their export had the same page five times
// -----------------------------------------------------------------------------
const variants = [
  "https://packsclub.com/menu/san-gabriel-valley?utm_source=gmb-san-gabriel-valley&utm_campaign=dispenza",
  "https://www.packsclub.com/menu/san-gabriel-valley",
  "http://www.packsclub.com/menu/san-gabriel-valley/",
  "https://packsclub.com/menu/san-gabriel-valley#top",
  "HTTPS://WWW.PACKSCLUB.COM/menu/san-gabriel-valley/?gclid=abc",
];
eq("normalise: every variant is one page", [...new Set(variants.map(normalisePageUrl))], ["packsclub.com/menu/san-gabriel-valley"]);
eq("normalise: keeps a real query parameter", normalisePageUrl("https://x.com/search?q=vape&utm_medium=x"), "x.com/search?q=vape");
eq("normalise: keeps path case", normalisePageUrl("https://x.com/Brands/PLUGplay"), "x.com/Brands/PLUGplay");
eq("normalise: decodes spaces in paths", normalisePageUrl("https://x.com/brands/heady%20heads"), "x.com/brands/heady heads");
eq("normalise: the home page", normalisePageUrl("https://www.x.com/"), "x.com");
eq("normalise: no scheme", normalisePageUrl("x.com/a/"), "x.com/a");

const merged = mergeTop(
  [
    { keys: ["https://x.com/a"], clicks: 10, impressions: 100, position: 2 },
    { keys: ["https://www.x.com/a/?utm_source=gmb"], clicks: 5, impressions: 300, position: 6 },
    { keys: ["https://x.com/b"], clicks: 20, impressions: 50, position: 1 },
  ],
  normalisePageUrl,
);
eq("mergeTop: merged and sorted by clicks", merged.map((m) => [m.key, m.clicks, m.impressions]), [["x.com/b", 20, 50], ["x.com/a", 15, 400]]);
eq("mergeTop: position is impression-weighted", merged[1].position, 5);
eq("mergeTop: limit", mergeTop([{ keys: ["a"], clicks: 1 }, { keys: ["b"], clicks: 2 }], (k) => k, 1).map((r) => r.key), ["b"]);

eq("normaliseQuery", normaliseQuery("  Weed  Dispensary Near ME "), "weed dispensary near me");
eq(
  "keywordCounts: counted over all rows, merged by query",
  keywordCounts([
    { keys: ["a"], impressions: 10, position: 2 },
    { keys: ["A "], impressions: 10, position: 4 }, // merges with "a": weighted position 3
    { keys: ["b"], impressions: 5, position: 9 },
    { keys: ["c"], impressions: 5, position: 15 },
    { keys: ["d"], impressions: 0, position: 1 }, // no impressions: not a ranking keyword
  ]),
  { total: 3, page_one: 2, top_three: 1 },
);

eq("pendingMonths: newest first, merged, no duplicates",
  pendingMonths(["2025-07-01", "2025-08-01"], ["2026-09-01", "2025-08-01"], "2026-09-28"),
  ["2026-09-01", "2025-08-01", "2025-07-01"]);
eq("pendingMonths: nothing after the data", pendingMonths([], ["2026-09-01", "2026-10-01"], "2026-09-28"), ["2026-09-01"]);
eq("pendingMonths: no data, no queue", pendingMonths(["2026-01-01"], [], null), []);

eq("classify: 403 is no access", classifyStatus(403), "no_access");
eq("classify: 429 retries", classifyStatus(429), "retry");
eq("classify: 401 retries (after the token refresh)", classifyStatus(401), "retry");
eq("classify: 400 is fatal", classifyStatus(400), "fatal");

// -----------------------------------------------------------------------------
// Periods
// -----------------------------------------------------------------------------
eq("headline: mid-month is the month so far", headlinePeriod("2026-09-28"),
  { month: "2026-09-01", start: "2026-09-01", end: "2026-09-28", complete: false, label: "September 2026", range: "Sep 1–28" });
eq("headline: the first days lead with last month, complete", headlinePeriod("2026-10-03"),
  { month: "2026-09-01", start: "2026-09-01", end: "2026-09-30", complete: true, label: "September 2026", range: "September 2026" });
eq("headline: a month-end date is a complete month", headlinePeriod("2026-02-28").complete, true);
eq("periodForMonth: nothing held for it", periodForMonth("2026-11-01", "2026-10-15"), null);

const partial = headlinePeriod("2026-09-28");
eq("compare: yoy matches the same days", comparisonRange(partial, "yoy"), { start: "2025-09-01", end: "2025-09-28" });
eq("compare: mom matches the same days", comparisonRange(partial, "mom"), { start: "2026-08-01", end: "2026-08-28" });
eq("compare: a 30-day partial against February is cut at Feb 28",
  comparisonRange(periodForMonth("2026-03-01", "2026-03-30")!, "mom"), { start: "2026-02-01", end: "2026-02-28" });
eq("compare: a complete month against the whole other month",
  comparisonRange(periodForMonth("2026-09-01", "2026-10-02")!, "mom"), { start: "2026-08-01", end: "2026-08-31" });
eq("rangeLabel: one day", rangeLabel("2026-09-05", "2026-09-05"), "Sep 5");

// -----------------------------------------------------------------------------
// A fabricated 16 months of data (Jul 2025 to Sep 28 2026)
// -----------------------------------------------------------------------------
function makeDays(from: string, to: string, f: (iso: string) => [number, number]): DayTotal[] {
  const out: DayTotal[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const [c, i] = f(iso);
    out.push({ date: iso, clicks: c, impressions: i, position: 7 });
  }
  return out;
}
// 2025: 100 clicks / 2,000 impressions a day; 2026: 150 / 4,000.
const days = makeDays("2025-07-01", "2026-09-28", (iso) => (iso < "2026-01-01" ? [100, 2000] : [150, 4000]));

const s28 = sumRange(days, "2026-09-01", "2026-09-28");
eq("sumRange: totals", [s28.clicks, s28.impressions, s28.days, s28.expected], [4200, 112000, 28, 28]);
ok("sumRange: ctr from sums", Math.abs((s28.ctr ?? 0) - 0.0375) < 1e-9, s28.ctr);

const months = monthlyTotals(days);
eq("monthlyTotals: 15 months", months.length, 15);
eq("monthlyTotals: September 2026 is partial", months[months.length - 1].complete, false);
eq("monthlyTotals: August 2026 is complete", months[months.length - 2].complete, true);

const kw: KeywordCountRow[] = [
  { month: "2025-08-01", total: 7230, page_one: 3394, top_three: 1051, is_complete: true },
  { month: "2026-07-01", total: 11000, page_one: 8000, top_three: 2905, is_complete: true },
  { month: "2026-08-01", total: 11800, page_one: 8583, top_three: 3138, is_complete: true },
  { month: "2026-09-01", total: 11309, page_one: 8274, top_three: 2649, is_complete: false },
];

const sum = searchSummary({ siteUrl: "sc-domain:x.com", days, keywordRows: kw, topPages: [], dataThrough: "2026-09-28", centsPerClick: 200 })!;
const tile = (k: string) => sum.tiles.find((t) => t.key === k)!;
eq("summary: leads with Sep 1–28", sum.period.range, "Sep 1–28");
eq("tile: clicks value", tile("clicks").value, "4,200");
eq("tile: clicks yoy +50%", tile("clicks").yoy?.change, 50);
eq("tile: clicks yoy compared against", tile("clicks").yoy?.against, "Sep 1–28, 2025");
eq("tile: clicks mom is level", tile("clicks").mom?.change, 0);
eq("tile: ctr delta is in points", [tile("ctr").yoy?.unit, tile("ctr").yoy?.change], ["pp", -1.3]);
eq("tile: keywords use the last complete month", [tile("keywords").value, tile("keywords").period], ["11,800", "August 2026 · complete month"]);
eq("tile: keywords yoy +63.2%", tile("keywords").yoy?.change, 63.2);
eq("tile: top-3 mom", tile("top_three").mom?.change, 8);
eq("tile: page-one yoy +152.9%", tile("page_one").yoy?.change, 152.9);
eq("tile: traffic value", tile("value_month").value, "$8,400");
eq("tile: sparkline is complete months only", tile("clicks").spark.length, 12);

// The rolling year: Sep 29 2025 to Sep 28 2026 = 94 days at 100 + 271 days at 150.
eq("value: rolling year", sum.value.year.clicks, 94 * 100 + 271 * 150);
eq("value: a full year has no 'since'", sum.value.year.since, null);
eq("value: 12 monthly bars, newest partial", [sum.value.months.length, sum.value.months[11].partial], [12, true]);

// A comparison period with a missing day gives no comparison at all.
const gappy = days.filter((x) => x.date !== "2025-09-14");
const gs = searchSummary({ siteUrl: "x", days: gappy, keywordRows: [], topPages: [], dataThrough: "2026-09-28", centsPerClick: 200 })!;
eq("tile: a gap in last year's days drops yoy", gs.tiles.find((t) => t.key === "clicks")!.yoy, null);
ok("tile: ... but mom still works", gs.tiles.find((t) => t.key === "clicks")!.mom !== null);
eq("tile: no keyword rows, no keyword tiles", gs.tiles.some((t) => t.kind === "keywords"), false);

// Only 3 months of data: no year-over-year, and the year value says so.
const short = days.filter((x) => x.date >= "2026-07-01");
const ss = searchSummary({ siteUrl: "x", days: short, keywordRows: [], topPages: [], dataThrough: "2026-09-28", centsPerClick: 200 })!;
eq("short history: no yoy", ss.tiles.find((t) => t.key === "clicks")!.yoy, null);
eq("short history: the year value starts at the data", ss.value.year.since, "2026-07-01");

// -----------------------------------------------------------------------------
// The headline sentence
// -----------------------------------------------------------------------------
const hero = heroSentence(sum, "yoy");
eq("hero: yoy headline", hero.headline, "September 2026 so far: clicks up 50.0% on last year");
ok("hero: summary has the matched comparison", hero.summary.includes("The same days last year (Sep 1–28, 2025): 2,800 clicks."), hero.summary);
ok("hero: summary has the keyword month", hero.summary.includes("11,800 searches showed your site in August 2026 (+63.2% on last year)."), hero.summary);
eq("hero: mom headline is level", heroSentence(sum, "mom").headline, "September 2026 so far: clicks level with last month");
eq("hero: falls back to mom when yoy is missing", heroSentence(ss, "yoy").headline, "September 2026 so far: clicks level with last month");
const lone = searchSummary({ siteUrl: "x", days: days.filter((x) => x.date >= "2026-09-01"), keywordRows: [], topPages: [], dataThrough: "2026-09-28", centsPerClick: 200 })!;
eq("hero: no comparison at all", heroSentence(lone, "yoy").headline, "September 2026 so far: 4,200 clicks from Google search");
const complete = searchSummary({ siteUrl: "x", days, keywordRows: kw, topPages: [], dataThrough: "2026-09-28", month: "2026-08-01", centsPerClick: 200 })!;
ok("hero: a complete month says no 'so far'", heroSentence(complete, "yoy").headline.startsWith("August 2026: clicks up"), heroSentence(complete, "yoy").headline);

// -----------------------------------------------------------------------------
// CTR upside and markers
// -----------------------------------------------------------------------------
const up = ctrUpside(335940, 14612, 0.08, 200);
eq("upside: their numbers", [up.targetClicks, up.extraClicks, up.cents / 100], [26875, 12263, 53750]);
eq("upside: a lower target never goes negative", ctrUpside(1000, 100, 0.05, 200).extraClicks, 0);

eq(
  "markers: inside the range, one per label, joined per month",
  markers(
    [
      { date: "2025-10-20", label: "LumiLink starts" },
      { date: "2026-03-30", label: "Site migration" },
      { date: "2026-03-02", label: "Google connected" },
      { date: "2026-04-10", label: "Site migration" },
      { date: "2024-01-01", label: "Too early" },
    ],
    ["2025-10-01", "2026-03-01", "2026-09-01"],
  ),
  [
    { month: "2025-10-01", label: "LumiLink starts" },
    { month: "2026-03-01", label: "Google connected · Site migration" },
  ],
);

// -----------------------------------------------------------------------------
// Brand vs non-brand
// -----------------------------------------------------------------------------

eq("siteBrandTerm: domain property", siteBrandTerm("sc-domain:packsclub.com"), "packsclub");
eq("siteBrandTerm: URL property with www", siteBrandTerm("https://www.packsclub.com/"), "packsclub");
eq("siteBrandTerm: two-part suffix", siteBrandTerm("https://shop.example.co.uk/"), "example");
eq("siteBrandTerm: hyphens dropped", siteBrandTerm("sc-domain:lumi-link.com"), "lumilink");
eq("siteBrandTerm: no domain", siteBrandTerm("localhost"), null);
eq(
  "brandTerms: site term plus staff terms, normalised and deduplicated",
  brandTerms("sc-domain:packsclub.com", ["PACKS", "packsclub", "Packs-Club", "x"]),
  ["packsclub", "packs", "packs club"],
);

const BRAND = ["packsclub", "packs"];
ok("isBrandQuery: exact name", isBrandQuery("packs", BRAND));
ok("isBrandQuery: name plus place", isBrandQuery("packs santa ana", BRAND));
ok("isBrandQuery: squashed term matches spaced query", isBrandQuery("packs club dispensary", BRAND));
ok("isBrandQuery: spaced term matches squashed query", isBrandQuery("packsclub", ["packs club"]));
ok("isBrandQuery: punctuation ignored", isBrandQuery("PACKS-Club hours?", BRAND));
ok("isBrandQuery: not inside another word", !isBrandQuery("backpacks", BRAND));
ok("isBrandQuery: not a prefix of a longer word", !isBrandQuery("packsy weed", ["packs"]));
ok("isBrandQuery: generic search", !isBrandQuery("dispensary near me", BRAND));
ok("isBrandQuery: no terms", !isBrandQuery("packs", []));

{
  // From `months` above: Aug 2025 = 3,100 clicks, Sep 2025 = 3,000, Aug 2026 = 4,650; Sep 2026 is partial.
  const split = brandSplit({
    months,
    terms: BRAND,
    queries: [
      { month: "2025-08-01", query: "packs", clicks: 1100 },
      { month: "2025-08-01", query: "dispensary near me", clicks: 400 },
      // Jul 2026: no rows, so no rollup: left out.
      { month: "2026-08-01", query: "packs club", clicks: 1500 },
      { month: "2026-08-01", query: "packs santa ana", clicks: 150 },
      { month: "2026-08-01", query: "weed delivery", clicks: 900 },
      // Partial month: ignored even though it has rows.
      { month: "2026-09-01", query: "packs", clicks: 999 },
    ],
  });
  ok("brandSplit: returns a split", split !== null);
  if (split) {
    eq("brandSplit: latest is the last complete month with a rollup", split.latest, { month: "2026-08-01", total: 4650, brand: 1650, nonBrand: 3000 });
    eq("brandSplit: months without a rollup are left out", split.months.map((m) => m.month), ["2025-08-01", "2026-08-01"]);
    // Aug 2025 non-brand: 3,100 - 1,100 = 2,000.
    eq("brandSplit: matched-month yoy on non-brand", split.yoy, { change: 50, unit: "pct", before: "2,000", against: "August 2025" });
    eq("brandSplit: mom needs July, which has no rollup", split.mom, null);
    eq("brandSplit: share", split.share, 3000 / 4650);
    eq("brandSplit: year sums only months inside the last 12", split.year, { months: 1, total: 4650, nonBrand: 3000, first: "2026-08-01", last: "2026-08-01" });
    eq("brandHeadline: with the comparison", brandHeadline(split, "yoy"), "3,000 clicks in August 2026 came from searches that didn't use your name, up 50.0% on August 2025");
    eq("brandHeadline: no comparison, no clause", brandHeadline(split, "mom"), "3,000 clicks in August 2026 came from searches that didn't use your name");
    ok("brandLead: states the share", brandLead(split).endsWith("That's 65% of all clicks from Google search that month."), brandLead(split));
    ok("brandSource: lists the terms", brandSource(split).startsWith('Brand searches are any containing "packsclub" or "packs".'), brandSource(split));
  }
  eq(
    "brandSplit: brand capped at the true total",
    brandSplit({ months, terms: BRAND, queries: [{ month: "2026-08-01", query: "packs", clicks: 999999 }] })?.latest.nonBrand,
    0,
  );
  eq("brandSplit: nothing to split", brandSplit({ months, terms: BRAND, queries: [] }), null);
}

// -----------------------------------------------------------------------------
// Store pages
// -----------------------------------------------------------------------------

ok("underPage: the page itself", underPage("packsclub.com/menu/orange-county", "packsclub.com/menu/orange-county"));
ok("underPage: a page under it", underPage("packsclub.com/menu/orange-county/categories/flower", "packsclub.com/menu/orange-county"));
ok("underPage: a query string", underPage("packsclub.com/menu/orange-county?tab=deals", "packsclub.com/menu/orange-county"));
ok("underPage: not a sibling sharing a prefix", !underPage("packsclub.com/menu/orange-county-2", "packsclub.com/menu/orange-county"));

{
  const st = storeTraffic({
    stores: [
      { id: "oc", name: "PACKS OC", store_page_url: "https://www.packsclub.com/menu/orange-county/" },
      { id: "sgv", name: "PACKS SGV", store_page_url: "packsclub.com/menu/san-gabriel-valley" },
    ],
    months: ["2025-08-01", "2026-07-01", "2026-08-01"],
    pages: [
      { month: "2025-08-01", page: "packsclub.com/menu/orange-county", clicks: 100 },
      { month: "2026-07-01", page: "packsclub.com/menu/orange-county", clicks: 120 },
      { month: "2026-08-01", page: "packsclub.com/menu/orange-county", clicks: 130 },
      { month: "2026-08-01", page: "packsclub.com/menu/orange-county/categories/flower", clicks: 20 },
      { month: "2026-08-01", page: "packsclub.com/menu/san-gabriel-valley", clicks: 300 },
      { month: "2026-08-01", page: "packsclub.com/blogs/news/x", clicks: 999 },
      // A month outside `months` (no rollup known) is ignored.
      { month: "2026-06-01", page: "packsclub.com/menu/orange-county", clicks: 5000 },
    ],
  });
  ok("storeTraffic: returns rows", st !== null && st.rows.length === 2);
  if (st) {
    eq("storeTraffic: latest month", st.month, "2026-08-01");
    eq("storeTraffic: sorted by latest clicks", st.rows.map((r) => r.id), ["sgv", "oc"]);
    const oc = st.rows.find((r) => r.id === "oc")!;
    eq("storeTraffic: store page normalised", oc.page, "packsclub.com/menu/orange-county");
    eq("storeTraffic: subpages counted", oc.latest, 150);
    eq("storeTraffic: yoy", oc.yoy, { change: 50, unit: "pct", before: "100", against: "August 2025" });
    eq("storeTraffic: mom", oc.mom, { change: 25, unit: "pct", before: "120", against: "July 2026" });
    eq("storeTraffic: series over months", oc.series, [100, 120, 150]);
    eq("storeTraffic: year excludes the month 12 back", oc.year, 270);
    eq("storeHeadline: sums every store", storeHeadline(st), "450 clicks from Google search landed on store pages in August 2026");
    eq("storeTraffic: zero before gives no yoy", st.rows.find((r) => r.id === "sgv")!.yoy, null);
  }
  eq("storeTraffic: no stores", storeTraffic({ stores: [], pages: [], months: ["2026-08-01"] }), null);
  eq("storeTraffic: no months", storeTraffic({ stores: [{ id: "a", name: "A", store_page_url: "x.com/a" }], pages: [], months: [] }), null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
