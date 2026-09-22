// =============================================================================
// test-seo-backlinks.ts — unit tests for the seo-backlinks pure helpers
// (module 15).
//
//   npx tsx scripts/test-seo-backlinks.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  isNotSubscribedError,
  lastCompleteMonth,
  parseNewLost,
  parseSummary,
  parseTopPages,
  targetDomain,
} from "../supabase/functions/seo-backlinks/lib.ts";

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

console.log("\ntargetDomain");
{
  ok("strips protocol, www and path", targetDomain("https://www.acme.com/services/hvac") === "acme.com");
  ok("keeps a real subdomain", targetDomain("https://shop.acme.com") === "shop.acme.com");
  ok("bare domain", targetDomain("Acme.com") === "acme.com");
  ok("null in, null out", targetDomain(null) === null);
  ok("garbage is null", targetDomain("not a url!!") === null);
  ok("dotless host is null", targetDomain("localhost") === null);
}

console.log("\nparseSummary");
{
  const s = parseSummary({ rank: 312, backlinks: 1840, referring_domains: 96, other: "x" });
  ok("reads the three counts", s.total_backlinks === 1840 && s.referring_domains === 96 && s.rank === 312, s);
  const empty = parseSummary(null);
  ok("null result gives nulls, not zeros", empty.total_backlinks === null && empty.referring_domains === null, empty);
  ok("non-numeric values become null", parseSummary({ backlinks: "12" }).total_backlinks === null);
}

console.log("\nlastCompleteMonth");
{
  const mid = lastCompleteMonth(new Date("2026-09-21T12:00:00Z"));
  ok("mid-September gives August", mid.from === "2026-08-01" && mid.to === "2026-08-31", mid);
  const first = lastCompleteMonth(new Date("2026-09-01T00:00:00Z"));
  ok("the 1st still gives the month just ended", first.from === "2026-08-01" && first.to === "2026-08-31", first);
  const jan = lastCompleteMonth(new Date("2026-01-15T00:00:00Z"));
  ok("January rolls back to December of the prior year", jan.from === "2025-12-01" && jan.to === "2025-12-31", jan);
  const march = lastCompleteMonth(new Date("2028-03-10T00:00:00Z"));
  ok("handles a leap-year February end", march.to === "2028-02-29", march);
}

console.log("\nparseNewLost");
{
  const nested = [
    {
      items: [
        { date: "2026-07-01", new_backlinks: 5, lost_backlinks: 1 },
        { date: "2026-08-01", new_backlinks: 42, lost_backlinks: 7, new_referring_domains: 9, lost_referring_domains: 2 },
      ],
    },
  ];
  const r = parseNewLost(nested, "2026-08-01");
  ok("picks the requested month, not the neighbouring one", r.gained_count === 42 && r.lost_count === 7, r);
  ok("carries the referring-domain deltas", r.new_referring_domains === 9 && r.lost_referring_domains === 2);

  const flat = [{ date: "2026-08-01", new_backlinks: 3, lost_backlinks: 0 }];
  ok("tolerates items directly in the array", parseNewLost(flat, "2026-08-01").gained_count === 3);
  ok("a real zero stays zero", parseNewLost(flat, "2026-08-01").lost_count === 0);

  const missing = parseNewLost(nested, "2026-06-01");
  ok("a month that isn't present is null, not a fake zero", missing.gained_count === null && missing.lost_count === null, missing);
  ok("null result is all nulls", parseNewLost(null, "2026-08-01").gained_count === null);
}

console.log("\nparseTopPages");
{
  const result = [
    {
      items: [
        { url: "https://acme.com/a", backlinks: 10, referring_domains: 4 },
        { url: "https://acme.com/", backlinks: 500, referring_domains: 60 },
        { url: "https://acme.com/c", backlinks: 40 },
        { backlinks: 9 },
        { url: "https://acme.com/bad", backlinks: "x" },
      ],
    },
  ];
  const pages = parseTopPages(result, 10);
  ok("sorted by backlinks descending", pages.map((p) => p.backlinks).join(",") === "500,40,10", pages);
  ok("drops items without a url or numeric backlinks", pages.length === 3);
  ok("missing referring_domains defaults to 0", pages.find((p) => p.url.endsWith("/c"))?.referring_domains === 0);
  ok("respects the limit", parseTopPages(result, 2).length === 2);
  ok("empty result is an empty list", parseTopPages(null).length === 0 && parseTopPages([{}]).length === 0);
}

console.log("\nisNotSubscribedError");
{
  ok("documented access-denied code", isNotSubscribedError(40204, undefined));
  ok("matches the message when the code differs", isNotSubscribedError(40000, "Access denied. Visit Backlinks page to subscribe."));
  ok("an ordinary error is not a subscription error", !isNotSubscribedError(50000, "Internal Error"));
  ok("success is not a subscription error", !isNotSubscribedError(20000, "Ok."));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
