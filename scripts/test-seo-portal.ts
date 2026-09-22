// =============================================================================
// test-seo-portal.ts — unit tests for lib/seo-portal.ts (module 10).
//
//   npx tsx scripts/test-seo-portal.ts
// =============================================================================

import { aiSummary, cleanDomain, cleanQuery, compareToCompetitors, daysAgo, latestPerKeyword, trendPoints } from "../lib/seo-portal.ts";

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

console.log("\nlatestPerKeyword");
{
  const rows = [
    { keyword_id: "k1", check_date: "2026-08-01", position: 9 },
    { keyword_id: "k1", check_date: "2026-08-08", position: 5 },
    { keyword_id: "k2", check_date: "2026-08-01", position: null },
  ];
  const l = latestPerKeyword(rows);
  ok("keeps the newest per keyword", l.length === 2 && l.find((r) => r.keyword_id === "k1")?.position === 5, l);
}

console.log("\ncompareToCompetitors");
{
  const clientRows = [
    { keyword_id: "k1", position: 3, check_date: "2026-09-14" },
    { keyword_id: "k1", position: 8, check_date: "2026-09-07" },
    { keyword_id: "k2", position: null, check_date: "2026-09-14" },
  ];
  const comps = [
    { id: "c1", domain: "rival.com", label: null },
    { id: "c2", domain: "other.com", label: "Other Co" },
  ];
  const compRows = [
    { competitor_id: "c1", keyword_id: "k1", position: 1, check_date: "2026-09-14" },
    { competitor_id: "c1", keyword_id: "k2", position: 12, check_date: "2026-09-14" },
    { competitor_id: "c1", keyword_id: "k3", position: 1, check_date: "2026-09-14" }, // client not checked on k3: excluded
    { competitor_id: "c2", keyword_id: "k1", position: null, check_date: "2026-09-14" },
  ];
  const r = compareToCompetitors("Acme", clientRows, comps, compRows);
  ok("client first, then each competitor", r.length === 3 && r[0].isClient && r[1].label === "rival.com" && r[2].label === "Other Co", r.map((x) => x.label));
  ok("client uses the latest check per keyword", r[0].checked === 2 && r[0].ranked === 1 && r[0].top10 === 1 && r[0].avgPosition === 3, r[0]);
  ok("competitors are compared only on the client's keywords", r[1].checked === 2 && r[1].top10 === 1 && r[1].avgPosition === 6.5, r[1]);
  ok("not found counts as checked, not ranked", r[2].checked === 1 && r[2].ranked === 0 && r[2].avgPosition === null, r[2]);
}

console.log("\ntrendPoints and aiSummary");
{
  const pts = trendPoints(
    [
      { rank_type: "organic", check_date: "2026-09-07", avg_position: 6 },
      { rank_type: "organic", check_date: "2026-08-31", avg_position: 8.5 },
      { rank_type: "local_pack", check_date: "2026-09-07", avg_position: null },
    ],
    "organic",
  );
  ok("filters by type and sorts by date", pts.length === 2 && pts[0].x === "2026-08-31" && pts[1].y === 6, pts);
  const s = aiSummary([
    { query_id: "q", platform: "google", cited_count: 2, check_date: "2026-09-01" },
    { query_id: "q", platform: "chat_gpt", cited_count: 0, check_date: "2026-09-01" },
    { query_id: "q2", platform: "google", cited_count: 0, check_date: "2026-09-01" },
  ]);
  ok("overall cited/checks", s.checks === 3 && s.cited === 1, s);
  const g = s.platforms.find((p) => p.platform === "google");
  ok("per platform with readable labels", g?.label === "Google AI Overviews" && g?.checks === 2, s.platforms);
  ok("no mentions is zero checks (not a claim of invisibility)", aiSummary([]).checks === 0);
}

console.log("\ncleanQuery and daysAgo");
{
  ok("collapses whitespace and control characters", cleanQuery("  best \n plumber\t near" + String.fromCharCode(0) + "me  ") === "best plumber near me");
  ok("daysAgo", daysAgo(30, new Date("2026-09-21T12:00:00Z")) === "2026-08-22");
}

console.log("\ncleanDomain");
{
  ok("strips scheme, www, path and case", cleanDomain("https://www.Rival.com/about?x=1") === "rival.com");
  ok("bare domain", cleanDomain("rival.co.uk") === "rival.co.uk");
  ok("keeps a real subdomain", cleanDomain("shop.rival.com") === "shop.rival.com");
  ok("rejects a dotless host", cleanDomain("localhost") === null);
  ok("rejects an IP address", cleanDomain("http://10.0.0.1/x") === null);
  ok("rejects junk and empty", cleanDomain("not a domain!!") === null && cleanDomain("   ") === null);
  ok("rejects a scheme that is not a site", cleanDomain("javascript:alert(1)") === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
