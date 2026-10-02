// =============================================================================
// lib.ts — pure helpers for the seo-ai-responses worker (module 25): ask a
// tracked question live on Perplexity, Gemini or Claude (DataForSEO LLM
// Responses API, web search on) and read which domains the answer cites.
//
// Checked against docs.dataforseo.com 2026-10-02:
//   POST /v3/ai_optimization/{perplexity|gemini|claude}/llm_responses/live
//   body: user_prompt (≤500 chars), model_name, web_search (Gemini, Claude;
//         Perplexity's Sonar models always search), force_web_search (Claude),
//         web_search_country_iso_code (not Gemini: it rejects it), max_output_tokens.
//   citations: result[0].items[].sections[].annotations[] {title, url} —
//         Claude's are documented under items[].message.sections[] instead,
//         and Gemini's carry direct_url (url is a Google redirect).
//   cost: result[0].money_spent (USD); $0.0006 a call plus the model's price.
// =============================================================================

import { domainMatches, targetDomain } from "../seo-ai-visibility/lib.ts";

export const RESPONSE_PLATFORMS = ["perplexity", "gemini", "claude"] as const;
export type ResponsePlatform = (typeof RESPONSE_PLATFORMS)[number];

/** Cheap models that search the web; each overridable by env
 * (SEO_AI_MODEL_PERPLEXITY / _GEMINI / _CLAUDE). Names unverified against the
 * account's models list; a wrong one fails that platform's calls, visibly. */
export const DEFAULT_MODELS: Record<ResponsePlatform, string> = {
  perplexity: "sonar",
  gemini: "gemini-2.5-flash",
  claude: "claude-haiku-4-5",
};

export const PROMPT_MAX = 500; // the API's user_prompt limit
export const MAX_SOURCES_KEPT = 5;

/** Platforms from a comma list, known ones only, in a stable order. */
export function parsePlatforms(raw: string | null | undefined): ResponsePlatform[] {
  if (raw === null || raw === undefined || raw.trim() === "") return [...RESPONSE_PLATFORMS];
  const want = new Set(raw.split(",").map((s) => s.trim().toLowerCase()));
  return RESPONSE_PLATFORMS.filter((p) => want.has(p));
}

export function buildResponseBody(platform: ResponsePlatform, model: string, question: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    user_prompt: question.slice(0, PROMPT_MAX),
    model_name: model,
    max_output_tokens: 1024,
  };
  // Gemini rejects this field (40501 "Invalid Field", seen in production
  // 2026-10-02); Perplexity and Claude accept it.
  if (platform !== "gemini") body.web_search_country_iso_code = "US";
  if (platform !== "perplexity") body.web_search = true;
  if (platform === "claude") body.force_web_search = true;
  return body;
}

export type Citation = { url: string; title: string | null; host: string | null };

export type ParsedResponse = {
  answer: string;
  citations: Citation[];
  money_spent: number | null;
  model: string | null;
};

const REDIRECT_HOSTS = /(^|\.)(vertexaisearch\.cloud\.google\.com|google\.com)$/i;

/** Which site a citation points at. Gemini's `url` is a Google redirect, so
 * direct_url wins; failing that, a title that is itself a domain (Gemini
 * titles grounding sources by domain). */
export function citationHost(a: Record<string, unknown>): string | null {
  const direct = typeof a.direct_url === "string" ? targetDomain(a.direct_url) : null;
  if (direct) return direct;
  const viaUrl = typeof a.url === "string" ? targetDomain(a.url) : null;
  if (viaUrl && !REDIRECT_HOSTS.test(viaUrl)) return viaUrl;
  const title = typeof a.title === "string" ? a.title.trim() : "";
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title)) return title.toLowerCase().replace(/^www\./, "");
  return viaUrl;
}

/** Answer text and citations, wherever the platform puts them. */
export function parseResponse(result: unknown): ParsedResponse {
  const first = Array.isArray(result) ? (result as Record<string, unknown>[])[0] : null;
  const items = (Array.isArray(first?.items) ? first!.items : []) as Record<string, unknown>[];
  const texts: string[] = [];
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const message = (item.message ?? null) as Record<string, unknown> | null;
    const sections = (Array.isArray(item.sections) ? item.sections : Array.isArray(message?.sections) ? message!.sections : []) as Record<string, unknown>[];
    for (const sec of sections) {
      if (typeof sec.text === "string") texts.push(sec.text);
      const anns = (Array.isArray(sec.annotations) ? sec.annotations : []) as Record<string, unknown>[];
      for (const a of anns) {
        const url = typeof a.direct_url === "string" ? a.direct_url : typeof a.url === "string" ? a.url : null;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        citations.push({ url, title: typeof a.title === "string" ? a.title : null, host: citationHost(a) });
      }
    }
  }
  return {
    answer: texts.join("\n").trim(),
    citations,
    money_spent: typeof first?.money_spent === "number" ? (first.money_spent as number) : null,
    model: typeof first?.model_name === "string" ? (first.model_name as string) : null,
  };
}

/** How many of the answer's citations point at each domain (subdomains count). */
export function citedCounts(citations: Citation[], domains: string[]): Map<string, number> {
  const out = new Map(domains.map((d) => [d, 0]));
  for (const c of citations) for (const d of domains) if (domainMatches(c.host, d)) out.set(d, (out.get(d) ?? 0) + 1);
  return out;
}

/** The client's own cited pages, for seo_ai_mentions.top_sources. */
export function clientSources(citations: Citation[], domain: string, question: string) {
  return citations
    .filter((c) => domainMatches(c.host, domain))
    .slice(0, MAX_SOURCES_KEPT)
    .map((c) => ({ url: c.url, title: c.title, question }));
}

/** (question, platform) pairs still to do this week, given the ones done. */
export function pendingPairs<Q extends { id: string }>(
  queries: Q[],
  platforms: ResponsePlatform[],
  done: Set<string>,
): { q: Q; platform: ResponsePlatform }[] {
  return queries.flatMap((q) => platforms.map((platform) => ({ q, platform }))).filter(({ q, platform }) => !done.has(`${q.id}|${platform}`));
}
