// =============================================================================
// stores.ts — module 29 (plan.md): several locations sharing one website.
//
// A client like PACKS has four stores on one site (packsclub.com), each with
// its own store page (/menu/orange-county, ...). The website is audited ONCE,
// by the site's PRIMARY location (the oldest active one, same order as 0070's
// seo_site_locations view), and each store is checked on its OWN store page:
//
//   site-wide  — every page that isn't a store page: findings go to the
//                primary location, drafts use the brand name only.
//   store page — the location's store_page_url (or, for a site with a single
//                location and no store page, the homepage): the LocalBusiness
//                schema, phone and street-address rules run here with THAT
//                store's details, and its findings go to that location.
//
// Also the "path to the store" rules: is each store page linked from the
// homepage, can it be fetched, and does it have readable text without
// JavaScript (a menu embedded by script reads as an empty page to Google).
//
// No Deno, no network, no database: imported by seo-crawl, seo-technical-audit,
// seo-draft and seo-link-opportunities, unit-tested in
// scripts/test-seo-shared-sites.ts. A change here means redeploying all four.
// =============================================================================

import { decodeEntities, normalizeUrl, type CrawlFinding } from "./lib.ts";

/** A page this short without JavaScript has, for Google, no content. Same bar
 * seo-crawl uses to call a homepage JavaScript-rendered. */
export const STORE_PAGE_MIN_WORDS = 40;

export type SiteMember = {
  id: string;
  name: string | null;
  website_url: string | null;
  store_page_url: string | null;
  created_at: string;
};

/** The website a URL belongs to: its host, lower-case, without a leading www.
 * and without a default port. Mirrors 0070's seo_site_key(). Null if it isn't
 * an http(s) URL. A bare "acme.com" is read as https://acme.com. */
export function siteKey(url: string | null | undefined): string | null {
  const u = parseHttp(url);
  return u ? u.host.toLowerCase().replace(/^www\./, "") || null : null;
}

function parseHttp(url: string | null | undefined): URL | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  try {
    // "mailto:x" or "ftp://x" has a scheme; "acme.com:8080/x" doesn't.
    const u = new URL(/^[a-z][a-z0-9+.-]*:[^0-9]/i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** One page of a site, ignoring www., http vs https, a trailing slash, the
 * fragment and tracking parameters, so a store page set as
 * "https://packsclub.com/menu/oc/" matches the crawled
 * "https://www.packsclub.com/menu/oc". */
export function pageKey(url: string | null | undefined): string | null {
  const parsed = parseHttp(url);
  if (!parsed) return null;
  const u = new URL(normalizeUrl(parsed.href));
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${u.host.toLowerCase().replace(/^www\./, "")}${path}${u.search}`;
}

/** Oldest first, then id: the same order as the SQL view, so the edge
 * functions and the scheduler agree on which location is primary. */
function byAge(a: SiteMember, b: SiteMember): number {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

export type SiteGroup<T extends SiteMember> = {
  key: string;
  primary: T;
  /** Every active location on this website, primary first. */
  members: T[];
  shared: boolean;
};

/** The locations sharing `loc`'s website, out of the client's active
 * locations (`all`, which may or may not include `loc`). Null when `loc` has
 * no usable website. */
export function siteGroup<T extends SiteMember>(all: T[], loc: T): SiteGroup<T> | null {
  const key = siteKey(loc.website_url);
  if (!key) return null;
  const byId = new Map<string, T>();
  for (const m of [...all, loc]) if (siteKey(m.website_url) === key) byId.set(m.id, m);
  const members = [...byId.values()].sort(byAge);
  return { key, primary: members[0], members, shared: members.length > 1 };
}

/** Each location's store page on the site, keyed by pageKey. A location whose
 * store page is on another site, or isn't set, has none, except that a site
 * with a single location uses its homepage (`rootUrl`) as before. */
export function storePageMap<T extends SiteMember>(group: SiteGroup<T>, rootUrl: string | null): Map<string, T> {
  const out = new Map<string, T>();
  for (const m of group.members) {
    const k = pageKey(m.store_page_url);
    if (k && siteKey(m.store_page_url) === group.key && !out.has(k)) out.set(k, m);
  }
  if (!group.shared && out.size === 0) {
    const k = pageKey(rootUrl ?? group.primary.website_url);
    if (k) out.set(k, group.primary);
  }
  return out;
}

/** The store page `url` belongs to, if any (also matching its redirect target). */
export function storeFor<T extends SiteMember>(stores: Map<string, T>, url: string, finalUrl?: string | null): T | null {
  const k = pageKey(url);
  if (k && stores.has(k)) return stores.get(k)!;
  const f = finalUrl ? pageKey(finalUrl) : null;
  return f && stores.has(f) ? stores.get(f)! : null;
}

// -----------------------------------------------------------------------------
// Store-page rules
// -----------------------------------------------------------------------------

const STREET_NOISE = new Set([
  "n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west",
  "st", "street", "rd", "road", "ave", "avenue", "blvd", "boulevard", "dr", "drive",
  "ln", "lane", "way", "ct", "court", "pl", "place", "pkwy", "parkway", "hwy", "highway",
  "ste", "suite", "unit", "apt", "fl", "floor",
]);

/** The two parts of a street address that survive any way of writing it: the
 * house number and the street's name word ("2840 S Croddy Way" -> 2840 +
 * "croddy"; "South Croddy Way" on the page still matches). Null if the
 * address has no number or no name word. */
export function streetParts(addressLine1: string | null | undefined): { number: string; word: string } | null {
  const tokens = (addressLine1 ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const number = tokens.find((t) => /^\d+[a-z]?$/.test(t));
  if (!number) return null;
  const words = tokens.filter((t) => t !== number && !/^\d/.test(t) && !STREET_NOISE.has(t) && t.length > 1);
  if (!words.length) return null;
  // The longest is the most distinctive ("croddy" over "old" in "Old Croddy Rd").
  const word = words.reduce((a, b) => (b.length > a.length ? b : a));
  return { number: number.replace(/[a-z]$/, ""), word };
}

function visibleText(html: string): string {
  return decodeEntities(
    (html ?? "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// -----------------------------------------------------------------------------
// Page text kept for module 30 (suggested location details)
// -----------------------------------------------------------------------------

/** Characters of text / JSON-LD kept per page. Mirrors 0071's checks. */
export const PAGE_TEXT_MAX = 20_000;

/** Pages likely to state facts about the business (about, locations, FAQ…). */
const FACT_PATH = /\/(about|about-us|our-story|story|who-we-are|locations?|stores?|visit|faq|faqs|contact|contact-us)(\/|$|-)|location/i;

/** Should the crawl keep this page's text? Store pages and the homepage
 * always; otherwise a page whose path looks like it states facts. */
export function keepPageText(url: string, opts: { isStore: boolean; isRoot: boolean }): boolean {
  if (opts.isStore || opts.isRoot) return true;
  try {
    return FACT_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** The page as a reader sees it: no scripts, styles or tags; block elements
 * become line breaks; entities decoded; capped. Case is kept. */
export function readableText(html: string, max = PAGE_TEXT_MAX): string {
  const s = decodeEntities(
    (html ?? "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(head|script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|p|div|li|h[1-6]|tr|section|article|header|footer|nav|ul|ol|table)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim();
  return s.slice(0, max);
}

/** The page's JSON-LD blocks that parse, whole, while they fit in `max`
 * characters together. Null when there are none. */
export function jsonLdBlocks(html: string, max = PAGE_TEXT_MAX): unknown[] | null {
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const out: unknown[] = [];
  let size = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html ?? "")) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const n = JSON.stringify(parsed).length;
    if (size + n > max) continue;
    size += n;
    out.push(parsed);
  }
  return out.length ? out : null;
}

/** Does the page's visible text carry this street address (number and name)? */
export function pageContainsAddress(html: string, addressLine1: string | null | undefined): boolean {
  const parts = streetParts(addressLine1);
  if (!parts) return false;
  const text = visibleText(html);
  return new RegExp(`\\b${parts.number}\\b`).test(text) && new RegExp(`\\b${parts.word}\\b`).test(text);
}

export type StoreForRules = { address_line1: string | null; name: string | null };

/**
 * Rules for ONE store's page, on top of the page rules (title, schema, phone)
 * seo-crawl already runs on it. `shared` is false for a single-location site
 * auditing its homepage, where only the address rule applies.
 */
export function auditStorePage(
  page: { html: string | null; status: number; wordCount: number | null },
  store: StoreForRules,
  opts: { shared: boolean },
): CrawlFinding[] {
  const out: CrawlFinding[] = [];
  if (page.html === null) {
    if (opts.shared) {
      out.push({
        finding_type: "store_page_unreachable",
        severity: "critical",
        title: page.status ? `This store's page answers with HTTP ${page.status}` : "This store's page couldn't be fetched",
        details: { status: page.status },
      });
    }
    return out;
  }
  if (opts.shared && (page.wordCount ?? 0) < STORE_PAGE_MIN_WORDS) {
    out.push({
      finding_type: "store_page_needs_javascript",
      severity: "warning",
      title: `This store's page shows only ${page.wordCount ?? 0} words without JavaScript, so Google may see it as empty`,
      details: { word_count: page.wordCount ?? 0 },
    });
  }
  if (streetParts(store.address_line1) && !pageContainsAddress(page.html, store.address_line1)) {
    out.push({
      finding_type: "address_not_on_page",
      severity: "warning",
      title: "This location's street address doesn't appear on its page",
      details: { address: store.address_line1 },
    });
  }
  return out;
}

/** A store page the homepage doesn't link to. `rootLinks` are the homepage's
 * internal links, already normalised by extractLinks. */
export function storeLinkedFromHome(rootLinks: string[], storePageUrl: string): boolean {
  const want = pageKey(storePageUrl);
  return !!want && rootLinks.some((l) => pageKey(l) === want);
}

export function notLinkedFinding(): CrawlFinding {
  return {
    finding_type: "store_page_not_linked_from_homepage",
    severity: "warning",
    title: "The homepage doesn't link to this store's page",
    details: {},
  };
}

export function noStorePageFinding(): CrawlFinding {
  return {
    finding_type: "store_page_not_set",
    severity: "info",
    title: "No store page is set for this location, so its page-level checks were skipped",
    details: {},
  };
}

// -----------------------------------------------------------------------------
// Drafting facts
// -----------------------------------------------------------------------------

export type DraftFacts = {
  name: string | null;
  city: string | null;
  region: string | null;
};

/**
 * Facts for a page-fix draft. On a shared website, a page that isn't this
 * location's store page belongs to every store, so it gets the brand name and
 * no city; the region only if every store shares it. Otherwise the location's
 * own facts, as before.
 */
export function draftFactsFor<T extends SiteMember & DraftFacts>(
  loc: T,
  group: SiteGroup<T> | null,
  targetUrl: string | null,
  brandName: string | null,
): { facts: DraftFacts; scope: "site" | "store" } {
  if (!group?.shared) return { facts: { name: loc.name, city: loc.city, region: loc.region }, scope: "store" };
  const own = pageKey(loc.store_page_url);
  if (own && targetUrl && pageKey(targetUrl) === own) {
    return { facts: { name: loc.name, city: loc.city, region: loc.region }, scope: "store" };
  }
  const regions = new Set(group.members.map((m) => (m.region ?? "").trim()).filter(Boolean));
  return {
    facts: { name: brandName?.trim() || loc.name, city: null, region: regions.size === 1 ? [...regions][0] : null },
    scope: "site",
  };
}
