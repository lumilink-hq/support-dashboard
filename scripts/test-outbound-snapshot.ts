// =============================================================================
// test-outbound-snapshot.ts — unit tests for the pre-call snapshot helpers
// (docs/OUTBOUND-PLAN.md, Phase 4).
//
//   npx tsx scripts/test-outbound-snapshot.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  buildTodo,
  compareListing,
  competitorsFrom,
  coordinatesOf,
  extraSiteFindings,
  keywordFor,
  primaryCategoryId,
  summaryLines,
} from "../supabase/functions/outbound-snapshot/lib.ts";

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

console.log("keyword and listing fields");
ok("category + city, lower-cased", keywordFor("Cannabis store", " Detroit ") === "cannabis store detroit", keywordFor("Cannabis store", " Detroit "));
ok("no city, no keyword", keywordFor("Cannabis store", null) === null);
ok("coordinates read from raw", JSON.stringify(coordinatesOf({ latitude: 42.33, longitude: -83.04 })) === '{"lat":42.33,"lng":-83.04}');
ok("bad coordinates rejected", coordinatesOf({ latitude: 142, longitude: 0 }) === null && coordinatesOf(null) === null);
ok("primary category id", primaryCategoryId({ category_ids: ["cannabis_store", "store"] }) === "cannabis_store");
ok("no category ids", primaryCategoryId({}) === null);

console.log("competitorsFrom");
const listing = (title: string, cid: string, reviews: number, rating: number, url: string | null = null, status = "open") => ({
  title, cid, url, rating: { rating_type: "Max5", value: rating, votes_count: reviews }, work_time: { work_hours: { current_status: status } },
});
{
  const items = [
    listing("Green Leaf", "own-cid", 40, 4.5, "https://greenleaf.com"),
    listing("Big Bud Co", "c1", 900, 4.7),
    listing("Leafy Corner", "c2", 120, 4.4),
    listing("Green Leaf East", "c3", 300, 4.1, "https://www.greenleaf.com/east"),
    listing("Old Shop", "c4", 2000, 4.9, null, "closed_forever"),
    listing("Smoke Spot", "c5", 15, 3.9),
    listing("Haze House", "c6", 260, 4.6),
    listing("Kush Korner", "c7", 75, 4.2),
  ];
  const comps = competitorsFrom(items, { cid: "own-cid", domain: "greenleaf.com", name: "Green Leaf" });
  ok("the prospect is excluded by cid", !comps.some((c) => c.cid === "own-cid"));
  ok("the prospect's other location is excluded by domain", !comps.some((c) => c.cid === "c3"), comps.map((c) => c.name));
  ok("permanently closed listings are excluded", !comps.some((c) => c.cid === "c4"));
  ok("most-reviewed first, top 5", JSON.stringify(comps.map((c) => c.cid)) === '["c1","c6","c2","c7","c5"]', comps.map((c) => c.cid));

  const cmp = compareListing({ rating: 4.5, reviews: 40 }, comps);
  ok("median of competitor reviews", cmp.median_reviews === 120, cmp);
  ok("average competitor rating to one place", cmp.average_rating === 4.4, cmp);
  ok("reviews rank counts competitors with more", cmp.reviews_rank === 5, cmp);
  ok("competitor count", cmp.competitors === 5, cmp);

  const todo = buildTodo({
    businessName: "Green Leaf",
    rank: { keyword: "cannabis store detroit", local_pack: null, organic: 14, local_pack_names: ["Big Bud Co", "Haze House", "Leafy Corner"] },
    listing: cmp,
    competitors: comps,
    site: [
      { finding_type: "missing_meta_description", severity: "warning", title: "x", details: {} },
      { finding_type: "missing_local_business_schema", severity: "warning", title: "x", details: {} },
      { finding_type: "title_length", severity: "info", title: "x", details: { length: 92 } },
      { finding_type: "something_new", severity: "info", title: "A new finding we have no wording for", details: {} },
    ],
  });
  const texts = todo.map((t) => t.text);
  ok("missing from the map pack is first, naming the leaders", todo[0].area === "maps" && todo[0].severity === "critical" &&
    texts[0].includes("Big Bud Co, Haze House, Leafy Corner"), todo[0]);
  ok("a big reviews gap is critical and names the top competitor", todo.some((t) => t.area === "reviews" && t.severity === "critical" &&
    t.text.includes("40") && t.text.includes("median of 120") && t.text.includes("Big Bud Co has 900")), texts);
  ok("page 2 organic is noted", texts.some((t) => t.includes("page 2") && t.includes("#14")), texts);
  ok("website findings become plain language", texts.some((t) => t.includes("no description for Google")), texts);
  ok("finding details fill the sentence", texts.some((t) => t.includes("92 characters")), texts);
  ok("an unknown finding falls back to its title", texts.includes("A new finding we have no wording for"), texts);
  ok("criticals before warnings before info", todo.every((t, i) => i === 0 ||
    ["critical", "warning", "info"].indexOf(todo[i - 1].severity) <= ["critical", "warning", "info"].indexOf(t.severity)), todo.map((t) => t.severity));
  ok("rating within 0.2 of average isn't flagged", !texts.some((t) => t.includes("★ against")), texts);

  const summary = summaryLines({ businessName: "Green Leaf", rank: { keyword: "cannabis store detroit", local_pack: null, organic: 14, local_pack_names: [] }, listing: cmp, todo });
  ok("summary gives map, organic, reviews and counts", summary.includes("map not shown") && summary.includes("organic #14") &&
    summary.includes("#5 of 6 by reviews") && /\d+ to-do items, \d+ critical/.test(summary), summary);
}

console.log("buildTodo edge cases");
{
  const todo = buildTodo({
    businessName: "Top Shop",
    rank: { keyword: "k", local_pack: 2, organic: 3, local_pack_names: [] },
    listing: compareListing({ rating: 3.9, reviews: 500 }, [
      { name: "A", rating: 4.6, reviews: 100, domain: null, cid: "a" },
      { name: "B", rating: 4.5, reviews: 80, domain: null, cid: "b" },
    ]),
    competitors: [],
    site: [],
  });
  ok("a business doing well on maps, search and reviews gets no maps/search/reviews-count items",
    !todo.some((t) => t.area === "maps" || t.area === "search" || t.text.includes("Google reviews")), todo);
  ok("a low rating is still flagged", todo.some((t) => t.text.includes("3.9★ against a 4.6★")), todo);
}
{
  const todo = buildTodo({ businessName: "X", rank: { keyword: "k", local_pack: 6, organic: null, local_pack_names: [] }, listing: null, competitors: [], site: [] });
  ok("map position below 3 is a warning", todo.some((t) => t.area === "maps" && t.severity === "warning" && t.text.includes("#6")), todo);
  ok("not in top 20 organic is a warning", todo.some((t) => t.area === "search" && t.severity === "warning"), todo);
}
ok("no data, no items", buildTodo({ businessName: "X", rank: null, listing: null, competitors: [], site: [] }).length === 0);

console.log("extraSiteFindings");
ok("http site flagged", extraSiteFindings("http://x.com/", "<meta name=\"viewport\" content=\"width=device-width\">").some((f) => f.finding_type === "not_https"));
ok("missing viewport flagged", extraSiteFindings("https://x.com/", "<html></html>").some((f) => f.finding_type === "no_mobile_viewport"));
ok("https with viewport is clean", extraSiteFindings("https://x.com/", "<meta name='viewport' content='x'>").length === 0);
ok("no html, no viewport finding", extraSiteFindings("https://x.com/", null).length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
