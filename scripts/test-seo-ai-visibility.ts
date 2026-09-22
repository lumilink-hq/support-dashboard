// =============================================================================
// test-seo-ai-visibility.ts — unit tests for the seo-ai-visibility pure
// helpers (module 20).
//
//   npx tsx scripts/test-seo-ai-visibility.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  buildSearchBody,
  DEFAULT_PLATFORMS,
  parseMentions,
  pickQueries,
  primaryDomain,
  shareOfVisibility,
  targetDomain,
} from "../supabase/functions/seo-ai-visibility/lib.ts";

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

console.log("\ntargetDomain / primaryDomain");
{
  ok("strips protocol, www and path", targetDomain("https://www.Acme.com/hvac") === "acme.com");
  ok("garbage and dotless hosts are null", targetDomain("nope") === null && targetDomain(null) === null);
  ok(
    "primaryDomain picks the domain most locations share",
    primaryDomain(["https://a.com/x", "https://www.a.com", "https://b.com"]) === "a.com",
  );
  ok("primaryDomain ties break alphabetically, stably", primaryDomain(["https://b.com", "https://a.com"]) === "a.com");
  ok("primaryDomain ignores unparseable and null", primaryDomain([null, "nope", "https://c.com"]) === "c.com");
  ok("primaryDomain of nothing is null", primaryDomain([]) === null);
}

console.log("\nbuildSearchBody");
{
  const b = buildSearchBody("emergency plumber", "acme.com", "chat_gpt") as any;
  ok("carries the platform", b.platform === "chat_gpt");
  ok("keyword is scoped to the question, partial match", b.target[0].keyword === "emergency plumber" && b.target[0].search_scope[0] === "question" && b.target[0].match_type === "partial_match");
  ok("domain is scoped to sources", b.target[1].domain === "acme.com" && b.target[1].search_scope[0] === "sources");
  ok("US English, capped row limit", b.location_code === 2840 && b.language_code === "en" && b.limit <= 10);
  ok("default platforms are only the two the docs list", DEFAULT_PLATFORMS.join(",") === "google,chat_gpt");
}

console.log("\nparseMentions");
{
  const result = [
    {
      total_count: 37,
      items_count: 2,
      items: [
        {
          question: "who is the best plumber in austin",
          sources: [
            { url: "https://www.acme.com/plumbing", domain: "acme.com", title: "Acme Plumbing" },
            { url: "https://yelp.com/acme", domain: "yelp.com", title: "Yelp" },
          ],
        },
        {
          question: "emergency plumber near me",
          sources: [
            { url: "https://www.acme.com/plumbing", domain: "www.acme.com" },
            { url: "https://acme.com/emergency", title: "Emergency" },
          ],
        },
      ],
    },
  ];
  const r = parseMentions(result, "acme.com");
  ok("cited_count is the API total, not the rows returned", r.cited_count === 37 && r.items_returned === 2, r);
  ok("only the client's own domain is kept as a source", r.top_sources.every((s) => s.url.includes("acme.com")), r.top_sources);
  ok("duplicate URLs collapse", r.top_sources.length === 2, r.top_sources);
  ok("the question travels with the source", r.top_sources[0].question === "who is the best plumber in austin");
  ok("a source with no domain field is matched from its URL", r.top_sources.some((s) => s.url === "https://acme.com/emergency"));

  const none = parseMentions([{ total_count: 0, items: [] }], "acme.com");
  ok("zero results is a real zero", none.cited_count === 0 && none.top_sources.length === 0, none);
  ok("null result is zero, not a crash", parseMentions(null, "acme.com").cited_count === 0);
  ok("falls back to the row count when total_count is absent", parseMentions([{ items: [{ sources: [] }] }], "acme.com").cited_count === 1);
}

console.log("\npickQueries");
{
  const q = pickQueries([" emergency plumber ", "Emergency Plumber", "a", "", "water heater repair"]);
  ok("trims, drops case-insensitive duplicates, drops too-short", q.join("|") === "emergency plumber|water heater repair", q);
  ok("caps the list", pickQueries(Array.from({ length: 30 }, (_, i) => `query ${i}`), 18).length === 18);
}

console.log("\nshareOfVisibility");
{
  const rows = [
    { query_id: "1", cited_count: 4 },
    { query_id: "1", cited_count: 0 },
    { query_id: "2", cited_count: 0 },
    { query_id: "3", cited_count: 1 },
  ];
  ok("counts a query once even if several platforms cite it", Math.abs(shareOfVisibility(rows, 4) - 0.5) < 1e-9);
  ok("no queries is zero, not NaN", shareOfVisibility([], 0) === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
