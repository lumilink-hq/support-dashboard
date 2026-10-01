// Pure helpers for seo-search-console (module 21). No network, no Deno APIs, no
// database: the function fetches Search Analytics rows and hands them here, so
// all of this is unit-tested with scripts/test-seo-search-console.ts. The portal
// matches article URLs with the same normalisePageUrl (in insights.ts), so an
// article's URL matches the stored page row exactly.

// Dates and URL normalising live in insights.ts so the Next.js portal can import
// them without a ".ts" import path (which Deno needs and Next's TypeScript
// config rejects); re-exported here for the edge function.
import { addDays, addMonths, isoDate, monthEnd, monthStart, monthsBetween, normalisePageUrl } from "./insights.ts";
export { addDays, addMonths, isoDate, monthEnd, monthStart, monthsBetween, normalisePageUrl };

/** How many rows of each month's pages / queries are kept. Counts are taken over all rows first. */
export const TOP_ROWS_PER_MONTH = 500;
/** Search Console keeps 16 months; the first run backfills all of it. */
export const BACKFILL_MONTHS = 16;
/** Data for the last 2 to 3 days is revised, so every run re-pulls this many days before the last one held. */
export const REPULL_DAYS = 4;

// -----------------------------------------------------------------------------
// Sync window
// -----------------------------------------------------------------------------

export type SyncWindow = { start: string; end: string; backfill: boolean };

/**
 * Which dates this run asks for. Never pulled (or the backfill didn't finish):
 * everything Search Console still has, from the first day of the month 15 months
 * back (16 months including this one). Otherwise: the trailing REPULL_DAYS before
 * the last day held, so revised days are corrected, through today.
 */
export function syncWindow(
  property: { data_through: string | null; backfilled_at: string | null },
  today: string,
): SyncWindow {
  if (!property.backfilled_at || !property.data_through) {
    return { start: addMonths(today, -(BACKFILL_MONTHS - 1)), end: today, backfill: true };
  }
  const start = addDays(property.data_through, -(REPULL_DAYS - 1));
  return { start: start < today ? start : today, end: today, backfill: false };
}

// -----------------------------------------------------------------------------
// Search Analytics rows
// -----------------------------------------------------------------------------

export type ApiRow = { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number };

export type DailyRow = {
  date: string;
  device: "all" | "desktop" | "mobile" | "tablet";
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
};

const DEVICES = new Set(["desktop", "mobile", "tablet"]);

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Rows from a ["date"] or ["date","device"] query. Unknown devices are dropped, not guessed. */
export function dailyRows(rows: ApiRow[], withDevice: boolean): DailyRow[] {
  const out: DailyRow[] = [];
  for (const r of rows) {
    const date = r.keys?.[0];
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    let device: DailyRow["device"] = "all";
    if (withDevice) {
      const d = String(r.keys?.[1] ?? "").toLowerCase();
      if (!DEVICES.has(d)) continue;
      device = d as DailyRow["device"];
    }
    const impressions = Math.round(num(r.impressions));
    out.push({
      date,
      device,
      clicks: Math.round(num(r.clicks)),
      impressions,
      ctr: impressions > 0 ? round(num(r.ctr), 4) : null,
      position: impressions > 0 && r.position !== undefined ? round(num(r.position), 2) : null,
    });
  }
  return out;
}

/** The latest date in a set of daily rows, or null. */
export function latestDate(rows: { date: string }[]): string | null {
  let best: string | null = null;
  for (const r of rows) if (!best || r.date > best) best = r.date;
  return best;
}

// -----------------------------------------------------------------------------
// Monthly pages / queries
// -----------------------------------------------------------------------------

export type MonthlyRow = { key: string; clicks: number; impressions: number; position: number | null };

/**
 * Merge rows that share a key (after `normalise`), summing clicks and
 * impressions and weighting position by impressions, then keep the top `limit`
 * by clicks (impressions break ties, then the key, so the cut is stable).
 */
export function mergeTop(rows: ApiRow[], normalise: (k: string) => string, limit = TOP_ROWS_PER_MONTH): MonthlyRow[] {
  const acc = new Map<string, { clicks: number; impressions: number; posWeight: number }>();
  for (const r of rows) {
    const rawKey = r.keys?.[0];
    if (!rawKey) continue;
    const key = normalise(rawKey);
    if (!key) continue;
    const a = acc.get(key) ?? { clicks: 0, impressions: 0, posWeight: 0 };
    const imp = num(r.impressions);
    a.clicks += num(r.clicks);
    a.impressions += imp;
    a.posWeight += num(r.position) * imp;
    acc.set(key, a);
  }
  // Plain < comparison, not localeCompare: a month can have tens of thousands
  // of queries and localeCompare's cost there blew the edge runtime's CPU limit.
  return [...acc.entries()]
    .map(([key, a]) => ({
      key,
      clicks: Math.round(a.clicks),
      impressions: Math.round(a.impressions),
      position: a.impressions > 0 ? round(a.posWeight / a.impressions, 2) : null,
    }))
    .sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
    .slice(0, limit);
}

/** Queries are compared case- and space-insensitively, the way Search Console groups them. */
export function normaliseQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

export type KeywordCounts = { total: number; page_one: number; top_three: number };

/**
 * How many distinct queries showed the site in the month, and how many of them
 * averaged page one (<= 10) or the top 3 (<= 3). Counted over every query row,
 * before mergeTop trims to the top 500.
 */
export function keywordCounts(rows: ApiRow[]): KeywordCounts {
  // One pass, no sort: only the counts are needed here.
  const acc = new Map<string, { impressions: number; posWeight: number }>();
  for (const r of rows) {
    const rawKey = r.keys?.[0];
    if (!rawKey) continue;
    const key = normaliseQuery(rawKey);
    const a = acc.get(key) ?? { impressions: 0, posWeight: 0 };
    const imp = num(r.impressions);
    a.impressions += imp;
    a.posWeight += num(r.position) * imp;
    acc.set(key, a);
  }
  let total = 0, pageOne = 0, top3 = 0;
  for (const a of acc.values()) {
    if (a.impressions <= 0) continue;
    total++;
    const pos = round(a.posWeight / a.impressions, 2);
    if (pos <= 10) pageOne++;
    if (pos <= 3) top3++;
  }
  return { total, page_one: pageOne, top_three: top3 };
}

/**
 * Months whose page / query rollups are built per call, newest first. One:
 * a month can be tens of thousands of query rows, and two of those per call
 * already reached the edge runtime's CPU soft limit in a local test.
 */
export const MONTHS_PER_RUN = 1;

/**
 * The work queue for monthly rollups: what was still pending plus the months
 * this run's daily window touched (only those with data), newest first, no
 * duplicates. The caller builds the first MONTHS_PER_RUN and stores the rest.
 */
export function pendingMonths(previous: string[], touched: string[], dataThrough: string | null): string[] {
  if (!dataThrough) return [];
  const all = new Set([...previous.map((m) => monthStart(m)), ...touched.map((m) => monthStart(m))]);
  return [...all].filter((m) => m <= dataThrough).sort().reverse();
}

// -----------------------------------------------------------------------------
// API errors
// -----------------------------------------------------------------------------

export type PropertyOutcome = "ok" | "no_access" | "retry" | "fatal";

/**
 * What an HTTP status from Search Analytics means for this property.
 * 403/404: the connected account can't see this property (not verified, wrong
 * URL form, e.g. "https://x.com/" vs "sc-domain:x.com"); recorded, not retried
 * every hour. 401: the token is bad; the whole run is retried after the token
 * refresh job runs. 429/5xx: transient, backed off.
 */
export function classifyStatus(status: number): PropertyOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 403 || status === 404) return "no_access";
  if (status === 401 || status === 429 || status >= 500) return "retry";
  return "fatal";
}

/** Backoff before retry `attempt` (0-based) of a vendor call: 1 s, 2 s, 4 s. */
export function backoffMs(attempt: number): number {
  return 1000 * 2 ** attempt;
}
