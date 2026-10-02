// =============================================================================
// test-seo-link-opportunities.ts — unit tests for module 26's pure helpers
// (supabase/functions/seo-link-opportunities/lib.ts).
//
//   npx tsx scripts/test-seo-link-opportunities.ts
//
// No network, no Deno, no database.
// =============================================================================

import { ISSUE_LABELS } from "../lib/seo-portal";
import {
  brokenBody,
  brokenFinding,
  competitorList,
  gapBody,
  groupBroken,
  lostBody,
  mergeGaps,
  pairs,
  parseLost,
  targetDomain,
} from "../supabase/functions/seo-link-opportunities/lib.ts";

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

console.log("\ncompetitors and pairs");
{
  ok("targetDomain strips www and path", targetDomain("https://www.Rival.com/x") === "rival.com" && targetDomain(null) === null);
  const c = competitorList(["rival.com", "www.rival.com", "acme.com", null, "b.com", "c.com", "d.com", "e.com", "f.com"], "acme.com");
  ok("normalised, de-duplicated, not the site, capped at 5", JSON.stringify(c) === JSON.stringify(["rival.com", "b.com", "c.com", "d.com", "e.com"]), c);
  ok("5 competitors → 10 pairs", pairs(["a", "b", "c", "d", "e"]).length === 10);
  ok("2 → 1 pair, 1 → none", pairs(["a", "b"]).length === 1 && pairs(["a"]).length === 0);
}

console.log("\nrequest bodies");
{
  const g = gapBody("a.com", "b.com", "acme.com");
  ok("gap: two targets keyed 1 and 2, the site excluded, live links", JSON.stringify(g.targets) === '{"1":"a.com","2":"b.com"}' && JSON.stringify(g.exclude_targets) === '["acme.com"]' && g.backlinks_status_type === "live");
  const b = brokenBody("acme.com");
  ok("broken: live links filtered to is_broken, best sites first", b.backlinks_status_type === "live" && JSON.stringify(b.filters) === '["is_broken","=",true]' && JSON.stringify(b.order_by) === '["domain_from_rank,desc"]');
  const l = lostBody("acme.com");
  ok("lost: lost links, one per referring site", l.backlinks_status_type === "lost" && l.mode === "one_per_domain");
}

console.log("\nmergeGaps");
{
  const entry = (target: string, rank: number, backlinks: number, spam = 0) => ({ type: "backlinks_domain_intersection", target, rank, backlinks, backlinks_spam_score: spam });
  const res = (items: unknown[]) => [{ items }];
  const gaps = mergeGaps(
    [
      { pair: ["a.com", "b.com"], result: res([
        { domain_intersection: { "1": entry("news.example", 300, 4), "2": entry("news.example", 280, 2) }, summary: { intersections_count: 2 } },
        { domain_intersection: { "1": entry("www.spam.example", 50, 1, 80), "2": entry("www.spam.example", 50, 1, 70) } },
        { domain_intersection: { "1": entry("dir.example", 120, 1), "2": entry("dir.example", 100, 1) } },
      ]) },
      { pair: ["a.com", "c.com"], result: res([
        { domain_intersection: { "1": entry("news.example", 300, 4), "2": entry("news.example", 310, 3) } },
        { domain_intersection: { "1": entry("acme.com", 900, 9), "2": entry("acme.com", 900, 9) } }, // the site itself
      ]) },
    ],
    "acme.com",
  );
  const news = gaps.find((g) => g.referring_domain === "news.example");
  ok("a site found in two pairs links to all three competitors", JSON.stringify(news?.competitors) === '["a.com","b.com","c.com"]', news);
  ok("best rank kept", news?.domain_rank === 310);
  ok("spammy sites dropped, the site itself dropped", !gaps.some((g) => g.referring_domain === "spam.example" || g.referring_domain === "acme.com"));
  ok("most competitors first", gaps[0].referring_domain === "news.example" && gaps[1].referring_domain === "dir.example", gaps.map((g) => g.referring_domain));
  ok("empty / malformed results → nothing", mergeGaps([{ pair: ["a", "b"], result: null }, { pair: ["a", "b"], result: [{ items: [{}] }] }], "x.com").length === 0);
}

console.log("\ngroupBroken / brokenFinding");
{
  const item = (from: string, to: string, rank: number, status = 404) => ({ url_from: `https://${from}/p`, domain_from: from, url_to: to, url_to_status_code: status, is_broken: true, domain_from_rank: rank });
  const pages = groupBroken(
    [{ items: [
      item("a.org", "https://acme.com/old-offer", 200),
      item("b.org", "https://acme.com/old-offer", 400),
      item("c.org", "https://acme.com/old-offer", 100),
      item("a.org", "https://acme.com/old-offer", 200), // second link from the same site
      item("d.org", "https://acme.com/gone", 50, 410),
      item("acme.com", "https://acme.com/internal", 10), // its own site
      { ...item("e.org", "https://acme.com/fine", 10), is_broken: false },
    ] }],
    "acme.com",
  );
  ok("grouped by the client's page, most linking sites first", pages.length === 2 && pages[0].url_to === "https://acme.com/old-offer" && pages[0].linking_domains.length === 3 && pages[0].links === 4, pages);
  ok("status and best rank kept", pages[0].status === 404 && pages[0].best_rank === 400 && pages[1].status === 410);
  const f = brokenFinding(pages[0]);
  ok("3+ linking sites is a warning, the page is the target", f.severity === "warning" && f.target_url === "https://acme.com/old-offer" && f.finding_type === "backlinks_to_broken_page");
  ok("the title says what to do", /3 other sites link/.test(f.title) && /answers 404/.test(f.title) && /Redirect/.test(f.title), f.title);
  const one = brokenFinding(pages[1]);
  ok("one site: info, singular wording", one.severity === "info" && /1 other site links/.test(one.title) && /that link back/.test(one.title), one.title);
  ok("Site health has a label for it", !!ISSUE_LABELS.backlinks_to_broken_page);
}

console.log("\nparseLost");
{
  const today = new Date("2026-10-02T00:00:00Z");
  const it = (from: string, rank: number, lost: string | null, extra: Record<string, unknown> = {}) => ({
    url_from: `https://${from}/a`, domain_from: from, url_to: "https://acme.com/x", anchor: " Acme ", dofollow: true, domain_from_rank: rank, lost_date: lost, ...extra,
  });
  const lost = parseLost(
    [{ items: [
      it("old.org", 900, "2026-05-01 10:00:00 +00:00"), // over 90 days
      it("recent.org", 200, "2026-09-10 10:00:00 +00:00"),
      it("big.org", 700, "2026-08-20 10:00:00 +00:00"),
      it("big.org", 600, "2026-08-21 10:00:00 +00:00"), // same site twice
      it("nodate.org", 10, null, { last_seen: null }),
      it("seen.org", 50, null, { last_seen: "2026-09-30 00:00:00 +00:00" }),
      it("acme.com", 999, "2026-09-30 00:00:00 +00:00"),
    ] }],
    "acme.com",
    today,
  );
  ok("last 90 days only, one per site, not the site itself", JSON.stringify(lost.map((l) => l.referring_domain)) === JSON.stringify(["big.org", "recent.org", "seen.org", "nodate.org"]), lost.map((l) => l.referring_domain));
  ok("dates as yyyy-mm-dd, last_seen as a fallback", lost[0].lost_date === "2026-08-20" && lost[2].lost_date === "2026-09-30");
  ok("anchor trimmed, dofollow and rank kept", lost[0].anchor === "Acme" && lost[0].dofollow === true && lost[0].domain_rank === 700);
  ok("null result → empty", parseLost(null, "acme.com", today).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
