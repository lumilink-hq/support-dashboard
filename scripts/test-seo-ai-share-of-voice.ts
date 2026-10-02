// =============================================================================
// test-seo-ai-share-of-voice.ts — unit tests for module 25: share of voice
// (seo-ai-visibility/lib.ts additions), the live-answer helpers
// (seo-ai-responses/lib.ts) and the portal summary.
//
//   npx tsx scripts/test-seo-ai-share-of-voice.ts
//
// No network, no Deno, no database.
// =============================================================================

import { listJoin, PLATFORM_LABELS, PLATFORM_SHORT, shareOfVoice, type SovRow } from "../lib/seo-portal";
import { aiPlatformsPhrase } from "../supabase/functions/seo-report/lib.ts";
import {
  buildResponseBody,
  citationHost,
  citedCounts,
  clientSources,
  DEFAULT_MODELS,
  parsePlatforms,
  parseResponse,
  pendingPairs,
} from "../supabase/functions/seo-ai-responses/lib.ts";
import {
  buildMultiTargetBody,
  competitorDomains,
  domainMatches,
  MAX_COMPETITORS,
  parseMultiTarget,
} from "../supabase/functions/seo-ai-visibility/lib.ts";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, got?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${got === undefined ? "" : `  (got: ${JSON.stringify(got)})`}`);
  }
}

console.log("\ncompetitorDomains / domainMatches");
{
  const d = competitorDomains(
    [{ domain: "Rival.com" }, { domain: "https://www.rival.com/x" }, { domain: "other.com" }, { domain: "acme.com" }, { domain: "zeta.com" }, { domain: null }],
    "acme.com",
  );
  ok("normalised, de-duplicated, most-tracked first, never the client", JSON.stringify(d) === JSON.stringify(["rival.com", "other.com", "zeta.com"]), d);
  ok("capped at 9 (10 targets with the client)", competitorDomains(Array.from({ length: 20 }, (_, i) => ({ domain: `c${i}.com` })), "acme.com").length === MAX_COMPETITORS);
  ok("exact and subdomain match", domainMatches("acme.com", "acme.com") && domainMatches("blog.acme.com", "acme.com") && domainMatches("www.acme.com", "acme.com"));
  ok("lookalikes don't", !domainMatches("notacme.com", "acme.com") && !domainMatches("acme.com.evil.io", "acme.com") && !domainMatches(null, "acme.com"));
}

console.log("\nmulti_target_metrics");
{
  const body = buildMultiTargetBody("emergency plumber", ["acme.com", "rival.com"], "chat_gpt");
  const targets = body.targets as { key: string; target: Record<string, unknown>[] }[];
  ok("one target set per domain, keyed by domain", targets.length === 2 && targets[1].key === "rival.com");
  ok("same filter as module 20's search: question contains the query, sources include the domain", JSON.stringify(targets[0].target) === JSON.stringify([{ keyword: "emergency plumber", search_scope: ["question"], match_type: "partial_match" }, { domain: "acme.com", search_scope: ["sources"] }]));
  ok("platform and US English set", body.platform === "chat_gpt" && body.location_code === 2840 && body.language_code === "en");

  const viaTotal = parseMultiTarget([{ items: [{ key: "acme.com", total: { mentions: 4 } }, { key: "rival.com", total: { mentions: 0 } }] }]);
  ok("reads items[].total.mentions, zero kept", viaTotal.get("acme.com") === 4 && viaTotal.get("rival.com") === 0);
  const viaGroup = parseMultiTarget([{ items: [{ key: "acme.com", total: { platform: [{ key: "google", mentions: 2 }, { key: "chat_gpt", mentions: 3 }] } }] }]);
  ok("sums a platform grouping when there's no flat number", viaGroup.get("acme.com") === 5, [...viaGroup]);
  const flat = parseMultiTarget([{ items: [{ key: "acme.com", mentions: 7 }] }]);
  ok("falls back to items[].mentions", flat.get("acme.com") === 7);
  const none = parseMultiTarget([{ items: [{ key: "acme.com", total: {} }, { total: { mentions: 1 } }] }]);
  ok("no number or no key → absent, not a guessed zero", none.size === 0);
  ok("null result → empty", parseMultiTarget(null).size === 0);
}

console.log("\nlive answers: platforms and request bodies");
{
  ok("default: all three", JSON.stringify(parsePlatforms(undefined)) === '["perplexity","gemini","claude"]');
  ok("a list, unknowns dropped, stable order", JSON.stringify(parsePlatforms("claude, bogus ,PERPLEXITY")) === '["perplexity","claude"]');
  ok("blank → all three", parsePlatforms("  ").length === 3);
  const p = buildResponseBody("perplexity", DEFAULT_MODELS.perplexity, "q".repeat(600));
  ok("prompt capped at 500 characters", (p.user_prompt as string).length === 500);
  ok("Perplexity (always searches): no web_search flag", !("web_search" in p) && p.model_name === "sonar");
  const g = buildResponseBody("gemini", "gemini-2.5-flash", "q");
  ok("Gemini: web_search on, not forced", g.web_search === true && !("force_web_search" in g));
  const c = buildResponseBody("claude", "claude-haiku-4-5", "q");
  ok("Claude: web_search forced on", c.web_search === true && c.force_web_search === true && c.web_search_country_iso_code === "US");
}

console.log("\nlive answers: citations");
{
  ok("direct_url wins over a Google redirect", citationHost({ url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", direct_url: "https://www.acme.com/x" }) === "acme.com");
  ok("redirect without direct_url falls back to a domain-like title", citationHost({ url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "Acme.com" }) === "acme.com");
  ok("plain url", citationHost({ url: "https://blog.rival.com/p", title: "A post" }) === "blog.rival.com");

  const perplexity = parseResponse([
    {
      model_name: "sonar",
      money_spent: 0.0061,
      items: [
        {
          type: "message",
          sections: [
            { type: "text", text: "Acme is a good choice.", annotations: [{ title: "Acme", url: "https://acme.com/services" }, { title: "Rival", url: "https://rival.com/" }] },
            { type: "text", text: "Also see Rival.", annotations: [{ title: "Acme again", url: "https://acme.com/services" }, { title: "Acme blog", url: "https://blog.acme.com/tips" }] },
          ],
        },
      ],
    },
  ]);
  ok("text joined, model and cost read", perplexity.answer === "Acme is a good choice.\nAlso see Rival." && perplexity.money_spent === 0.0061 && perplexity.model === "sonar");
  ok("citations de-duplicated by URL", perplexity.citations.length === 3, perplexity.citations);
  const counts = citedCounts(perplexity.citations, ["acme.com", "rival.com", "zeta.com"]);
  ok("counts per domain, subdomains included, zero for the absent", counts.get("acme.com") === 2 && counts.get("rival.com") === 1 && counts.get("zeta.com") === 0, [...counts]);
  const src = clientSources(perplexity.citations, "acme.com", "who fixes pipes");
  ok("client sources carry the question", src.length === 2 && src[0].question === "who fixes pipes" && src[0].url === "https://acme.com/services");

  const claude = parseResponse([{ items: [{ type: "message", message: { sections: [{ text: "Answer", annotations: [{ url: "https://rival.com/a", title: "R" }] }] } }] }]);
  ok("Claude's message.sections are read too", claude.citations.length === 1 && claude.answer === "Answer");
  const noSearch = parseResponse([{ items: [{ sections: [{ text: "No sources", annotations: null }] }] }]);
  ok("annotations null (no web search) → no citations, no crash", noSearch.citations.length === 0 && noSearch.money_spent === null);
  ok("null result → empty answer", parseResponse(null).answer === "" && parseResponse(null).citations.length === 0);
}

console.log("\npendingPairs");
{
  const qs = [{ id: "q1" }, { id: "q2" }];
  const left = pendingPairs(qs, ["perplexity", "claude"], new Set(["q1|perplexity", "q2|claude"]));
  ok("only pairs without a recent row", JSON.stringify(left.map((x) => `${x.q.id}|${x.platform}`)) === JSON.stringify(["q1|claude", "q2|perplexity"]));
  ok("all done → nothing", pendingPairs(qs, ["gemini"], new Set(["q1|gemini", "q2|gemini"])).length === 0);
}

console.log("\nportal: shareOfVoice and labels");
{
  const r = (query_id: string, platform: string, domain: string, cited_count: number, check_date: string, is_client = false): SovRow => ({ query_id, platform, domain, cited_count, check_date, is_client });
  const sites = shareOfVoice([
    r("q1", "google", "acme.com", 3, "2026-09-20", true),
    r("q1", "google", "acme.com", 0, "2026-09-27", true), // latest wins
    r("q1", "perplexity", "acme.com", 1, "2026-09-27", true),
    r("q1", "google", "rival.com", 9, "2026-09-27"),
    r("q1", "perplexity", "rival.com", 0, "2026-09-27"),
    r("q2", "google", "rival.com", 2, "2026-09-27"),
    r("q2", "google", "acme.com", 0, "2026-09-27", true),
    r("q2", "google", "zeta.com", 0, "2026-09-27"),
  ]);
  const by = Object.fromEntries(sites.map((x) => [x.domain, x]));
  ok("latest check per question/platform/site counts", by["acme.com"].cited === 1 && by["acme.com"].checked === 3, by["acme.com"]);
  ok("cited checks, not raw mention counts (9 counts as 1)", by["rival.com"].cited === 2 && by["rival.com"].checked === 3, by["rival.com"]);
  ok("most cited first", sites[0].domain === "rival.com" && sites[sites.length - 1].domain === "zeta.com", sites.map((x) => x.domain));
  ok("client flagged", by["acme.com"].is_client && !by["rival.com"].is_client);
  const tie = shareOfVoice([r("q", "google", "b.com", 1, "2026-09-27"), r("q", "google", "a.com", 1, "2026-09-27", true)]);
  ok("on a tie the client comes first", tie[0].domain === "a.com");
  ok("every platform has a label and a short name", ["google", "chat_gpt", "perplexity", "gemini", "claude"].every((p) => PLATFORM_LABELS[p] && PLATFORM_SHORT.some(([k]) => k === p)));
}
  ok("listJoin", listJoin([]) === "" && listJoin(["A"]) === "A" && listJoin(["A", "B"]) === "A and B" && listJoin(["A", "B", "C"]) === "A, B and C");

console.log("\nreport: aiPlatformsPhrase");
{
  ok("an old report (no list) says Google and ChatGPT", aiPlatformsPhrase(undefined) === "Google AI Overviews and ChatGPT");
  ok("fixed order whatever the input order", aiPlatformsPhrase(["perplexity", "chat_gpt", "google"]) === "Google AI Overviews, ChatGPT and Perplexity");
  ok("one platform", aiPlatformsPhrase(["claude"]) === "Claude");
  ok("unknown keys kept, last", aiPlatformsPhrase(["google", "copilot"]) === "Google AI Overviews and copilot");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
