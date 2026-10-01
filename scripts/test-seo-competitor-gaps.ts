// =============================================================================
// test-seo-competitor-gaps.ts — unit tests for module 23: the seo-competitor-gaps
// pure helpers, and the competitor-gap scoring that feeds module 16's topic picker.
//
//   npx tsx scripts/test-seo-competitor-gaps.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  brandToken,
  filterGaps,
  gapRequest,
  type GapItem,
  isBranded,
  parseGapItems,
  targetDomain,
} from "../supabase/functions/seo-competitor-gaps/lib.ts";
import {
  candidateScore,
  competitorGapScore,
  type CompetitorGapRow,
  gapRowsFromCompetitors,
  type GapRow,
  pickCandidates,
} from "../supabase/functions/seo-content/lib.ts";

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

// A trimmed copy of the documented domain_intersection response item.
function item(keyword: string, rank: number | null, volume: number | null, extra: Record<string, unknown> = {}) {
  return {
    se_type: "google",
    keyword_data: {
      se_type: "google",
      keyword,
      location_code: 2840,
      language_code: "en",
      keyword_info: { search_volume: volume, cpc: 4.5, competition_level: "MEDIUM" },
      keyword_properties: { keyword_difficulty: 30 },
      search_intent_info: { main_intent: "commercial" },
      ...extra,
    },
    first_domain_serp_element: { type: "organic", rank_group: rank, rank_absolute: rank, url: "https://rival.com/x", etv: 12.3 },
    second_domain_serp_element: null,
  };
}

function g(keyword: string, pos: number, volume: number | null, intent: string | null = "commercial"): GapItem {
  return {
    keyword,
    search_volume: volume,
    cpc: null,
    competition_level: null,
    keyword_difficulty: null,
    main_intent: intent,
    monthly_searches: [],
    competitor_position: pos,
    competitor_url: null,
  };
}

console.log("\ntargetDomain");
{
  ok("strips protocol, www and path", targetDomain("https://www.Rival.com/services/") === "rival.com");
  ok("bare domain", targetDomain("rival.com") === "rival.com");
  ok("null / garbage / dotless → null", targetDomain(null) === null && targetDomain("not a url!!") === null && targetDomain("localhost") === null);
}

console.log("\nbrandToken / isBranded");
{
  ok("rotorooter.com → rotorooter", brandToken("rotorooter.com") === "rotorooter");
  ok("hyphen dropped", brandToken("www.mr-rooter.com".replace(/^www\./, "")) === "mrrooter", brandToken("mr-rooter.com"));
  ok("second-level suffix skipped", brandToken("acme.co.uk") === "acme");
  ok("subdomain uses the registrable label", brandToken("shop.acmeplumbing.com") === "acmeplumbing");
  ok("short brand (< 4) is not matched", brandToken("abc.com") === null);
  ok("no dot → null", brandToken("localhost") === null);
  ok("spaces in the search still match", isBranded("roto rooter coupons", "rotorooter"));
  ok("unrelated search doesn't", !isBranded("drain cleaning tulsa", "rotorooter"));
  ok("null token never matches", !isBranded("anything", null));
}

console.log("\ngapRequest");
{
  const r = gapRequest("rival.com", "acme.com");
  ok("competitor is target1, client target2", r.target1 === "rival.com" && r.target2 === "acme.com");
  ok("intersections false (ranks for, client doesn't)", r.intersections === false);
  ok("organic only", JSON.stringify(r.item_types) === '["organic"]');
  ok("two filters joined by and", JSON.stringify(r.filters) === '[["first_domain_serp_element.rank_group","<=",20],"and",["keyword_data.keyword_info.search_volume",">=",10]]', r.filters);
  ok("most searched first, 100 items", JSON.stringify(r.order_by) === '["keyword_data.keyword_info.search_volume,desc"]' && r.limit === 100);
  ok("US English", r.location_code === 2840 && r.language_code === "en");
}

console.log("\nparseGapItems");
{
  const items = parseGapItems([{ items: [item("Drain Cleaning Tulsa", 4, 880), item("no rank", null, 50), { keyword_data: null, first_domain_serp_element: { rank_group: 2 } }, null, item("too deep", 101, 10)] }]);
  ok("keeps a valid item, drops no-rank / no-keyword / null / out of range", items.length === 1, items.map((i) => i.keyword));
  const i = items[0];
  ok("keyword normalised", i.keyword === "drain cleaning tulsa");
  ok("metrics read from keyword_data", i.search_volume === 880 && i.keyword_difficulty === 30 && i.main_intent === "commercial" && i.cpc === 4.5);
  ok("position and URL from first_domain_serp_element", i.competitor_position === 4 && i.competitor_url === "https://rival.com/x");
  const absOnly = parseGapItems([{ items: [{ ...item("abs only", null, 50), first_domain_serp_element: { rank_absolute: 7 } }] }]);
  ok("falls back to rank_absolute", absOnly[0]?.competitor_position === 7, absOnly);
  ok("null / empty result → empty", parseGapItems(null).length === 0 && parseGapItems([{ items: null }]).length === 0);
}

console.log("\nfilterGaps");
{
  const out = filterGaps(
    [
      g("drain cleaning tulsa", 4, 880),
      g("water heater repair", 12, 2000),
      g("too deep", 21, 5000),
      g("low volume", 3, 9),
      g("null volume", 3, null),
      g("rival login", 1, 9000, "navigational"),
      g("roto rooter coupons", 2, 4000),
      g("acme plumbing reviews", 2, 4000),
      g("drain cleaning tulsa", 2, 880), // same phrase, better position
      g("x".repeat(81), 1, 999),
    ],
    ["rotorooter", "acmeplumbing"],
  );
  const kws = out.map((x) => x.keyword);
  ok("keeps real gaps, most searched first", kws.join(",") === "water heater repair,drain cleaning tulsa", kws);
  ok("duplicate keeps the best position", out.find((x) => x.keyword === "drain cleaning tulsa")?.competitor_position === 2);
  ok("20 is kept, 21 is not", filterGaps([g("a b", 20, 50), g("c d", 21, 50)], []).length === 1);
}

console.log("\ncompetitorGapScore (module 16)");
{
  const row = (over: Partial<CompetitorGapRow>): CompetitorGapRow => ({
    location_id: "L1",
    keyword: "drain cleaning tulsa",
    competitors_ranking: 1,
    best_competitor_position: 3,
    search_volume: 500,
    keyword_difficulty: 30,
    main_intent: "commercial",
    ...over,
  });
  ok("eligible gap scores 30-70", competitorGapScore(row({})) > 30 && competitorGapScore(row({})) <= 70, competitorGapScore(row({})));
  ok("max case is 70", competitorGapScore(row({ best_competitor_position: 1, competitors_ranking: 9, search_volume: 1_000_000 })) === 70);
  ok("competitor off page one → 0", competitorGapScore(row({ best_competitor_position: 11 })) === 0);
  ok("null position → 0", competitorGapScore(row({ best_competitor_position: null })) === 0);
  ok("under 20 searches → 0", competitorGapScore(row({ search_volume: 19 })) === 0);
  ok("difficulty over 50 → 0", competitorGapScore(row({ keyword_difficulty: 51 })) === 0);
  ok("difficulty 50 allowed, unknown allowed", competitorGapScore(row({ keyword_difficulty: 50 })) > 0 && competitorGapScore(row({ keyword_difficulty: null })) > 0);
  ok("navigational → 0", competitorGapScore(row({ main_intent: "navigational" })) === 0);
  ok("better competitor position scores higher", competitorGapScore(row({ best_competitor_position: 1 })) > competitorGapScore(row({ best_competitor_position: 8 })));
  ok("more competitors score higher", competitorGapScore(row({ competitors_ranking: 3 })) > competitorGapScore(row({ competitors_ranking: 1 })));

  const rows = gapRowsFromCompetitors([row({}), row({ keyword: "hard one", keyword_difficulty: 90 })]);
  ok("ineligible gaps are dropped", rows.length === 1);
  ok("marked as a competitor gap with its score", rows[0].source === "competitor_gap" && rows[0].score === competitorGapScore(row({})));

  const tracked: GapRow = {
    keyword_id: "k1",
    location_id: "L1",
    keyword: "plumber tulsa",
    own_position: 15,
    has_rank_data: true,
    best_competitor_position: 2,
    competitors_ranking: 2,
  };
  ok("a tracked keyword the client is losing on outranks the best gap", candidateScore(tracked) > 70, candidateScore(tracked));
  const picked = pickCandidates([...rows, tracked], new Set(), {}, 5);
  ok("pickCandidates takes both, tracked first", picked.map((p) => p.keyword).join(",") === "plumber tulsa,drain cleaning tulsa", picked.map((p) => p.keyword));
  ok("an active post's topic is skipped for a gap too", pickCandidates(rows, new Set(["drain cleaning tulsa"]), {}, 5).length === 0);
  const sameAsTracked = gapRowsFromCompetitors([row({ keyword: "Plumber  Tulsa", location_id: "L2" })]);
  ok("a gap with a tracked phrase is one candidate, not two", pickCandidates([...sameAsTracked, tracked], new Set(), {}, 5).filter((p) => p.keyword.toLowerCase().replace(/\s+/g, " ") === "plumber tulsa").length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
