// =============================================================================
// lib.ts — pure, side-effect-free helpers for the seo-technical-audit worker
// (module 17). Same split as seo-crawl/kb-ingest: no Deno, no network, no
// database — everything here is unit-testable in plain Node/tsx.
//
// SCOPE VS PLAN.MD. Module 17's deliverable lists four things: PageSpeed
// Insights, Search Console URL Inspection, status/redirect/robots/sitemap
// checks, and a monthly Manual Actions check. This file covers the first
// three. THE FOURTH IS NOT BUILT — the Search Console API (Search Analytics,
// Sitemaps, Sites, URL Inspection) has no Manual Actions resource; that
// report is Search-Console-UI-only. Confirmed against developers.google.com
// before writing any code here rather than guessing at an endpoint. Left as
// an explicit gap (a monthly reminder for a human to check the UI, once
// module 13's report exists) rather than faked.
// =============================================================================

export type Finding = {
  finding_type: string;
  severity: "critical" | "warning" | "info";
  title: string;
  details: Record<string, unknown>;
};

// -----------------------------------------------------------------------------
// PageSpeed Insights (Core Web Vitals + Lighthouse).
//
// "Always show lab data, and label missing field data as 'insufficient
// traffic'" (plan.md) — lab data (Lighthouse, synthetic) is essentially
// always present; field data (loadingExperience, real Chrome UX Report
// users) is ABSENT for any site without enough Chrome traffic, which is the
// NORMAL case for a small local business, not an edge case. Google's own
// docs say real-world CrUX data in this API is being phased out entirely, so
// "field data missing" has to be a first-class, unsurprising outcome here.
// -----------------------------------------------------------------------------

const PSI_LAB_SCORE_POOR = 0.5; // Lighthouse's own poor/needs-improvement/good bands
const PSI_LAB_SCORE_NEEDS_IMPROVEMENT = 0.9;

export type PsiLighthouseResult = {
  categories?: { performance?: { score?: number | null } };
  audits?: Record<string, { score?: number | null; displayValue?: string; numericValue?: number }>;
};

export type PsiLoadingExperience = {
  metrics?: Record<string, { category?: string; percentile?: number }>;
  overall_category?: string;
} | null | undefined;

export type PsiResult = {
  lighthouseResult?: PsiLighthouseResult;
  loadingExperience?: PsiLoadingExperience;
};

/** Lighthouse's 0-1 score into the three-band verdict it displays itself. */
function labBand(score: number | null | undefined): "good" | "needs_improvement" | "poor" | null {
  if (score === null || score === undefined) return null;
  if (score >= PSI_LAB_SCORE_NEEDS_IMPROVEMENT) return "good";
  if (score >= PSI_LAB_SCORE_POOR) return "needs_improvement";
  return "poor";
}

export function analyzePsiResult(result: PsiResult, strategy: "mobile" | "desktop"): Finding[] {
  const findings: Finding[] = [];
  const perfScore = result.lighthouseResult?.categories?.performance?.score ?? null;
  const band = labBand(perfScore);

  if (band === "poor" || band === "needs_improvement") {
    findings.push({
      finding_type: "pagespeed_lab_performance",
      severity: band === "poor" ? "critical" : "warning",
      title: `Lighthouse performance score is ${band === "poor" ? "poor" : "needs improvement"} (${strategy})`,
      details: {
        strategy,
        score: perfScore,
        band,
        // Lab data: always shown per plan.md, whatever the verdict.
        lcp: result.lighthouseResult?.audits?.["largest-contentful-paint"]?.displayValue ?? null,
        cls: result.lighthouseResult?.audits?.["cumulative-layout-shift"]?.displayValue ?? null,
        tbt: result.lighthouseResult?.audits?.["total-blocking-time"]?.displayValue ?? null,
      },
    });
  }

  const fieldMetrics = result.loadingExperience?.metrics;
  if (!fieldMetrics || Object.keys(fieldMetrics).length === 0) {
    // The "insufficient traffic" label plan.md asks for, not a blank/missing
    // field the report would otherwise render as a bug.
    findings.push({
      finding_type: "pagespeed_field_data_insufficient",
      severity: "info",
      title: `No real-user Core Web Vitals data available for this page (${strategy}) — insufficient traffic`,
      details: { strategy },
    });
  } else {
    const cwvKeys = ["LARGEST_CONTENTFUL_PAINT_MS", "CUMULATIVE_LAYOUT_SHIFT_SCORE", "INTERACTION_TO_NEXT_PAINT"];
    const poor = cwvKeys.filter((k) => fieldMetrics[k]?.category === "SLOW");
    if (poor.length > 0) {
      findings.push({
        finding_type: "pagespeed_field_core_web_vitals",
        severity: "warning",
        title: `Real-user Core Web Vitals are poor for ${poor.length} metric${poor.length === 1 ? "" : "s"} (${strategy})`,
        details: {
          strategy,
          poor_metrics: poor,
          overall_category: result.loadingExperience?.overall_category ?? null,
        },
      });
    }
  }

  return findings;
}

// -----------------------------------------------------------------------------
// Search Console URL Inspection.
//
// mobileUsabilityResult is DEPRECATED per Google's own docs (confirmed
// 2026-09-17) — not read here at all, rather than building against a field
// Google has already announced is going away.
// -----------------------------------------------------------------------------

export type IndexStatusResult = {
  verdict?: string;
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  pageFetchState?: string;
  googleCanonical?: string;
  userCanonical?: string;
};

export function analyzeUrlInspection(result: { indexStatusResult?: IndexStatusResult }, pageUrl: string): Finding[] {
  const findings: Finding[] = [];
  const r = result.indexStatusResult;
  if (!r) return findings;

  if (r.verdict === "FAIL") {
    findings.push({
      finding_type: "search_console_not_indexed",
      severity: "critical",
      title: "Google Search Console reports this page is not indexed",
      details: { coverage_state: r.coverageState ?? null, page_url: pageUrl },
    });
  }

  if (r.robotsTxtState === "DISALLOWED") {
    findings.push({
      finding_type: "search_console_robots_blocked",
      severity: "critical",
      title: "Google's own crawler reports robots.txt blocks this page",
      details: { page_url: pageUrl },
    });
  }

  if (r.indexingState === "BLOCKED_BY_META_TAG" || r.indexingState === "BLOCKED_BY_HTTP_HEADER") {
    findings.push({
      finding_type: "search_console_noindex",
      severity: "critical",
      title: `This page has a noindex directive (${r.indexingState === "BLOCKED_BY_META_TAG" ? "meta tag" : "HTTP header"})`,
      details: { page_url: pageUrl },
    });
  }

  const badFetchStates = ["NOT_FOUND", "SERVER_ERROR", "ACCESS_DENIED", "ACCESS_FORBIDDEN", "SOFT_404"];
  if (r.pageFetchState && badFetchStates.includes(r.pageFetchState)) {
    findings.push({
      finding_type: "search_console_fetch_problem",
      severity: "critical",
      title: `Google couldn't fetch this page: ${r.pageFetchState}`,
      details: { page_url: pageUrl, page_fetch_state: r.pageFetchState },
    });
  }

  // A canonical mismatch is only meaningful when Google actually chose one —
  // absent googleCanonical means the page wasn't indexed, already covered above.
  if (r.googleCanonical && r.userCanonical && r.googleCanonical !== r.userCanonical) {
    findings.push({
      finding_type: "search_console_canonical_mismatch",
      severity: "warning",
      title: "Google chose a different canonical URL than this page declares",
      details: { page_url: pageUrl, declared: r.userCanonical, google_chose: r.googleCanonical },
    });
  }

  return findings;
}

// -----------------------------------------------------------------------------
// Status codes / redirect chains / robots.txt / sitemap — plain HTTP, no
// vendor API. The network fetching happens in index.ts; these functions
// analyze what was fetched.
// -----------------------------------------------------------------------------

export type RedirectHop = { url: string; status: number | null };

export function analyzeRedirectChain(hops: RedirectHop[]): Finding[] {
  const findings: Finding[] = [];
  if (hops.length === 0) return findings;

  const last = hops[hops.length - 1];
  if (last.status === null) {
    findings.push({
      finding_type: "site_unreachable",
      severity: "critical",
      title: "The site didn't respond",
      details: { hops },
    });
    return findings;
  }

  if (last.status >= 500) {
    findings.push({
      finding_type: "server_error",
      severity: "critical",
      title: `Site returns a server error (${last.status})`,
      details: { status: last.status, hops },
    });
  } else if (last.status === 404) {
    findings.push({
      finding_type: "homepage_not_found",
      severity: "critical",
      title: "The homepage returns 404",
      details: { hops },
    });
  } else if (last.status >= 400) {
    findings.push({
      finding_type: "client_error",
      severity: "critical",
      title: `Site returns a client error (${last.status})`,
      details: { status: last.status, hops },
    });
  }

  const redirectCount = hops.length - 1;
  if (redirectCount >= 3) {
    findings.push({
      finding_type: "redirect_chain_too_long",
      severity: "warning",
      title: `Homepage goes through ${redirectCount} redirects before resolving`,
      details: { hops },
    });
  }

  // A hop repeating an earlier URL is a loop, not just a long chain — worth
  // calling out distinctly since "3 redirects" and "infinite loop" need
  // different fixes.
  const seen = new Set<string>();
  for (const hop of hops) {
    if (seen.has(hop.url)) {
      findings.push({
        finding_type: "redirect_loop",
        severity: "critical",
        title: "Homepage redirects in a loop",
        details: { hops },
      });
      break;
    }
    seen.add(hop.url);
  }

  return findings;
}

export function analyzeRobotsTxt(fetched: boolean, content: string | null): Finding[] {
  if (!fetched) {
    // Absent robots.txt is NOT an error (fails open, same as seo-crawl) — a
    // 404 on /robots.txt just means "no restrictions stated", the standard
    // crawler convention. Nothing to flag.
    return [];
  }
  if (content !== null && /disallow:\s*\/\s*($|\n)/i.test(content) && /user-agent:\s*\*/i.test(content)) {
    return [
      {
        finding_type: "robots_txt_blocks_everything",
        severity: "critical",
        title: "robots.txt disallows all crawling for all user agents",
        details: {},
      },
    ];
  }
  return [];
}

export function analyzeSitemap(found: boolean, sitemapUrl: string | null): Finding[] {
  if (found) return [];
  return [
    {
      finding_type: "sitemap_missing",
      severity: "warning",
      title: "No XML sitemap found at /sitemap.xml or referenced in robots.txt",
      details: sitemapUrl ? { checked: sitemapUrl } : {},
    },
  ];
}
