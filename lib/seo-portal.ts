// Pure shaping helpers for the SEO portal page (module 10). No I/O: the page
// fetches rows under the caller's RLS and hands them here, so the arithmetic is
// unit-tested (scripts/test-seo-portal.ts) without a browser or a database.

export type ClientRank = { keyword_id: string; position: number | null; check_date: string };
export type CompetitorRank = { competitor_id: string; keyword_id: string; position: number | null; check_date: string };
export type Competitor = { id: string; domain: string; label: string | null };

export type DomainStanding = {
  key: string;
  label: string;
  isClient: boolean;
  /** Keywords this domain was checked on (in the shared window). */
  checked: number;
  ranked: number;
  top10: number;
  avgPosition: number | null;
};

/** The newest row per (group, keyword), so a weekly series collapses to "where things stand now". */
export function latestPerKeyword<T extends { keyword_id: string; check_date: string }>(
  rows: T[],
  group: (r: T) => string = () => "",
): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const k = `${group(r)}|${r.keyword_id}`;
    const cur = best.get(k);
    if (!cur || r.check_date > cur.check_date) best.set(k, r);
  }
  return [...best.values()];
}

function stand(key: string, label: string, isClient: boolean, rows: { position: number | null }[]): DomainStanding {
  const found = rows.filter((r) => r.position !== null).map((r) => r.position as number);
  return {
    key,
    label,
    isClient,
    checked: rows.length,
    ranked: found.length,
    top10: found.filter((p) => p <= 10).length,
    avgPosition: found.length ? Math.round((found.reduce((a, b) => a + b, 0) / found.length) * 10) / 10 : null,
  };
}

/**
 * The client against each tracked competitor on the latest organic check per
 * keyword. Competitors are only ever compared on keywords the client was also
 * checked on, so a competitor tracked on more keywords can't look better by
 * having been measured more.
 */
export function compareToCompetitors(
  clientName: string,
  clientRows: ClientRank[],
  competitors: Competitor[],
  competitorRows: CompetitorRank[],
): DomainStanding[] {
  const clientLatest = latestPerKeyword(clientRows);
  const shared = new Set(clientLatest.map((r) => r.keyword_id));
  const out: DomainStanding[] = [stand("client", clientName, true, clientLatest)];
  const latest = latestPerKeyword(competitorRows.filter((r) => shared.has(r.keyword_id)), (r) => r.competitor_id);
  for (const c of competitors) {
    out.push(stand(c.id, c.label || c.domain, false, latest.filter((r) => r.competitor_id === c.id)));
  }
  return out;
}

export type TrendRow = { rank_type: string; check_date: string; avg_position: number | null };

export function trendPoints(rows: TrendRow[], type: "organic" | "local_pack") {
  return rows
    .filter((r) => r.rank_type === type)
    .sort((a, b) => a.check_date.localeCompare(b.check_date))
    .map((r) => ({ x: r.check_date, y: r.avg_position === null ? null : Number(r.avg_position) }));
}

export type Mention = { query_id: string; platform: string; cited_count: number; check_date: string };

export const PLATFORM_LABELS: Record<string, string> = {
  google: "Google AI Overviews",
  chat_gpt: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
  claude: "Claude",
};

/** Short names for per-question badges, in display order. */
export const PLATFORM_SHORT: [string, string][] = [
  ["google", "Google"],
  ["chat_gpt", "ChatGPT"],
  ["perplexity", "Perplexity"],
  ["gemini", "Gemini"],
  ["claude", "Claude"],
];

/** Cited / checked over the rows given, overall and per platform. Zero checks is not zero visibility. */
export function aiSummary(mentions: Mention[]) {
  const per = new Map<string, { checks: number; cited: number }>();
  for (const m of mentions) {
    const p = per.get(m.platform) ?? { checks: 0, cited: 0 };
    p.checks += 1;
    if (m.cited_count > 0) p.cited += 1;
    per.set(m.platform, p);
  }
  const platforms = [...per.entries()].map(([platform, v]) => ({ platform, label: PLATFORM_LABELS[platform] ?? platform, ...v }));
  return {
    checks: mentions.length,
    cited: mentions.filter((m) => m.cited_count > 0).length,
    platforms,
  };
}

/** Clean a client-typed AI question: one line, single spaces, no control characters. */
export function cleanQuery(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

export const QUERY_MIN = 2;
export const QUERY_MAX = 250; // mirrors seo_ai_queries' CHECK (0053)

/**
 * Keyword caps, per location. Every active keyword is one DataForSEO rank
 * check a week (plus competitor positions from the same result); a map-grid
 * keyword adds 25 more (the 5x5 grid). Without a cap one location could
 * multiply the weekly vendor bill. No plan promises a number, so these are
 * cost guards, not a product limit; raise them freely.
 */
export const MAX_KEYWORDS_PER_LOCATION = 25;
export const MAX_GEO_GRID_KEYWORDS_PER_LOCATION = 3;
export const KEYWORD_MIN = 2;
export const KEYWORD_MAX = 80; // a search phrase, not a sentence

/** A tracked search phrase: same cleanup as a question, and lowercased, so
 * "Plumber Tulsa" and "plumber tulsa" are one keyword (search is case-blind). */
export function cleanKeyword(raw: string): string {
  return cleanQuery(raw).toLowerCase();
}

/** ISO date `days` ago (UTC), for "recent window" filters. */
export function daysAgo(days: number, now = new Date()): string {
  const d = new Date(now.getTime() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

export const MAX_COMPETITORS_PER_LOCATION = 5; // plan.md: "up to 5"

/**
 * A competitor's bare hostname from whatever a person pastes ("https://www.Rival.com/about"),
 * or null if it isn't a plausible public domain. Stricter than onboarding's inline
 * cleanup: the value is later sent to the SERP vendor and shown back in reports.
 */
export function cleanDomain(raw: string): string | null {
  const input = raw.trim();
  if (!input || input.length > 253) return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
    const ok = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host);
    return ok ? host : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Module 21: the tabbed layout, content output and article results
// -----------------------------------------------------------------------------

export const SEO_TABS = ["overview", "keywords", "ai", "map", "links", "work", "settings"] as const;
export type SeoTab = (typeof SEO_TABS)[number];

export const SEO_TAB_LABELS: Record<SeoTab, string> = {
  overview: "Overview",
  keywords: "Keywords",
  ai: "AI answers",
  map: "Map & locations",
  links: "Links",
  work: "Work & next",
  // Location settings and job status (2026-10-09).
  settings: "Settings",
};

/** An unknown or missing ?tab= is the Overview, never an error page. */
export function parseTab(raw: string | undefined): SeoTab {
  return (SEO_TABS as readonly string[]).includes(raw ?? "") ? (raw as SeoTab) : "overview";
}

/** ?compare=mom switches every tile to month over month; anything else is year over year. */
export function parseCompare(raw: string | undefined): "yoy" | "mom" {
  return raw === "mom" ? "mom" : "yoy";
}

export type PublishedAction = { action_type: string; target_url: string | null; published_at: string; title?: string | null };

/** Articles and other changes that went live, per month, for the months given (first days, oldest first). */
export function contentByMonth(actions: PublishedAction[], months: string[]): { month: string; articles: number; changes: number }[] {
  return months.map((m) => {
    const inMonth = actions.filter((a) => a.published_at.slice(0, 7) === m.slice(0, 7));
    const articles = inMonth.filter((a) => a.action_type === "content_publish").length;
    return { month: m, articles, changes: inMonth.length - articles };
  });
}

export type PageMonth = { page: string; month: string; clicks: number; impressions: number; position: number | null };

export type ArticleResult = {
  title: string;
  url: string;
  published_at: string;
  /** null = the page hasn't appeared in the top pages Search Console reported for any month since. */
  clicks: number | null;
  impressions: number | null;
  position: number | null;
};

/**
 * Each published article against its search results since the month it went
 * live, by normalised URL. Only the top 500 pages a month are stored, so an
 * article that never made that cut shows "no search data yet", not zero.
 */
export function articleResults(
  articles: { title: string; url: string; normalised: string; published_at: string }[],
  pages: PageMonth[],
): ArticleResult[] {
  return articles.map((a) => {
    const from = `${a.published_at.slice(0, 7)}-01`;
    const rows = pages.filter((p) => p.page === a.normalised && p.month >= from);
    if (rows.length === 0) return { title: a.title, url: a.url, published_at: a.published_at, clicks: null, impressions: null, position: null };
    const clicks = rows.reduce((s, r) => s + r.clicks, 0);
    const impressions = rows.reduce((s, r) => s + r.impressions, 0);
    const posW = rows.reduce((s, r) => s + (r.position === null ? 0 : Number(r.position) * r.impressions), 0);
    return {
      title: a.title,
      url: a.url,
      published_at: a.published_at,
      clicks,
      impressions,
      position: impressions > 0 ? Math.round((posW / impressions) * 10) / 10 : null,
    };
  });
}

// -----------------------------------------------------------------------------
// Keyword research (module 22)
// -----------------------------------------------------------------------------

export type KeywordStats = {
  keyword: string;
  search_volume: number | null;
  cpc: number | string | null;
  keyword_difficulty: number | null;
};

export type KeywordSuggestion = KeywordStats & {
  id: string;
  source: "search_console" | "related";
  gsc_impressions: number | null;
  gsc_clicks: number | null;
  gsc_position: number | string | null;
  gsc_month: string | null;
};

/** DataForSEO's 0–100 keyword difficulty in words. The bands follow the
 * usual reading of the scale (under 30 a new page can rank, 60+ needs links). */
export function difficultyLabel(kd: number | null): string | null {
  if (kd === null) return null;
  if (kd < 30) return "Easy";
  if (kd < 60) return "Medium";
  return "Hard";
}

/** "880 searches a month · difficulty 34 (medium) · $21.37 a click", leaving
 * out whatever is unknown. Null when nothing is known. */
export function keywordStatsLine(s: KeywordStats | undefined): string | null {
  if (!s) return null;
  const parts: string[] = [];
  if (s.search_volume !== null) parts.push(`${s.search_volume.toLocaleString("en-US")} searches a month`);
  const label = difficultyLabel(s.keyword_difficulty);
  if (label) parts.push(`difficulty ${s.keyword_difficulty} (${label.toLowerCase()})`);
  const cpc = s.cpc === null ? null : Number(s.cpc);
  if (cpc !== null && Number.isFinite(cpc) && cpc > 0) parts.push(`$${cpc.toFixed(2)} a click`);
  return parts.length ? parts.join(" · ") : null;
}

/** Open suggestions for the location on screen: drops what's already tracked
 * there, Search Console evidence first (most impressions), then related ideas
 * (most searched). */
export function splitSuggestions(
  rows: KeywordSuggestion[],
  trackedHere: Set<string>,
): { searchConsole: KeywordSuggestion[]; related: KeywordSuggestion[] } {
  const open = rows.filter((r) => !trackedHere.has(r.keyword));
  return {
    searchConsole: open
      .filter((r) => r.source === "search_console")
      .sort((a, b) => (b.gsc_impressions ?? 0) - (a.gsc_impressions ?? 0) || a.keyword.localeCompare(b.keyword)),
    related: open
      .filter((r) => r.source === "related")
      .sort((a, b) => (b.search_volume ?? 0) - (a.search_volume ?? 0) || a.keyword.localeCompare(b.keyword)),
  };
}

// -----------------------------------------------------------------------------
// Site audit summary (module 24)
// -----------------------------------------------------------------------------

/** Plain names for finding types, as an issue across pages. A type not listed
 * falls back to the finding's own title. */
export const ISSUE_LABELS: Record<string, string> = {
  missing_title: "Pages with no title",
  title_length: "Titles too short or too long",
  duplicate_title: "Titles shared with other pages",
  missing_meta_description: "Pages with no meta description",
  meta_description_length: "Meta descriptions too short or too long",
  duplicate_meta_description: "Meta descriptions shared with other pages",
  missing_h1: "Pages with no main heading (H1)",
  multiple_h1: "Pages with more than one H1",
  missing_local_business_schema: "No LocalBusiness structured data",
  images_missing_alt: "Pages with images missing alt text",
  thin_content: "Pages with very little text",
  phone_not_on_page: "Phone number not on the page",
  address_not_on_page: "Street address not on the page",
  store_page_unreachable: "Store page is broken",
  store_page_needs_javascript: "Store page is empty without JavaScript",
  store_page_not_linked_from_homepage: "Homepage doesn't link to the store page",
  store_page_not_set: "No store page set",
  broken_internal_links: "Pages linking to broken pages on your site",
  internal_links_redirect: "Pages linking through redirects",
  broken_outbound_links: "Pages linking to dead pages on other sites",
  multiple_canonicals: "Pages with more than one canonical URL",
  canonical_other_site: "Canonical URL points to another website",
  canonical_target_not_ok: "Canonical URL is broken or redirects",
  pages_missing_canonical: "Pages with no canonical tag",
  noindex_in_sitemap: "Sitemap pages hidden from Google (noindex)",
  sitemap_url_not_ok: "Sitemap lists broken or redirecting URLs",
  orphan_page: "Pages nothing links to",
  weakly_linked_pages: "Pages linked from only one other page",
  crawl_page_limit_reached: "Site is bigger than the audit's page limit",
  robots_disallowed: "robots.txt blocks the audit",
  crawl_fetch_failed: "Site couldn't be fetched",
  javascript_rendered_site: "Site needs JavaScript to show content",
  javascript_rendered_site_audited_via_render: "Site needed a headless browser to audit",
  backlinks_to_broken_page: "Broken pages other sites still link to",
};

export type FindingRow = { finding_type: string; severity: string; title: string; target_url: string | null };

export type IssueGroup = { type: string; label: string; severity: "critical" | "warning" | "info"; count: number; pages: string[] };

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

/** Open findings grouped by type: worst severity first, then most pages. */
export function summarizeFindings(rows: FindingRow[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const r of rows) {
    const sev = (r.severity in SEVERITY_RANK ? r.severity : "info") as IssueGroup["severity"];
    const g = groups.get(r.finding_type) ?? { type: r.finding_type, label: ISSUE_LABELS[r.finding_type] ?? r.title, severity: sev, count: 0, pages: [] };
    g.count++;
    if (SEVERITY_RANK[sev] < SEVERITY_RANK[g.severity]) g.severity = sev;
    if (r.target_url && !g.pages.includes(r.target_url)) g.pages.push(r.target_url);
    groups.set(r.finding_type, g);
  }
  return [...groups.values()].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Module 29: on a website shared by several locations, the site's primary
 * location holds the findings for pages every store shares, and each location
 * holds its own store page's (scope 'store'). `site` is what the website
 * section shows, `store` what "this store's page" shows. A website with one
 * location shows everything as the website's, as before.
 */
export function splitSiteFindings<T extends { location_id: string; scope: string | null }>(
  rows: T[],
  opts: { shared: boolean; primaryId: string; locationId: string },
): { site: T[]; store: T[] } {
  if (!opts.shared) return { site: rows.filter((r) => r.location_id === opts.locationId), store: [] };
  return {
    site: rows.filter((r) => r.location_id === opts.primaryId && r.scope !== "store"),
    store: rows.filter((r) => r.location_id === opts.locationId && r.scope === "store"),
  };
}

/** "packsclub.com" for "https://www.packsclub.com/x"; null if not a URL. */
export function hostOf(url: string | null | undefined): string | null {
  try {
    return new URL(url ?? "").host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** A Search Console property as people know it: "sc-domain:acme.com" and
 *  "https://www.acme.com/" both read "acme.com". */
export function siteLabel(site: string): string {
  const s = site.trim();
  if (s.startsWith("sc-domain:")) return s.slice("sc-domain:".length);
  return hostOf(s) ?? s;
}

/** "/services/drains" for a URL on the site, the full URL otherwise. */
export function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

// -----------------------------------------------------------------------------
// AI share of voice (module 25)
// -----------------------------------------------------------------------------

export type SovRow = { query_id: string; platform: string; domain: string; is_client: boolean; cited_count: number; check_date: string };

export type SovSite = { domain: string; is_client: boolean; cited: number; checked: number };

/**
 * For each site, on the latest check of every (question, platform): how many
 * of those checks cited it. Counting "checks that cited" rather than raw
 * mention counts puts both methods (a count of answers on Google/ChatGPT, one
 * live answer on the others) on the same footing. Client first on ties.
 */
export function shareOfVoice(rows: SovRow[]): SovSite[] {
  const latest = new Map<string, SovRow>();
  for (const r of rows) {
    const k = `${r.query_id}|${r.platform}|${r.domain}`;
    const prev = latest.get(k);
    if (!prev || r.check_date > prev.check_date) latest.set(k, r);
  }
  const sites = new Map<string, SovSite>();
  for (const r of latest.values()) {
    const s = sites.get(r.domain) ?? { domain: r.domain, is_client: r.is_client, cited: 0, checked: 0 };
    s.checked++;
    if (r.cited_count > 0) s.cited++;
    s.is_client = s.is_client || r.is_client;
    sites.set(r.domain, s);
  }
  return [...sites.values()].sort((a, b) => b.cited - a.cited || Number(b.is_client) - Number(a.is_client) || a.domain.localeCompare(b.domain));
}

/** "A", "A and B", "A, B and C". */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
