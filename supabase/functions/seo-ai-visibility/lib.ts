// =============================================================================
// lib.ts — pure, side-effect-free helpers for the seo-ai-visibility worker
// (module 20). Same split as the other SEO edge functions.
//
// Uses DataForSEO's LLM Mentions Search (ai_optimization/llm_mentions/search/live).
// Documented `platform` values are 'google' (Google AI Overviews) and
// 'chat_gpt' (US/English only). The scope also names Gemini, Perplexity and
// Claude; the docs don't list those as LLM Mentions platforms, so they are
// not defaulted in — see DEFAULT_PLATFORMS.
// =============================================================================

/** Only the two platform values the LLM Mentions docs actually list. Others
 * can be passed per call (body.platforms) to test whether the API accepts
 * them, without changing this default. */
export const DEFAULT_PLATFORMS = ["google", "chat_gpt"];

/** The scope's baseline is 18 tracked AI queries; the cap also bounds spend. */
export const MAX_QUERIES_PER_CLIENT = 18;

const MAX_SOURCES_KEPT = 5;

/** Bare hostname, no protocol/www/path; null if unparseable. */
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

/** A client can have several locations; this is per client, so pick the domain
 * most of them share. Ties break alphabetically so the choice is stable. */
export function primaryDomain(websiteUrls: (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const u of websiteUrls) {
    const d = targetDomain(u);
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [d, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** Request body for one (query, platform): answers whose QUESTION contains the
 * query and whose SOURCES include the domain (multiple targets AND together).
 * `limit` is small on purpose — total_count carries the number, and rows are
 * billed per row returned. */
export function buildSearchBody(query: string, domain: string, platform: string): Record<string, unknown> {
  return {
    target: [
      { keyword: query, search_scope: ["question"], match_type: "partial_match" },
      { domain, search_scope: ["sources"] },
    ],
    platform,
    location_code: 2840,
    language_code: "en",
    limit: MAX_SOURCES_KEPT,
  };
}

export type TopSource = { url: string; title: string | null; question: string | null };

export type MentionResult = {
  cited_count: number;
  top_sources: TopSource[];
  items_returned: number;
};

function domainOf(url: unknown): string | null {
  return typeof url === "string" ? targetDomain(url) : null;
}

/** Reads one search/live result. cited_count is the API's total_count (how
 * many matching answers exist), not the number of rows returned. top_sources
 * are the citing pages on the client's own domain, deduplicated by URL. A
 * missing result is zero mentions: this endpoint returns an empty result for
 * "nothing found", which is a real answer, not an error. */
export function parseMentions(result: unknown, domain: string): MentionResult {
  const first = Array.isArray(result) ? (result as Record<string, unknown>[])[0] : null;
  const items = (Array.isArray(first?.items) ? first!.items : []) as Record<string, unknown>[];
  const total = typeof first?.total_count === "number" ? (first.total_count as number) : items.length;

  const seen = new Set<string>();
  const top: TopSource[] = [];
  for (const item of items) {
    const sources = (Array.isArray(item.sources) ? item.sources : []) as Record<string, unknown>[];
    for (const s of sources) {
      const url = typeof s.url === "string" ? s.url : null;
      if (!url || seen.has(url)) continue;
      const host = typeof s.domain === "string" ? targetDomain(s.domain) : domainOf(url);
      if (host !== domain) continue;
      seen.add(url);
      top.push({
        url,
        title: typeof s.title === "string" ? s.title : null,
        question: typeof item.question === "string" ? item.question : null,
      });
      if (top.length >= MAX_SOURCES_KEPT) break;
    }
    if (top.length >= MAX_SOURCES_KEPT) break;
  }
  return { cited_count: total, top_sources: top, items_returned: items.length };
}

/** Active queries, trimmed, de-duplicated case-insensitively, capped. */
export function pickQueries(queries: string[], cap = MAX_QUERIES_PER_CLIENT): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of queries) {
    const t = q.trim();
    const key = t.toLowerCase();
    if (t.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

/** Share of the tracked queries that at least one platform cited the client
 * for — the number the team's Ahrefs dashboard calls share of AI visibility. */
export function shareOfVisibility(rows: { query_id: string; cited_count: number }[], totalQueries: number): number {
  if (totalQueries <= 0) return 0;
  const cited = new Set(rows.filter((r) => r.cited_count > 0).map((r) => r.query_id));
  return cited.size / totalQueries;
}
