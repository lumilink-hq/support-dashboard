// =============================================================================
// test-seo-rank-tracking.ts — unit tests for the seo-rank-tracking pure
// helpers (module 7).
//
//   npx tsx scripts/test-seo-rank-tracking.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  buildGeoGrid,
  findOwnRanking,
  formatLocationCoordinate,
  matchCompetitors,
  normalizeDomain,
  type SerpItem,
} from "../supabase/functions/seo-rank-tracking/lib.ts";

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

// ---------------------------------------------------------------------------
console.log("\nnormalizeDomain");
// ---------------------------------------------------------------------------
{
  ok("strips protocol and www", normalizeDomain("https://www.acme.com/") === "acme.com");
  ok("bare domain unaffected", normalizeDomain("acme.com") === "acme.com");
  ok("strips path", normalizeDomain("https://acme.com/services/hvac") === "acme.com");
  ok("null in, null out", normalizeDomain(null) === null);
  ok("garbage in, null out (not a crash)", normalizeDomain("not a url at all!!") === null);
}

// ---------------------------------------------------------------------------
console.log("\nfindOwnRanking — organic (domain match)");
// ---------------------------------------------------------------------------
{
  const items: SerpItem[] = [
    { type: "organic", rank_group: 1, domain: "competitor.com" },
    { type: "organic", rank_group: 2, domain: "www.acme.com" },
    { type: "organic", rank_group: 3, domain: "another.com" },
  ];
  const match = findOwnRanking(items, "organic", { domain: "acme.com", phone: null, businessName: null });
  ok("finds the matching domain regardless of www", match?.position === 2 && match?.matched_on === "domain", match);

  const noMatch = findOwnRanking(items, "organic", { domain: "notpresent.com", phone: null, businessName: null });
  ok("no match returns null", noMatch === null);

  const localPackIgnoredForOrganicQuery = findOwnRanking(
    [{ type: "local_pack", rank_group: 1, domain: "acme.com" }],
    "organic",
    { domain: "acme.com", phone: null, businessName: null },
  );
  ok("a local_pack item is not matched when asking for organic", localPackIgnoredForOrganicQuery === null);
}

// ---------------------------------------------------------------------------
console.log("\nfindOwnRanking — local_pack (phone fallback)");
// ---------------------------------------------------------------------------
{
  const items: SerpItem[] = [
    { type: "local_pack", rank_group: 1, title: "Competitor HVAC", phone: "(213) 555-0199" },
    { type: "local_pack", rank_group: 2, title: "Acme Heating", phone: "(213) 555-0100" },
  ];
  const match = findOwnRanking(items, "local_pack", { domain: null, phone: "+12135550100", businessName: null });
  ok("matches on phone when no domain is available", match?.position === 2 && match?.matched_on === "phone", match);
}

// ---------------------------------------------------------------------------
console.log("\nfindOwnRanking — title fallback + precedence");
// ---------------------------------------------------------------------------
{
  const titleOnly = findOwnRanking(
    [{ type: "local_pack", rank_group: 4, title: "Acme Heating & Air" }],
    "local_pack",
    { domain: null, phone: null, businessName: "Acme Heating & Air" },
  );
  ok("falls back to exact title match when nothing else is available", titleOnly?.matched_on === "title", titleOnly);

  // Domain match must win even when title would also match something else first.
  const domainWins = findOwnRanking(
    [
      { type: "organic", rank_group: 1, domain: "somethingelse.com", title: "Acme Heating" },
      { type: "organic", rank_group: 5, domain: "acme.com", title: "Different title entirely" },
    ],
    "organic",
    { domain: "acme.com", phone: null, businessName: "Acme Heating" },
  );
  ok("domain match takes precedence over an earlier title-only coincidence", domainWins?.position === 5 && domainWins?.matched_on === "domain", domainWins);

  ok("returns the FIRST (best) match, not the last", findOwnRanking(
    [
      { type: "organic", rank_group: 2, domain: "acme.com" },
      { type: "organic", rank_group: 8, domain: "acme.com" },
    ],
    "organic",
    { domain: "acme.com", phone: null, businessName: null },
  )?.position === 2);
}

// ---------------------------------------------------------------------------
console.log("\nbuildGeoGrid");
// ---------------------------------------------------------------------------
{
  const grid = buildGeoGrid(30.2672, -97.7431, 2); // Austin, TX, 2km spacing
  ok("produces exactly 25 points (5x5)", grid.length === 25, grid.length);
  ok("row/col range is 1..5", grid.every((p) => p.row >= 1 && p.row <= 5 && p.col >= 1 && p.col <= 5));

  const center = grid.find((p) => p.row === 3 && p.col === 3)!;
  ok("the center cell (3,3) is very close to the input center", Math.abs(center.lat - 30.2672) < 0.0001 && Math.abs(center.lng - (-97.7431)) < 0.0001, center);

  const corner = grid.find((p) => p.row === 1 && p.col === 1)!;
  ok("corner cells are offset from center in both lat and lng", corner.lat !== center.lat && corner.lng !== center.lng);

  // All 25 (row,col) pairs must be unique.
  const keys = new Set(grid.map((p) => `${p.row},${p.col}`));
  ok("no duplicate grid cells", keys.size === 25);
}

// ---------------------------------------------------------------------------
console.log("\nformatLocationCoordinate");
// ---------------------------------------------------------------------------
{
  ok("formats as lat,lng,radius", formatLocationCoordinate(30.2672, -97.7431, 5) === "30.2672,-97.7431,5");
  ok("defaults radius to 5km", formatLocationCoordinate(1, 2) === "1,2,5");
}

// ---------------------------------------------------------------------------
console.log("\nmatchCompetitors (module 18)");
// ---------------------------------------------------------------------------
{
  const items: SerpItem[] = [
    { type: "organic", rank_group: 1, domain: "rival-a.com" },
    { type: "organic", rank_group: 2, domain: "www.rival-b.com" },
    { type: "organic", rank_group: 6, domain: "rival-b.com" },
    { type: "local_pack", rank_group: 1, domain: "rival-b.com" },
  ];
  const comps = [
    { id: "a", domain: "https://rival-a.com/" },
    { id: "b", domain: "rival-b.com" },
    { id: "c", domain: "absent.com" },
  ];
  const rows = matchCompetitors(items, comps);
  const get = (id: string, t: string) => rows.find((r) => r.competitor_id === id && r.rank_type === t);

  ok("matches organic regardless of protocol/www", get("a", "organic")?.position === 1 && get("b", "organic")?.position === 2, rows);
  ok("takes the best organic position when a domain appears twice", get("b", "organic")?.position === 2);
  ok("records local_pack when a pack is present", get("b", "local_pack")?.position === 1);
  ok("competitor not in the pack gets a null local_pack row", get("a", "local_pack")?.position === null);
  ok("competitor not in the SERP gets a null organic row", get("c", "organic")?.position === null);
  ok("3 competitors x 2 rank types = 6 rows", rows.length === 6, rows.length);

  const noPack = matchCompetitors(items.filter((i) => i.type !== "local_pack"), comps);
  ok("no local_pack rows when the SERP has no local pack", noPack.length === 3 && noPack.every((r) => r.rank_type === "organic"), noPack);

  ok("unparseable competitor domain is skipped, not recorded as not-found",
    matchCompetitors(items, [{ id: "x", domain: "not a url!!" }]).length === 0);
  ok("no competitors, no rows", matchCompetitors(items, []).length === 0);
  ok("does not match on title or phone",
    matchCompetitors([{ type: "local_pack", rank_group: 1, title: "rival-a.com", phone: "2135550100" }], [{ id: "a", domain: "rival-a.com" }])
      .every((r) => r.position === null));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
