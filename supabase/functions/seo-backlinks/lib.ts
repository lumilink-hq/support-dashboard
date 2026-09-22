// =============================================================================
// lib.ts — pure, side-effect-free helpers for the seo-backlinks worker
// (module 15). Same split as the other SEO edge functions.
//
// DataForSEO Backlinks endpoints used (all Live, request/response):
//   summary/live                        → totals for the domain
//   timeseries_new_lost_summary/live    → gained/lost for the last complete month
//   domain_pages_summary/live           → top linked pages
// =============================================================================

export type BacklinkSummary = {
  referring_domains: number | null;
  total_backlinks: number | null;
  rank: number | null;
};

export type NewLostMonth = {
  gained_count: number | null;
  lost_count: number | null;
  new_referring_domains: number | null;
  lost_referring_domains: number | null;
  period: string | null;
};

export type TopPage = { url: string; backlinks: number; referring_domains: number };

/** Bare hostname ("acme.com") — what DataForSEO's `target` wants: no
 * protocol, no www, no path. Null for anything unparseable. */
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

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseSummary(result: Record<string, unknown> | null | undefined): BacklinkSummary {
  return {
    referring_domains: num(result?.referring_domains),
    total_backlinks: num(result?.backlinks),
    rank: num(result?.rank),
  };
}

/** The most recent COMPLETE calendar month before `today`, as yyyy-mm-dd
 * bounds. The current month is partial, so gained/lost for it would read as
 * a misleadingly low number. */
export function lastCompleteMonth(today: Date): { from: string; to: string } {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth(); // 0-based, current month
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(first), to: iso(last) };
}

/** Picks the requested month's row out of a timeseries result. Tolerates the
 * items being nested under result[0].items or sitting directly in the array,
 * and takes the row whose date falls in `fromDate`'s month. Null-filled when
 * the month isn't present rather than reporting a fake zero. */
export function parseNewLost(result: unknown, fromDate: string): NewLostMonth {
  const empty: NewLostMonth = {
    gained_count: null,
    lost_count: null,
    new_referring_domains: null,
    lost_referring_domains: null,
    period: null,
  };
  const first = Array.isArray(result) ? (result as Record<string, unknown>[])[0] : null;
  const items = (Array.isArray(first?.items) ? first!.items : Array.isArray(result) ? result : []) as Record<string, unknown>[];
  const month = fromDate.slice(0, 7);
  const row = items.find((i) => typeof i.date === "string" && (i.date as string).slice(0, 7) === month);
  if (!row) return empty;
  return {
    gained_count: num(row.new_backlinks),
    lost_count: num(row.lost_backlinks),
    new_referring_domains: num(row.new_referring_domains),
    lost_referring_domains: num(row.lost_referring_domains),
    period: row.date as string,
  };
}

export function parseTopPages(result: unknown, limit = 10): TopPage[] {
  const first = Array.isArray(result) ? (result as Record<string, unknown>[])[0] : null;
  const items = (Array.isArray(first?.items) ? first!.items : []) as Record<string, unknown>[];
  return items
    .filter((i) => typeof i.url === "string" && num(i.backlinks) !== null)
    .map((i) => ({
      url: i.url as string,
      backlinks: i.backlinks as number,
      referring_domains: num(i.referring_domains) ?? 0,
    }))
    .sort((a, b) => b.backlinks - a.backlinks)
    .slice(0, limit);
}

/** DataForSEO answers an un-subscribed Backlinks call with an access-denied
 * status (documented as 40204) and a message pointing at the subscription
 * page. Match on either so a code change on their side doesn't hide it. */
export function isNotSubscribedError(statusCode: number | undefined, message: string | undefined): boolean {
  if (statusCode === 40204) return true;
  return /subscri|access denied/i.test(message ?? "");
}
