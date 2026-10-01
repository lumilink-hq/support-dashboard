// =============================================================================
// lib.ts — pure, side-effect-free helpers for the seo-keyword-research worker
// (module 22). Same split as the other SEO edge functions.
//
// DataForSEO Labs endpoints used (Live, request/response; checked against
// docs.dataforseo.com 2026-10-01):
//   dataforseo_labs/google/keyword_overview/live → metrics for up to 700 phrases
//   dataforseo_labs/google/keyword_ideas/live    → ideas from up to 200 seeds
// Both answer in result[0].items[], each item carrying keyword_info
// (search_volume, cpc, competition_level, monthly_searches),
// keyword_properties.keyword_difficulty and search_intent_info.main_intent.
// Priced at $0.012 per request plus $0.00012 per returned item (2026-10-01).
// =============================================================================

export const LOCATION_CODE = 2840; // United States — the rank-tracking fallback too
export const LANGUAGE_CODE = "en";
export const OVERVIEW_MAX_KEYWORDS = 700; // documented per-request limit
export const OVERVIEW_MAX_CALLS = 3; // bounds one run's spend
export const MAX_SEEDS = 20;
export const IDEAS_LIMIT = 100;
export const MAX_RELATED_SUGGESTIONS = 25;
export const MAX_SEARCH_CONSOLE_SUGGESTIONS = 25;
export const STRIKING_MIN_POSITION = 8;
export const STRIKING_MAX_POSITION = 20;
export const STRIKING_MIN_IMPRESSIONS = 20;
export const KEYWORD_MAX_CHARS = 80; // DataForSEO's limit, and the suggestions table check
export const KEYWORD_MAX_WORDS = 10; // DataForSEO's limit

const INTENTS = new Set(["informational", "navigational", "commercial", "transactional"]);
const COMPETITION = new Set(["LOW", "MEDIUM", "HIGH"]);

export type KeywordMetrics = {
  keyword: string;
  search_volume: number | null;
  cpc: number | null;
  competition_level: string | null;
  keyword_difficulty: number | null;
  main_intent: string | null;
  monthly_searches: { year: number; month: number; search_volume: number }[];
};

export type QueryRow = {
  site_url: string;
  month: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number | string | null;
};

export type StrikingPick = {
  keyword: string;
  site_url: string;
  gsc_month: string;
  gsc_clicks: number;
  gsc_impressions: number;
  gsc_position: number;
};

/** Must match lib/seo-portal.ts cleanKeyword (control characters to spaces,
 * whitespace collapsed, trimmed, lower-cased), so a phrase stored here joins
 * to seo_keywords.keyword exactly. The unit tests check they agree. */
export function normalizeKeyword(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Can DataForSEO be asked about this phrase (and can it be stored as a suggestion)? */
export function isQueryable(keyword: string): boolean {
  if (keyword.length < 2 || keyword.length > KEYWORD_MAX_CHARS) return false;
  return keyword.split(" ").length <= KEYWORD_MAX_WORDS;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

export function parseItem(item: unknown): KeywordMetrics | null {
  if (!item || typeof item !== "object") return null;
  const i = item as Record<string, unknown>;
  if (typeof i.keyword !== "string") return null;
  const keyword = normalizeKeyword(i.keyword);
  if (!keyword) return null;

  const info = (i.keyword_info ?? {}) as Record<string, unknown>;
  const props = (i.keyword_properties ?? {}) as Record<string, unknown>;
  const intent = (i.search_intent_info ?? {}) as Record<string, unknown>;

  const kd = int(props.keyword_difficulty);
  const comp = typeof info.competition_level === "string" ? info.competition_level.toUpperCase() : null;
  const mainIntent = typeof intent.main_intent === "string" ? intent.main_intent.toLowerCase() : null;
  const monthly = Array.isArray(info.monthly_searches) ? (info.monthly_searches as Record<string, unknown>[]) : [];

  return {
    keyword,
    search_volume: int(info.search_volume),
    cpc: num(info.cpc),
    competition_level: comp && COMPETITION.has(comp) ? comp : null,
    keyword_difficulty: kd !== null && kd >= 0 && kd <= 100 ? kd : null,
    main_intent: mainIntent && INTENTS.has(mainIntent) ? mainIntent : null,
    monthly_searches: monthly
      .filter((m) => int(m.year) !== null && int(m.month) !== null && int(m.search_volume) !== null)
      .map((m) => ({ year: int(m.year)!, month: int(m.month)!, search_volume: int(m.search_volume)! }))
      .sort((a, b) => b.year - a.year || b.month - a.month)
      .slice(0, 12),
  };
}

/** result[0].items[] → parsed items. Tolerates a null/empty result (a phrase
 * DataForSEO has never seen comes back as no item, not an error). */
export function parseItems(result: unknown): KeywordMetrics[] {
  const first = Array.isArray(result) ? (result as Record<string, unknown>[])[0] : null;
  const items = Array.isArray(first?.items) ? (first!.items as unknown[]) : [];
  const out: KeywordMetrics[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const m = parseItem(it);
    if (m && !seen.has(m.keyword)) {
      seen.add(m.keyword);
      out.push(m);
    }
  }
  return out;
}

/** A metrics row for every phrase that was asked about, null-filled where
 * DataForSEO returned nothing, so "no row" always means "never asked" (0062's
 * pull-forward relies on that). */
export function metricsFor(asked: string[], got: KeywordMetrics[]): KeywordMetrics[] {
  const byKeyword = new Map(got.map((m) => [m.keyword, m]));
  return asked.map(
    (k) =>
      byKeyword.get(k) ?? {
        keyword: k,
        search_volume: null,
        cpc: null,
        competition_level: null,
        keyword_difficulty: null,
        main_intent: null,
        monthly_searches: [],
      },
  );
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Seeds for keyword_ideas: the tracked phrases, de-duplicated, shortest
 * first (a short head term like "plumber tulsa" yields broader ideas than a
 * long one), capped. */
export function pickSeeds(tracked: string[], max = MAX_SEEDS): string[] {
  return [...new Set(tracked.filter(isQueryable))]
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, max);
}

/** The latest month whose keyword counts are complete, per property. Module 21
 * marks a month complete once all its days hold final data. */
export function latestCompleteMonth(rows: { month: string; is_complete: boolean }[]): string | null {
  let best: string | null = null;
  for (const r of rows) if (r.is_complete && (best === null || r.month > best)) best = r.month;
  return best;
}

/**
 * Striking distance: searches the site already shows up for at an average
 * position of 8 to 20 with real impressions. Page two, or the bottom of page
 * one, is where a small push moves the most traffic. Excludes what's already
 * tracked or was dismissed, merges the same phrase across properties (keeps
 * the one with more impressions), most impressions first.
 */
export function pickStrikingDistance(
  rows: QueryRow[],
  exclude: Set<string>,
  max = MAX_SEARCH_CONSOLE_SUGGESTIONS,
): StrikingPick[] {
  const best = new Map<string, StrikingPick>();
  for (const r of rows) {
    const position = r.position === null ? null : Number(r.position);
    if (position === null || !Number.isFinite(position)) continue;
    if (position < STRIKING_MIN_POSITION || position > STRIKING_MAX_POSITION) continue;
    if (r.impressions < STRIKING_MIN_IMPRESSIONS) continue;
    const keyword = normalizeKeyword(r.query);
    if (!isQueryable(keyword) || exclude.has(keyword)) continue;
    const prev = best.get(keyword);
    if (!prev || r.impressions > prev.gsc_impressions) {
      best.set(keyword, {
        keyword,
        site_url: r.site_url,
        gsc_month: r.month,
        gsc_clicks: r.clicks,
        gsc_impressions: r.impressions,
        gsc_position: Math.round(position * 10) / 10,
      });
    }
  }
  return [...best.values()]
    .sort((a, b) => b.gsc_impressions - a.gsc_impressions || a.keyword.localeCompare(b.keyword))
    .slice(0, max);
}

/**
 * Related ideas worth showing: not tracked, not dismissed, not already a
 * Search Console suggestion, and searched at least a little (a zero-volume
 * idea is noise). Highest volume first.
 */
export function pickRelated(
  ideas: KeywordMetrics[],
  exclude: Set<string>,
  max = MAX_RELATED_SUGGESTIONS,
): KeywordMetrics[] {
  return ideas
    .filter((m) => isQueryable(m.keyword) && !exclude.has(m.keyword) && (m.search_volume ?? 0) >= 10)
    .sort((a, b) => (b.search_volume ?? 0) - (a.search_volume ?? 0) || a.keyword.localeCompare(b.keyword))
    .slice(0, max);
}
