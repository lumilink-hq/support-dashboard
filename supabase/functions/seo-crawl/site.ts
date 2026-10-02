// =============================================================================
// site.ts — pure helpers for module 24 (plan.md, Phase 6c): the site-wide half
// of the crawl. lib.ts audits ONE page; this file finds the page set (sitemap
// plus links), pulls the link facts out of each page, and runs the rules that
// need the whole site at once: broken links, internal redirects, duplicate
// titles and descriptions, canonical problems, noindex pages in the sitemap,
// orphan and weakly linked pages.
//
// No Deno, no network, no database: unit-tested in scripts/test-seo-crawl-site.ts.
// =============================================================================

import { decodeEntities, normalizeUrl, type CrawlFinding } from "./lib.ts";

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_SITEMAP_URLS = 2000; // kept per run; more than any page limit
export const MAX_CHILD_SITEMAPS = 10;
export const MAX_INTERNAL_LINKS_PER_PAGE = 300;
export const MAX_OUTBOUND_LINKS_PER_PAGE = 100;
export const MAX_INTERNAL_CHECKS = 150; // linked-but-not-crawled internal URLs checked per run
export const MAX_OUTBOUND_CHECKS = 150; // distinct outbound URLs checked per run
export const SAMPLE = 20; // URLs listed in a finding's details

const NON_PAGE = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|mjs|json|xml|zip|gz|mp[34]|mov|avi|woff2?|ttf|eot)(\?|#|$)/i;
const SKIP_PATH =
  /\/(wp-admin|wp-login|wp-json|cart|checkout|basket|my-account|account|login|signin|sign-in|register|signup|search|feed|rss|tag|tags|author|page\/\d)/i;

// -----------------------------------------------------------------------------
// Hosts
// -----------------------------------------------------------------------------

export function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** Same site: identical host (and port, if any) ignoring a leading www.
 * `siteHost` is a URL's `host`, e.g. "www.acme.com" or "localhost:8080". */
export function sameSite(url: string, siteHost: string): boolean {
  try {
    return bareHost(new URL(url).host) === bareHost(siteHost);
  } catch {
    return false;
  }
}

/** A URL worth fetching as a page (not a file, not a cart/login/feed path). */
export function isCrawlable(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return !NON_PAGE.test(u.pathname) && !SKIP_PATH.test(u.pathname);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Sitemaps
// -----------------------------------------------------------------------------

/** `Sitemap:` lines from robots.txt, absolute only. */
export function sitemapsFromRobots(robots: string | null): string[] {
  const out: string[] = [];
  for (const line of (robots ?? "").split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (m && /^https?:\/\//i.test(m[1])) out.push(m[1]);
  }
  return [...new Set(out)];
}

export type ParsedSitemap = { kind: "index" | "urlset" | "unknown"; locs: string[] };

/** <loc> values of a sitemap or sitemap index. Tolerates CDATA and entities. */
export function parseSitemap(xml: string | null): ParsedSitemap {
  if (!xml) return { kind: "unknown", locs: [] };
  const kind = /<sitemapindex\b/i.test(xml) ? "index" : /<urlset\b/i.test(xml) ? "urlset" : "unknown";
  const locs: string[] = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([\s\S]*?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const loc = decodeEntities(m[1]).trim();
    if (loc) locs.push(loc);
  }
  return { kind, locs };
}

/** Sitemap page URLs to keep: same site, crawlable, normalised, de-duplicated, capped. */
export function sitemapPages(locs: string[], siteHost: string, cap = MAX_SITEMAP_URLS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const loc of locs) {
    if (out.length >= cap) break;
    if (!sameSite(loc, siteHost) || !isCrawlable(loc)) continue;
    const n = normalizeUrl(loc);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Page facts
// -----------------------------------------------------------------------------

/** Every <a href>, split into same-site pages and outbound http(s) URLs. */
export function extractLinks(html: string, pageUrl: string, siteHost: string): { internal: string[]; outbound: string[] } {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return { internal: [], outbound: [] };
  }
  const internal = new Set<string>();
  const outbound = new Set<string>();
  const self = normalizeUrl(base.href);
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html ?? "")) !== null) {
    const href = decodeEntities(m[1]).trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|data|sms):/i.test(href)) continue;
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    const n = normalizeUrl(abs.href);
    if (sameSite(n, siteHost)) {
      if (n !== self && isCrawlable(n) && internal.size < MAX_INTERNAL_LINKS_PER_PAGE) internal.add(n);
    } else if (outbound.size < MAX_OUTBOUND_LINKS_PER_PAGE) {
      outbound.add(n);
    }
  }
  return { internal: [...internal], outbound: [...outbound] };
}

/** Every rel=canonical href, resolved against the page. */
export function extractCanonicals(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  const re = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html ?? "")) !== null) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']canonical["']/i.test(tag)) continue;
    const hm = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!hm) continue;
    try {
      out.push(normalizeUrl(new URL(decodeEntities(hm[1]).trim(), pageUrl).href));
    } catch {
      // unresolvable canonical: ignored, like a missing one
    }
  }
  return out;
}

/** noindex from <meta name="robots|googlebot"> or an X-Robots-Tag header. */
export function isNoindex(html: string, xRobotsTag: string | null): boolean {
  if (xRobotsTag && /\bnoindex\b/i.test(xRobotsTag)) return true;
  const re = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html ?? "")) !== null) {
    const tag = m[0];
    if (!/\bname\s*=\s*["'](robots|googlebot)["']/i.test(tag)) continue;
    const cm = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (cm && /\bnoindex\b/i.test(cm[1])) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// The site-wide rules
// -----------------------------------------------------------------------------

export type PageFact = {
  url: string;
  status_code: number; // 0 = the fetch failed outright
  final_url: string | null;
  redirect_hops: number;
  in_sitemap: boolean;
  is_root: boolean;
  title: string | null;
  meta_description: string | null;
  canonicals: string[];
  noindex: boolean;
  internal_links: string[];
  outbound_links: string[];
};

export type LinkCheck = {
  url: string;
  status_code: number; // 0 = no answer (timeout, connection refused, DNS)
  final_url: string | null;
  redirect_hops: number;
  error: string | null;
};

export type SiteInput = {
  siteHost: string;
  pages: PageFact[];
  checks: LinkCheck[];
  pageLimit: number;
  truncated: boolean; // the queue still had pages when the limit was reached
  sitemapFound: boolean;
  sitemapUrlCount: number;
};

export type SiteFinding = CrawlFinding & { target_url: string };

type Known = { status_code: number; final_url: string | null; redirect_hops: number; error: string | null };

function isBrokenInternal(k: Known): boolean {
  return k.status_code >= 400;
}

/** Outbound: only answers that mean "gone" count. 403/429/999 are bot walls,
 * a timeout can be a slow server; neither is evidence the page is gone. */
function isBrokenOutbound(k: Known): boolean {
  return k.status_code === 404 || k.status_code === 410 || k.error === "dns";
}

/** The page of a duplicate group that keeps its text: the homepage if it's in
 * the group, else the shortest URL (usually the parent page). */
function keeper(urls: string[], root: string | null): string {
  if (root && urls.includes(root)) return root;
  return [...urls].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

/** Pages that should carry unique copy: answered 200, indexable, and not
 * canonicalised to another URL (a page pointing its canonical elsewhere is a
 * deliberate duplicate). */
function isIndexableOriginal(p: PageFact): boolean {
  if (p.status_code !== 200 || p.noindex) return false;
  const own = normalizeUrl(p.final_url ?? p.url);
  return p.canonicals.length === 0 || p.canonicals.every((c) => c === own || c === p.url);
}

function duplicates(
  pages: PageFact[],
  field: "title" | "meta_description",
  root: string | null,
): Map<string, { text: string; others: string[] }> {
  const groups = new Map<string, string[]>();
  for (const p of pages) {
    const text = p[field];
    if (!text || !isIndexableOriginal(p)) continue;
    const key = text.toLowerCase().replace(/\s+/g, " ").trim();
    groups.set(key, [...(groups.get(key) ?? []), p.url]);
  }
  const out = new Map<string, { text: string; others: string[] }>();
  for (const urls of groups.values()) {
    if (urls.length < 2) continue;
    const keep = keeper(urls, root);
    const text = pages.find((p) => p.url === keep)?.[field] ?? "";
    for (const u of urls) if (u !== keep) out.set(u, { text, others: urls.filter((x) => x !== u).slice(0, 10) });
  }
  return out;
}

export function auditSite(input: SiteInput): SiteFinding[] {
  const findings: SiteFinding[] = [];
  const pages = input.pages;
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const checks = new Map(input.checks.map((c) => [c.url, c]));
  const root = pages.find((p) => p.is_root)?.url ?? null;
  const known = (u: string): Known | null => byUrl.get(u) ?? checks.get(u) ?? null;

  // Inbound internal links, counted against the URL linked AND where it lands.
  const inbound = new Map<string, Set<string>>();
  const addInbound = (target: string, from: string) => {
    if (target === from) return;
    const set = inbound.get(target) ?? new Set<string>();
    set.add(from);
    inbound.set(target, set);
  };
  for (const p of pages) {
    if (p.status_code !== 200) continue;
    for (const t of p.internal_links) {
      addInbound(t, p.url);
      const k = known(t);
      if (k?.final_url) addInbound(normalizeUrl(k.final_url), p.url);
    }
  }

  for (const p of pages) {
    if (p.status_code !== 200) continue;

    // Broken internal links and internal links that redirect.
    const broken: { url: string; status: number }[] = [];
    const redirected: { url: string; final_url: string | null; hops: number }[] = [];
    for (const t of p.internal_links) {
      const k = known(t);
      if (!k) continue;
      if (isBrokenInternal(k)) broken.push({ url: t, status: k.status_code });
      else if (k.redirect_hops > 0) redirected.push({ url: t, final_url: k.final_url, hops: k.redirect_hops });
    }
    if (broken.length) {
      findings.push({
        finding_type: "broken_internal_links",
        severity: "warning",
        title: `${broken.length} link${broken.length === 1 ? "" : "s"} on this page go${broken.length === 1 ? "es" : ""} to a page on your site that doesn't work`,
        details: { links: broken.slice(0, SAMPLE), count: broken.length },
        target_url: p.url,
      });
    }
    if (redirected.length) {
      const worst = Math.max(...redirected.map((r) => r.hops));
      findings.push({
        finding_type: "internal_links_redirect",
        severity: worst >= 2 ? "warning" : "info",
        title: `${redirected.length} link${redirected.length === 1 ? "" : "s"} on this page go${redirected.length === 1 ? "es" : ""} through a redirect`,
        details: { links: redirected.slice(0, SAMPLE), count: redirected.length, most_hops: worst },
        target_url: p.url,
      });
    }

    // Broken outbound links.
    const dead: { url: string; status: number; error: string | null }[] = [];
    for (const t of p.outbound_links) {
      const k = checks.get(t);
      if (k && isBrokenOutbound(k)) dead.push({ url: t, status: k.status_code, error: k.error });
    }
    if (dead.length) {
      findings.push({
        finding_type: "broken_outbound_links",
        severity: "warning",
        title: `${dead.length} link${dead.length === 1 ? "" : "s"} on this page go${dead.length === 1 ? "es" : ""} to another site's page that no longer exists`,
        details: { links: dead.slice(0, SAMPLE), count: dead.length },
        target_url: p.url,
      });
    }

    // Canonicals.
    const uniqueCanon = [...new Set(p.canonicals)];
    if (uniqueCanon.length > 1) {
      findings.push({
        finding_type: "multiple_canonicals",
        severity: "warning",
        title: `Page declares ${uniqueCanon.length} different canonical URLs`,
        details: { canonicals: uniqueCanon },
        target_url: p.url,
      });
    } else if (uniqueCanon.length === 1) {
      const c = uniqueCanon[0];
      const own = normalizeUrl(p.final_url ?? p.url);
      if (!sameSite(c, input.siteHost)) {
        findings.push({
          finding_type: "canonical_other_site",
          severity: "warning",
          title: "Page's canonical URL points to a different website",
          details: { canonical: c },
          target_url: p.url,
        });
      } else if (c !== own && c !== p.url) {
        const k = known(c);
        if (k && (isBrokenInternal(k) || k.redirect_hops > 0)) {
          findings.push({
            finding_type: "canonical_target_not_ok",
            severity: "warning",
            title: isBrokenInternal(k) ? "Page's canonical URL doesn't work" : "Page's canonical URL redirects",
            details: { canonical: c, status: k.status_code, final_url: k.final_url },
            target_url: p.url,
          });
        }
      }
    }

    // Sitemap hygiene.
    if (p.in_sitemap && p.noindex) {
      findings.push({
        finding_type: "noindex_in_sitemap",
        severity: "warning",
        title: "Page is in the sitemap but tells Google not to index it",
        details: {},
        target_url: p.url,
      });
    }
  }

  for (const p of pages) {
    if (p.in_sitemap && (p.status_code >= 400 || p.redirect_hops > 0)) {
      findings.push({
        finding_type: "sitemap_url_not_ok",
        severity: "warning",
        title: p.status_code >= 400 ? `Sitemap lists a page that answers ${p.status_code}` : "Sitemap lists a URL that redirects",
        details: { status: p.status_code, final_url: p.final_url, hops: p.redirect_hops },
        target_url: p.url,
      });
    }
  }

  // Duplicates, one finding per page except the one that keeps the text.
  for (const [url, d] of duplicates(pages, "title", root)) {
    findings.push({
      finding_type: "duplicate_title",
      severity: "warning",
      title: `Title is the same as on ${d.others.length} other page${d.others.length === 1 ? "" : "s"}`,
      details: { title: d.text, also_on: d.others },
      target_url: url,
    });
  }
  for (const [url, d] of duplicates(pages, "meta_description", root)) {
    findings.push({
      finding_type: "duplicate_meta_description",
      severity: "warning",
      title: `Meta description is the same as on ${d.others.length} other page${d.others.length === 1 ? "" : "s"}`,
      details: { meta_description: d.text, also_on: d.others },
      target_url: url,
    });
  }

  // Orphans and weakly linked pages: only meaningful when the crawl saw the
  // whole site, otherwise "nothing links here" may just mean "not crawled".
  const linkable = pages.filter((p) => p.status_code === 200 && !p.is_root && !p.noindex);
  if (!input.truncated) {
    for (const p of linkable) {
      if (p.in_sitemap && (inbound.get(p.url)?.size ?? 0) === 0) {
        findings.push({
          finding_type: "orphan_page",
          severity: "warning",
          title: "No other page on the site links here (it's only in the sitemap)",
          details: {},
          target_url: p.url,
        });
      }
    }
    const weak = linkable.filter((p) => (inbound.get(p.url)?.size ?? 0) === 1).map((p) => p.url);
    if (weak.length && root) {
      findings.push({
        finding_type: "weakly_linked_pages",
        severity: "info",
        title: `${weak.length} page${weak.length === 1 ? " is" : "s are"} linked from only one other page`,
        details: { pages: weak.slice(0, SAMPLE), count: weak.length },
        target_url: root,
      });
    }
  }

  // Missing canonicals, as one site-level note rather than a finding per page.
  const noCanon = pages.filter((p) => p.status_code === 200 && !p.noindex && p.canonicals.length === 0).map((p) => p.url);
  if (noCanon.length && root) {
    findings.push({
      finding_type: "pages_missing_canonical",
      severity: "info",
      title: `${noCanon.length} page${noCanon.length === 1 ? " has" : "s have"} no canonical tag`,
      details: { pages: noCanon.slice(0, SAMPLE), count: noCanon.length },
      target_url: root,
    });
  }

  if (input.truncated && root) {
    findings.push({
      finding_type: "crawl_page_limit_reached",
      severity: "info",
      title: `Audited the first ${pages.length} pages; the site has more than this location's limit of ${input.pageLimit}`,
      details: { pages_crawled: pages.length, page_limit: input.pageLimit, sitemap_urls: input.sitemapUrlCount },
      target_url: root,
    });
  }

  return findings;
}
