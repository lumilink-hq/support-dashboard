// =============================================================================
// test-seo-keyword-research.ts — unit tests for the seo-keyword-research pure
// helpers (module 22).
//
//   npx tsx scripts/test-seo-keyword-research.ts
//
// No network, no Deno, no database.
// =============================================================================

import { cleanKeyword, difficultyLabel, keywordStatsLine, splitSuggestions, type KeywordSuggestion } from "../lib/seo-portal";
import {
  chunk,
  isQueryable,
  latestCompleteMonth,
  metricsFor,
  normalizeKeyword,
  parseItem,
  parseItems,
  pickRelated,
  pickSeeds,
  pickStrikingDistance,
  type KeywordMetrics,
  type QueryRow,
} from "../supabase/functions/seo-keyword-research/lib.ts";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, got?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${got === undefined ? "" : `  (got: ${JSON.stringify(got)})`}`);
  }
}

// A trimmed copy of the documented keyword_overview response item.
const overviewItem = {
  se_type: "google",
  keyword: "Emergency Plumber Tulsa",
  location_code: 2840,
  language_code: "en",
  keyword_info: {
    search_volume: 880,
    cpc: 21.37,
    competition: 0.41,
    competition_level: "MEDIUM",
    monthly_searches: [
      { year: 2026, month: 7, search_volume: 720 },
      { year: 2026, month: 9, search_volume: 1000 },
      { year: 2026, month: 8, search_volume: 880 },
    ],
  },
  keyword_properties: { keyword_difficulty: 34 },
  search_intent_info: { main_intent: "transactional" },
};

function m(keyword: string, search_volume: number | null): KeywordMetrics {
  return { keyword, search_volume, cpc: null, competition_level: null, keyword_difficulty: null, main_intent: null, monthly_searches: [] };
}

console.log("\nnormalizeKeyword");
{
  ok("lower-cases and collapses spaces", normalizeKeyword("  Emergency   Plumber\tTulsa ") === "emergency plumber tulsa");
  ok("control characters become spaces", normalizeKeyword("roof\u0000repair") === "roof repair");
  for (const s of ["  Emergency   Plumber ", "HVAC\nrepair", "café\u007fnear me", "x", ""]) {
    ok(`agrees with the portal's cleanKeyword: ${JSON.stringify(s)}`, normalizeKeyword(s) === cleanKeyword(s), [normalizeKeyword(s), cleanKeyword(s)]);
  }
}

console.log("\nisQueryable");
{
  ok("normal phrase", isQueryable("emergency plumber tulsa"));
  ok("one character is not", !isQueryable("a"));
  ok("81 characters is not", !isQueryable("a".repeat(81)));
  ok("80 characters is", isQueryable("a".repeat(80)));
  ok("11 words is not", !isQueryable("one two three four five six seven eight nine ten eleven"));
  ok("10 words is", isQueryable("one two three four five six seven eight nine ten"));
}

console.log("\nparseItem");
{
  const p = parseItem(overviewItem)!;
  ok("keyword normalised", p.keyword === "emergency plumber tulsa", p.keyword);
  ok("volume", p.search_volume === 880);
  ok("cpc", p.cpc === 21.37);
  ok("competition level", p.competition_level === "MEDIUM");
  ok("difficulty", p.keyword_difficulty === 34);
  ok("intent", p.main_intent === "transactional");
  ok("monthly sorted newest first", p.monthly_searches.map((x) => x.month).join(",") === "9,8,7", p.monthly_searches);

  const bad = parseItem({
    keyword: "x y",
    keyword_info: { search_volume: "lots", competition_level: "EXTREME", monthly_searches: [{ year: 2026 }] },
    keyword_properties: { keyword_difficulty: 140 },
    search_intent_info: { main_intent: "curious" },
  })!;
  ok("non-number volume is null", bad.search_volume === null);
  ok("unknown competition level is null", bad.competition_level === null);
  ok("difficulty out of 0-100 is null", bad.keyword_difficulty === null);
  ok("unknown intent is null", bad.main_intent === null);
  ok("incomplete monthly rows dropped", bad.monthly_searches.length === 0);

  const bare = parseItem({ keyword: "bare" })!;
  ok("missing blocks give nulls, not a crash", bare.search_volume === null && bare.keyword_difficulty === null);
  ok("no keyword → null", parseItem({ keyword_info: {} }) === null);
  ok("non-object → null", parseItem("nope") === null);
  ok("upper-case intent accepted", parseItem({ keyword: "k k", search_intent_info: { main_intent: "Commercial" } })!.main_intent === "commercial");
  ok("fractional volume rounded", parseItem({ keyword: "k k", keyword_info: { search_volume: 12.6 } })!.search_volume === 13);
}

console.log("\nparseItems");
{
  const items = parseItems([{ items: [overviewItem, { keyword: "emergency plumber tulsa" }, { keyword: "drain cleaning" }, null] }]);
  ok("de-duplicates by normalised keyword (first wins)", items.length === 2 && items[0].search_volume === 880, items);
  ok("null result → empty", parseItems(null).length === 0);
  ok("result with items: null → empty", parseItems([{ items: null }]).length === 0);
  ok("empty array → empty", parseItems([]).length === 0);
}

console.log("\nmetricsFor");
{
  const rows = metricsFor(["a b", "c d"], [m("a b", 50)]);
  ok("one row per phrase asked", rows.length === 2);
  ok("found phrase keeps its data", rows[0].search_volume === 50);
  ok("missing phrase is null-filled (so 'no row' means 'never asked')", rows[1].keyword === "c d" && rows[1].search_volume === null);
  ok("phrases DataForSEO volunteered but we didn't ask are not written", metricsFor(["a b"], [m("a b", 1), m("z z", 9)]).length === 1);
}

console.log("\nchunk");
{
  const c = chunk(Array.from({ length: 1401 }, (_, i) => i), 700);
  ok("1401 into 700s is 3 calls", c.length === 3 && c[2].length === 1);
  ok("empty in, no calls", chunk([], 700).length === 0);
}

console.log("\npickSeeds");
{
  const s = pickSeeds(["emergency plumber tulsa ok", "plumber tulsa", "drain cleaning tulsa", "plumber tulsa", "a"]);
  ok("de-duplicated, unqueryable dropped", s.length === 3, s);
  ok("shortest first", s[0] === "plumber tulsa", s);
  ok("capped", pickSeeds(Array.from({ length: 50 }, (_, i) => `kw ${i}`), 20).length === 20);
}

console.log("\nlatestCompleteMonth");
{
  ok(
    "skips a newer incomplete month",
    latestCompleteMonth([
      { month: "2026-08-01", is_complete: true },
      { month: "2026-09-01", is_complete: false },
      { month: "2026-07-01", is_complete: true },
    ]) === "2026-08-01",
  );
  ok("none complete → null", latestCompleteMonth([{ month: "2026-09-01", is_complete: false }]) === null);
  ok("empty → null", latestCompleteMonth([]) === null);
}

console.log("\npickStrikingDistance");
{
  const row = (query: string, position: number | string | null, impressions: number, site = "sc-domain:a.com"): QueryRow => ({
    site_url: site,
    month: "2026-08-01",
    query,
    clicks: 3,
    impressions,
    position,
  });
  const picks = pickStrikingDistance(
    [
      row("Plumber Near Me", 12.34, 400),
      row("plumber tulsa", 9, 900), // tracked
      row("water heater repair", 3.2, 800), // already top 3
      row("sewer line", 25, 800), // too deep
      row("drain cleaning", 8, 19), // too few impressions
      row("boundary low", 8, 20),
      row("boundary high", "20", 20), // numeric string from Postgres
      row("no position", null, 500),
      row("dismissed one", 10, 500),
      row("plumber near me", 11, 600, "https://www.a.com/"), // same phrase, second property, more impressions
    ],
    new Set(["plumber tulsa", "dismissed one"]),
  );
  const kws = picks.map((p) => p.keyword);
  ok("keeps 8 and 20 inclusive", kws.includes("boundary low") && kws.includes("boundary high"), kws);
  ok("drops top-3, too deep, too few impressions, null position", !kws.includes("water heater repair") && !kws.includes("sewer line") && !kws.includes("drain cleaning") && !kws.includes("no position"), kws);
  ok("drops tracked and dismissed", !kws.includes("plumber tulsa") && !kws.includes("dismissed one"), kws);
  const pnm = picks.find((p) => p.keyword === "plumber near me");
  ok("merges a phrase across properties, keeping the bigger one", picks.filter((p) => p.keyword === "plumber near me").length === 1 && pnm?.gsc_impressions === 600 && pnm.site_url === "https://www.a.com/", pnm);
  ok("most impressions first", kws[0] === "plumber near me", kws);
  ok("position rounded to one decimal", pickStrikingDistance([row("x y", 12.345, 100)], new Set())[0].gsc_position === 12.3);
  ok("capped", pickStrikingDistance(Array.from({ length: 40 }, (_, i) => row(`q ${i}`, 10, 100 + i)), new Set(), 25).length === 25);
}

console.log("\npickRelated");
{
  const r = pickRelated([m("a a", 50), m("b b", 5), m("c c", null), m("tracked one", 900), m("d d", 700), m("x".repeat(90), 999)], new Set(["tracked one"]));
  ok("drops tracked, under-10 volume, null volume, unqueryable", r.map((x) => x.keyword).join(",") === "d d,a a", r.map((x) => x.keyword));
  ok("capped", pickRelated(Array.from({ length: 60 }, (_, i) => m(`k ${i}`, 100)), new Set(), 25).length === 25);
}

console.log("\nportal: difficultyLabel / keywordStatsLine");
{
  ok("29 easy, 30 medium, 59 medium, 60 hard", [29, 30, 59, 60].map(difficultyLabel).join(",") === "Easy,Medium,Medium,Hard");
  ok("null difficulty, null label", difficultyLabel(null) === null);
  const full = keywordStatsLine({ keyword: "k", search_volume: 1880, cpc: "21.5", keyword_difficulty: 34 });
  ok("full line", full === "1,880 searches a month · difficulty 34 (medium) · $21.50 a click", full);
  ok("zero CPC left out", keywordStatsLine({ keyword: "k", search_volume: 10, cpc: 0, keyword_difficulty: null }) === "10 searches a month");
  ok("nothing known → null", keywordStatsLine({ keyword: "k", search_volume: null, cpc: null, keyword_difficulty: null }) === null);
  ok("no row → null", keywordStatsLine(undefined) === null);
}

console.log("\nportal: splitSuggestions");
{
  const sug = (id: string, keyword: string, source: "search_console" | "related", volume: number | null, impressions: number | null): KeywordSuggestion => ({
    id,
    keyword,
    source,
    search_volume: volume,
    cpc: null,
    keyword_difficulty: null,
    gsc_impressions: impressions,
    gsc_clicks: null,
    gsc_position: null,
    gsc_month: null,
  });
  const out = splitSuggestions(
    [
      sug("1", "a a", "related", 10, null),
      sug("2", "b b", "related", 500, null),
      sug("3", "c c", "search_console", 90, 40),
      sug("4", "d d", "search_console", 5, 400),
      sug("5", "here", "related", 9999, null),
    ],
    new Set(["here"]),
  );
  ok("hides what this location already tracks", !out.related.some((r) => r.keyword === "here"));
  ok("related by volume", out.related.map((r) => r.id).join(",") === "2,1");
  ok("search console by impressions", out.searchConsole.map((r) => r.id).join(",") === "4,3");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
