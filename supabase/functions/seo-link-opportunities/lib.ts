// =============================================================================
// lib.ts — pure helpers for the seo-link-opportunities worker (module 26).
//
// DataForSEO Backlinks endpoints (Live; checked against docs.dataforseo.com
// 2026-10-02; $0.024 a request + $0.000036 a row):
//   backlinks/domain_intersection/live
//     targets: {"1": a, "2": b}, exclude_targets: [site] → referring domains
//     that link to BOTH targets and not to the site. items[]:
//     { domain_intersection: { "1": {target, rank, backlinks,
//       backlinks_spam_score, ...}, "2": {...} }, summary }. Each keyed entry's
//     `target` is the REFERRING domain (the same in every entry); the key says
//     which of our targets it links to.
//   backlinks/backlinks/live
//     target: site, backlinks_status_type 'live' + filter is_broken = true
//     (links pointing at a 4xx/5xx page on the site), or 'lost' (links
//     removed). items[]: url_from, domain_from, url_to, url_to_status_code,
//     is_broken, anchor, dofollow, domain_from_rank, first_seen, last_seen,
//     lost_date.
// =============================================================================

export const MAX_COMPETITORS = 5; // module 18's per-location cap
export const GAP_LIMIT = 100; // per pair
export const GAP_KEEP = 100;
export const BROKEN_LIMIT = 200;
export const BROKEN_PAGES_KEEP = 30;
export const LOST_LIMIT = 200;
export const LOST_KEEP = 50;
export const MAX_SPAM_SCORE = 50; // DataForSEO's 0-100 backlink spam score

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

/** Competitors as bare domains, de-duplicated, never the site itself, capped. */
export function competitorList(domains: (string | null)[], site: string, cap = MAX_COMPETITORS): string[] {
  const out: string[] = [];
  for (const d of domains) {
    const t = targetDomain(d);
    if (t && t !== site && !out.includes(t)) out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

/** Every unordered pair: 5 competitors → 10 calls. */
export function pairs<T>(xs: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) out.push([xs[i], xs[j]]);
  return out;
}

export function gapBody(a: string, b: string, site: string): Record<string, unknown> {
  return {
    targets: { "1": a, "2": b },
    exclude_targets: [site],
    backlinks_status_type: "live",
    include_subdomains: true,
    limit: GAP_LIMIT,
  };
}

export function brokenBody(site: string): Record<string, unknown> {
  return {
    target: site,
    mode: "as_is",
    backlinks_status_type: "live",
    include_subdomains: true,
    filters: ["is_broken", "=", true],
    order_by: ["domain_from_rank,desc"],
    limit: BROKEN_LIMIT,
  };
}

export function lostBody(site: string): Record<string, unknown> {
  return {
    target: site,
    mode: "one_per_domain",
    backlinks_status_type: "lost",
    include_subdomains: true,
    order_by: ["domain_from_rank,desc"],
    limit: LOST_LIMIT,
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function itemsOf(result: unknown): Record<string, unknown>[] {
  const first = Array.isArray(result) ? (result as Record<string, unknown>[])[0] : null;
  return (Array.isArray(first?.items) ? first!.items : []) as Record<string, unknown>[];
}

export type GapSite = {
  referring_domain: string;
  competitors: string[];
  domain_rank: number | null;
  backlinks: number;
  spam: number;
};

/**
 * Merges every pair's result into one list: a referring site, which
 * competitors it links to, its best rank and total links to them. Sites with
 * a spam score over MAX_SPAM_SCORE are dropped. Most competitors first, then
 * highest rank.
 */
export function mergeGaps(results: { pair: [string, string]; result: unknown }[], site: string): GapSite[] {
  const byDomain = new Map<string, GapSite>();
  for (const { pair, result } of results) {
    for (const item of itemsOf(result)) {
      const di = (item.domain_intersection ?? {}) as Record<string, Record<string, unknown>>;
      const entries = Object.entries(di).filter(([, v]) => v && typeof v === "object");
      const domain = entries.map(([, v]) => targetDomain(v.target as string)).find(Boolean) ?? null;
      if (!domain || domain === site) continue;
      const g = byDomain.get(domain) ?? { referring_domain: domain, competitors: [], domain_rank: null, backlinks: 0, spam: 0 };
      for (const [key, v] of entries) {
        const comp = key === "1" ? pair[0] : key === "2" ? pair[1] : null;
        if (comp && !g.competitors.includes(comp)) g.competitors.push(comp);
        const rank = num(v.rank);
        if (rank !== null && (g.domain_rank === null || rank > g.domain_rank)) g.domain_rank = rank;
        g.backlinks += num(v.backlinks) ?? 0;
        g.spam = Math.max(g.spam, num(v.backlinks_spam_score) ?? 0);
      }
      byDomain.set(domain, g);
    }
  }
  return [...byDomain.values()]
    .filter((g) => g.competitors.length >= 2 && g.spam <= MAX_SPAM_SCORE)
    .map((g) => ({ ...g, competitors: [...g.competitors].sort() }))
    .sort((a, b) => b.competitors.length - a.competitors.length || (b.domain_rank ?? -1) - (a.domain_rank ?? -1) || a.referring_domain.localeCompare(b.referring_domain))
    .slice(0, GAP_KEEP);
}

export type BrokenPage = {
  url_to: string;
  status: number | null;
  linking_domains: string[];
  links: number;
  best_rank: number | null;
};

/** Broken links grouped by the client's page they point at: the pages whose
 * redirect would recover the most linking sites come first. */
export function groupBroken(result: unknown, site: string): BrokenPage[] {
  const pages = new Map<string, BrokenPage>();
  for (const it of itemsOf(result)) {
    if (it.is_broken === false) continue;
    const url = typeof it.url_to === "string" ? it.url_to : null;
    const from = targetDomain(it.domain_from as string) ?? targetDomain(it.url_from as string);
    if (!url || !from || from === site) continue;
    const p = pages.get(url) ?? { url_to: url, status: num(it.url_to_status_code), linking_domains: [], links: 0, best_rank: null };
    p.links++;
    if (!p.linking_domains.includes(from)) p.linking_domains.push(from);
    const rank = num(it.domain_from_rank);
    if (rank !== null && (p.best_rank === null || rank > p.best_rank)) p.best_rank = rank;
    pages.set(url, p);
  }
  return [...pages.values()]
    .sort((a, b) => b.linking_domains.length - a.linking_domains.length || (b.best_rank ?? -1) - (a.best_rank ?? -1) || a.url_to.localeCompare(b.url_to))
    .slice(0, BROKEN_PAGES_KEEP);
}

export type LostLink = {
  referring_domain: string;
  url_from: string;
  url_to: string | null;
  anchor: string | null;
  dofollow: boolean | null;
  domain_rank: number | null;
  lost_date: string | null; // yyyy-mm-dd
};

function day(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m ? m[1] : null;
}

/** Lost links from the last `days` days (a link with no date is kept), one
 * per referring site, highest rank first. */
export function parseLost(result: unknown, site: string, today: Date, days = 90): LostLink[] {
  const cutoff = new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const seen = new Set<string>();
  const out: LostLink[] = [];
  for (const it of itemsOf(result)) {
    const from = targetDomain(it.domain_from as string) ?? targetDomain(it.url_from as string);
    if (!from || from === site || seen.has(from)) continue;
    const lost = day(it.lost_date) ?? day(it.last_seen);
    if (lost && lost < cutoff) continue;
    seen.add(from);
    out.push({
      referring_domain: from,
      url_from: typeof it.url_from === "string" ? it.url_from : "",
      url_to: typeof it.url_to === "string" ? it.url_to : null,
      anchor: typeof it.anchor === "string" && it.anchor.trim() ? it.anchor.trim().slice(0, 200) : null,
      dofollow: typeof it.dofollow === "boolean" ? it.dofollow : null,
      domain_rank: num(it.domain_from_rank),
      lost_date: lost,
    });
  }
  return out.sort((a, b) => (b.domain_rank ?? -1) - (a.domain_rank ?? -1) || a.referring_domain.localeCompare(b.referring_domain)).slice(0, LOST_KEEP);
}

/** The finding for one broken page that other sites link to. */
export function brokenFinding(p: BrokenPage) {
  const n = p.linking_domains.length;
  return {
    finding_type: "backlinks_to_broken_page",
    severity: (n >= 3 ? "warning" : "info") as "warning" | "info",
    title: `${n} other site${n === 1 ? " links" : "s link"} to this page, which ${p.status ? `answers ${p.status}` : "doesn't work"}. Redirect it to the closest live page to win ${n === 1 ? "that link" : "those links"} back.`,
    details: { status: p.status, linking_domains: p.linking_domains.slice(0, 20), linking_domain_count: n, links: p.links, best_rank: p.best_rank },
    target_url: p.url_to,
  };
}
