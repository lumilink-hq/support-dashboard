// =============================================================================
// test-seo-technical-audit.ts — unit tests for the seo-technical-audit pure
// helpers (module 17).
//
//   npx tsx scripts/test-seo-technical-audit.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  analyzePsiResult,
  analyzeRedirectChain,
  analyzeRobotsTxt,
  analyzeSitemap,
  analyzeUrlInspection,
} from "../supabase/functions/seo-technical-audit/lib.ts";

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
console.log("\nanalyzePsiResult — lab data");
// ---------------------------------------------------------------------------
{
  const good = analyzePsiResult(
    { lighthouseResult: { categories: { performance: { score: 0.95 } } }, loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { category: "FAST" } } } },
    "mobile",
  );
  ok("a good lab score produces no lab finding", !good.some((f) => f.finding_type === "pagespeed_lab_performance"), good);

  const needsImprovement = analyzePsiResult(
    { lighthouseResult: { categories: { performance: { score: 0.7 } } } },
    "mobile",
  );
  const niFinding = needsImprovement.find((f) => f.finding_type === "pagespeed_lab_performance");
  ok("0.7 score -> needs_improvement, severity warning", niFinding?.severity === "warning", niFinding);

  const poor = analyzePsiResult({ lighthouseResult: { categories: { performance: { score: 0.3 } } } }, "mobile");
  const poorFinding = poor.find((f) => f.finding_type === "pagespeed_lab_performance");
  ok("0.3 score -> poor, severity critical", poorFinding?.severity === "critical", poorFinding);

  const noScore = analyzePsiResult({ lighthouseResult: {} }, "mobile");
  ok("missing score produces no lab finding (not a false 'poor')", !noScore.some((f) => f.finding_type === "pagespeed_lab_performance"));
}

// ---------------------------------------------------------------------------
console.log("\nanalyzePsiResult — field data / 'insufficient traffic'");
// ---------------------------------------------------------------------------
{
  const noFieldData = analyzePsiResult({ lighthouseResult: { categories: { performance: { score: 0.95 } } } }, "mobile");
  const insufficientFinding = noFieldData.find((f) => f.finding_type === "pagespeed_field_data_insufficient");
  ok("absent loadingExperience labels 'insufficient traffic'", insufficientFinding?.severity === "info", noFieldData);
  ok("'insufficient traffic' finding mentions it in the title", insufficientFinding?.title.includes("insufficient traffic") ?? false);

  const emptyMetrics = analyzePsiResult({ loadingExperience: { metrics: {} } }, "mobile");
  ok("empty metrics object also counts as insufficient traffic", emptyMetrics.some((f) => f.finding_type === "pagespeed_field_data_insufficient"));

  const poorFieldCwv = analyzePsiResult(
    { loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { category: "SLOW" }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { category: "FAST" } } } },
    "mobile",
  );
  const cwvFinding = poorFieldCwv.find((f) => f.finding_type === "pagespeed_field_core_web_vitals");
  ok("a SLOW field metric is flagged", cwvFinding !== undefined, poorFieldCwv);
  ok("only the SLOW metric is listed, not the FAST one", (cwvFinding?.details.poor_metrics as string[])?.length === 1);
  ok("with real field data present, no 'insufficient traffic' finding fires", !poorFieldCwv.some((f) => f.finding_type === "pagespeed_field_data_insufficient"));

  const goodFieldCwv = analyzePsiResult(
    { loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { category: "FAST" } } } },
    "mobile",
  );
  ok("all-FAST field metrics produce no CWV finding", !goodFieldCwv.some((f) => f.finding_type === "pagespeed_field_core_web_vitals"));
}

// ---------------------------------------------------------------------------
console.log("\nanalyzeUrlInspection");
// ---------------------------------------------------------------------------
{
  const clean = analyzeUrlInspection({ indexStatusResult: { verdict: "PASS", robotsTxtState: "ALLOWED", indexingState: "INDEXING_ALLOWED", pageFetchState: "SUCCESSFUL" } }, "https://acme.com/");
  ok("a clean PASS produces no findings", clean.length === 0, clean);

  const notIndexed = analyzeUrlInspection({ indexStatusResult: { verdict: "FAIL", coverageState: "Crawled - currently not indexed" } }, "https://acme.com/");
  ok("verdict FAIL -> not-indexed critical finding", notIndexed.some((f) => f.finding_type === "search_console_not_indexed" && f.severity === "critical"));

  const robotsBlocked = analyzeUrlInspection({ indexStatusResult: { robotsTxtState: "DISALLOWED" } }, "https://acme.com/");
  ok("robotsTxtState DISALLOWED flagged", robotsBlocked.some((f) => f.finding_type === "search_console_robots_blocked"));

  const noindexMeta = analyzeUrlInspection({ indexStatusResult: { indexingState: "BLOCKED_BY_META_TAG" } }, "https://acme.com/");
  ok("noindex meta tag flagged", noindexMeta.some((f) => f.finding_type === "search_console_noindex" && f.title.includes("meta tag")));

  const noindexHeader = analyzeUrlInspection({ indexStatusResult: { indexingState: "BLOCKED_BY_HTTP_HEADER" } }, "https://acme.com/");
  ok("noindex HTTP header flagged distinctly", noindexHeader.some((f) => f.finding_type === "search_console_noindex" && f.title.includes("HTTP header")));

  const serverError = analyzeUrlInspection({ indexStatusResult: { pageFetchState: "SERVER_ERROR" } }, "https://acme.com/");
  ok("bad pageFetchState flagged", serverError.some((f) => f.finding_type === "search_console_fetch_problem"));

  const canonicalMismatch = analyzeUrlInspection(
    { indexStatusResult: { googleCanonical: "https://acme.com/a", userCanonical: "https://acme.com/a/" } },
    "https://acme.com/a/",
  );
  ok("canonical mismatch flagged when both are present and differ", canonicalMismatch.some((f) => f.finding_type === "search_console_canonical_mismatch"));

  const canonicalAgree = analyzeUrlInspection(
    { indexStatusResult: { googleCanonical: "https://acme.com/a", userCanonical: "https://acme.com/a" } },
    "https://acme.com/a",
  );
  ok("matching canonicals produce no finding", !canonicalAgree.some((f) => f.finding_type === "search_console_canonical_mismatch"));

  const noResult = analyzeUrlInspection({}, "https://acme.com/");
  ok("absent indexStatusResult produces no findings, not a crash", noResult.length === 0);
}

// ---------------------------------------------------------------------------
console.log("\nanalyzeRedirectChain");
// ---------------------------------------------------------------------------
{
  ok("a clean 200 with no redirects produces no findings", analyzeRedirectChain([{ url: "https://acme.com/", status: 200 }]).length === 0);

  const unreachable = analyzeRedirectChain([{ url: "https://acme.com/", status: null }]);
  ok("an unreachable site is critical", unreachable.some((f) => f.finding_type === "site_unreachable" && f.severity === "critical"));

  const serverErr = analyzeRedirectChain([{ url: "https://acme.com/", status: 503 }]);
  ok("5xx final status flagged as server_error", serverErr.some((f) => f.finding_type === "server_error"));

  const notFound = analyzeRedirectChain([{ url: "https://acme.com/", status: 404 }]);
  ok("homepage 404 flagged distinctly", notFound.some((f) => f.finding_type === "homepage_not_found"));

  const longChain = analyzeRedirectChain([
    { url: "https://acme.com/", status: 301 },
    { url: "https://acme.com/a", status: 301 },
    { url: "https://acme.com/b", status: 301 },
    { url: "https://acme.com/c", status: 200 },
  ]);
  ok("3+ redirects flagged as too long", longChain.some((f) => f.finding_type === "redirect_chain_too_long"));

  const shortChain = analyzeRedirectChain([
    { url: "https://acme.com/", status: 301 },
    { url: "https://www.acme.com/", status: 200 },
  ]);
  ok("a single redirect (http->https or bare->www) is NOT flagged as too long", !shortChain.some((f) => f.finding_type === "redirect_chain_too_long"));

  const loop = analyzeRedirectChain([
    { url: "https://acme.com/a", status: 301 },
    { url: "https://acme.com/b", status: 301 },
    { url: "https://acme.com/a", status: 301 },
  ]);
  ok("a repeated URL is flagged as a redirect loop", loop.some((f) => f.finding_type === "redirect_loop" && f.severity === "critical"));
}

// ---------------------------------------------------------------------------
console.log("\nanalyzeRobotsTxt");
// ---------------------------------------------------------------------------
{
  ok("no robots.txt at all is not a finding (fails open)", analyzeRobotsTxt(false, null).length === 0);
  ok("a normal permissive robots.txt is fine", analyzeRobotsTxt(true, "User-agent: *\nDisallow: /admin\n").length === 0);
  const blocksAll = analyzeRobotsTxt(true, "User-agent: *\nDisallow: /\n");
  ok("Disallow: / for * is flagged as blocking everything", blocksAll.some((f) => f.finding_type === "robots_txt_blocks_everything" && f.severity === "critical"));
  ok(
    "Disallow: / for ONE specific bot (not *) is not flagged as blocking everything",
    analyzeRobotsTxt(true, "User-agent: SomeOtherBot\nDisallow: /\n").length === 0,
  );
}

// ---------------------------------------------------------------------------
console.log("\nanalyzeSitemap");
// ---------------------------------------------------------------------------
{
  ok("a found sitemap produces no finding", analyzeSitemap(true, "https://acme.com/sitemap.xml").length === 0);
  const missing = analyzeSitemap(false, null);
  ok("a missing sitemap is flagged as a warning", missing.some((f) => f.finding_type === "sitemap_missing" && f.severity === "warning"));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
