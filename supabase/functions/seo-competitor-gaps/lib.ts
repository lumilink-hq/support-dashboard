// =============================================================================
// lib.ts — pure, side-effect-free helpers for the seo-competitor-gaps worker
// (module 23). Same split as the other SEO edge functions.
//
// DataForSEO Labs endpoint (Live; checked against docs.dataforseo.com
// 2026-10-01): dataforseo_labs/google/domain_intersection/live with
//   target1 = the competitor, target2 = the client's site,
//   intersections = false  → "keywords target1 ranks for and target2 doesn't".
// Each item: keyword_data { keyword, keyword_info, keyword_properties,
// search_intent_info } (the same shape as a keyword_overview item, so module
// 22's parser reads it) and first_domain_serp_element { type, rank_group,
// rank_absolute, url, etv, ... }. Up to 1,000 items, 8 filters. Priced like
// the other Labs endpoints: $0.012 a request plus $0.00012 an item.
// =============================================================================

import { isQueryable, type KeywordMetrics, parseItem } from "../seo-keyword-research/lib.ts";

export const LOCATION_CODE = 2840; // United States, as module 22
export const LANGUAGE_CODE = "en";
export const GAP_LIMIT = 100; // per competitor; the most-searched first
export const MAX_COMPETITOR_POSITION = 20;
export const MIN_SEARCH_VOLUME = 10;

export type GapItem = KeywordMetrics & {
  competitor_position: number;
  competitor_url: string | null;
};

/** Bare hostname ("acme.com"), no www, no path — what `target1/2` want. Null
 * for anything unparseable or dotless. Same rule as seo-backlinks. */
export function targetDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    const host = new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

/**
 * The brand part of a domain, letters and digits only: "rotorooter.com" →
 * "rotorooter", "www.mr-rooter.com" → "mrrooter", "acme.co.uk" → "acme".
 * Used to drop a competitor's own brand searches ("roto rooter coupons"),
 * which no article of ours can win. Null when too short to match safely.
 */
export function brandToken(domain: string): string | null {
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return null;
  labels.pop(); // TLD
  if (labels.length >= 2 && SECOND_LEVEL.has(labels[labels.length - 1])) labels.pop();
  const token = (labels[labels.length - 1] ?? "").replace(/[^a-z0-9]/g, "");
  return token.length >= 4 ? token : null;
}

/** Does the phrase contain the brand, ignoring spaces and punctuation
 * ("roto rooter" matches "rotorooter")? */
export function isBranded(keyword: string, token: string | null): boolean {
  if (!token) return false;
  return keyword.toLowerCase().replace(/[^a-z0-9]/g, "").includes(token);
}

/** The documented request body for one competitor. Filters keep the response
 * (and the per-item cost) to positions 1–20 with real search volume. */
export function gapRequest(competitor: string, target: string): Record<string, unknown> {
  return {
    target1: competitor,
    target2: target,
    intersections: false,
    location_code: LOCATION_CODE,
    language_code: LANGUAGE_CODE,
    item_types: ["organic"],
    filters: [
      ["first_domain_serp_element.rank_group", "<=", MAX_COMPETITOR_POSITION],
      "and",
      ["keyword_data.keyword_info.search_volume", ">=", MIN_SEARCH_VOLUME],
    ],
    order_by: ["keyword_data.keyword_info.search_volume,desc"],
    limit: GAP_LIMIT,
  };
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

/** result[0].items[] → gap items. An item without a usable keyword or a
 * competitor position is skipped, not guessed. */
export function parseGapItems(result: unknown): GapItem[] {
  const first = Array.isArray(result) ? (result as Record<string, unknown>[])[0] : null;
  const items = Array.isArray(first?.items) ? (first!.items as unknown[]) : [];
  const out: GapItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    const metrics = parseItem(it.keyword_data);
    const serp = (it.first_domain_serp_element ?? {}) as Record<string, unknown>;
    const position = int(serp.rank_group) ?? int(serp.rank_absolute);
    if (!metrics || position === null || position < 1 || position > 100) continue;
    out.push({
      ...metrics,
      competitor_position: position,
      competitor_url: typeof serp.url === "string" ? serp.url : null,
    });
  }
  return out;
}

/**
 * What's worth keeping: queryable phrases within the top 20, with search
 * volume, that aren't navigational and don't contain the competitor's (or
 * our own) brand. Duplicates keep the competitor's best position. Most
 * searched first.
 */
export function filterGaps(items: GapItem[], brandTokens: (string | null)[]): GapItem[] {
  const best = new Map<string, GapItem>();
  for (const g of items) {
    if (!isQueryable(g.keyword)) continue;
    if (g.competitor_position > MAX_COMPETITOR_POSITION) continue;
    if ((g.search_volume ?? 0) < MIN_SEARCH_VOLUME) continue;
    if (g.main_intent === "navigational") continue;
    if (brandTokens.some((t) => isBranded(g.keyword, t))) continue;
    const prev = best.get(g.keyword);
    if (!prev || g.competitor_position < prev.competitor_position) best.set(g.keyword, g);
  }
  return [...best.values()].sort(
    (a, b) => (b.search_volume ?? 0) - (a.search_volume ?? 0) || a.keyword.localeCompare(b.keyword),
  );
}
