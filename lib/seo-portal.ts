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

export const PLATFORM_LABELS: Record<string, string> = { google: "Google AI Overviews", chat_gpt: "ChatGPT" };

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
