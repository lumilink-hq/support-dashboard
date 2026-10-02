// =============================================================================
// seo-ai-responses — module 25 (plan.md, Phase 6c): does Perplexity, Gemini
// or Claude cite the client (and its competitors) when asked the client's
// tracked AI questions? One live answer per (question, platform) a week.
//
//   POST /seo-ai-responses
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "client_id": "<uuid>" }
//
// Admin endpoint, same posture as the other seo-* functions. MUST be deployed
// with --no-verify-jwt.
//
// WHAT IT MEASURES. LLM Mentions (module 20) counts answers in a dataset
// DataForSEO collected; it only covers Google AI Overviews and ChatGPT. Here
// the question is asked live with web search on, and the answer's citations
// are read. That's one sample a week, so a "cited" can come and go between
// weeks for no reason on the client's side. The portal says so.
//
// WHERE IT WRITES (0065):
//   seo_ai_mentions        — the client's result per platform, cited_count =
//                            how many of the answer's citations are the
//                            client's site, so module 20's card and report
//                            pick up the new platforms as they are.
//   seo_ai_share_of_voice  — the same count for the client and each
//                            competitor (method 'response').
//
// RESUMABLE. Live answers take up to 2 minutes, so one call works through the
// pending pairs a few at a time for STEP_BUDGET_MS, then settles the job 10
// minutes out; the cron tick comes back until every pair has a row from the
// last 6 days, then settles weekly. If everything attempted in a step fails,
// the step settles as a failure and backs off.
//
// The question is the client's own text, sent as the prompt to a third-party
// model; nothing in the answer is acted on except the citation URLs, so rule 5
// (client text out of OUR prompts) doesn't arise.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD,
//      SEO_AI_RESPONSE_PLATFORMS (optional, default "perplexity,gemini,claude"),
//      SEO_AI_MODEL_PERPLEXITY / _GEMINI / _CLAUDE (optional),
//      DATAFORSEO_HOST and SEO_AI_RESPONSES_STEP_MS (optional, tests).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { competitorDomains, MAX_QUERIES_PER_CLIENT, pickQueries, primaryDomain } from "../seo-ai-visibility/lib.ts";
import {
  buildResponseBody,
  citedCounts,
  clientSources,
  DEFAULT_MODELS,
  parsePlatforms,
  parseResponse,
  pendingPairs,
  type ResponsePlatform,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const DATAFORSEO_LOGIN = Deno.env.get("DATAFORSEO_LOGIN");
const DATAFORSEO_PASSWORD = Deno.env.get("DATAFORSEO_PASSWORD");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const HOST = Deno.env.get("DATAFORSEO_HOST") ?? "https://api.dataforseo.com";
const PLATFORMS = parsePlatforms(Deno.env.get("SEO_AI_RESPONSE_PLATFORMS"));
const MODELS: Record<ResponsePlatform, string> = {
  perplexity: Deno.env.get("SEO_AI_MODEL_PERPLEXITY") ?? DEFAULT_MODELS.perplexity,
  gemini: Deno.env.get("SEO_AI_MODEL_GEMINI") ?? DEFAULT_MODELS.gemini,
  claude: Deno.env.get("SEO_AI_MODEL_CLAUDE") ?? DEFAULT_MODELS.claude,
};

const JOB_TYPE = "seo_ai_responses";
const STEP_BUDGET_MS = Number(Deno.env.get("SEO_AI_RESPONSES_STEP_MS") ?? 100_000);
const CALL_TIMEOUT_MS = 125_000; // the API's own task limit is 120 s
const CONCURRENCY = 3;
const DONE_WITHIN_DAYS = 6;
const CONTINUE_MINUTES = 10;
const BASE_INTERVAL_MINUTES = 7 * 24 * 60; // weekly, like module 20
const MAX_BACKOFF_MINUTES = 24 * 60;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function ask(platform: ResponsePlatform, question: string): Promise<unknown> {
  const { data: allowed, error: budgetError } = await supabase.rpc("check_and_reserve_vendor_budget", { p_vendor: "dataforseo" });
  if (budgetError) throw new Error(`vendor budget check failed: ${budgetError.message}`);
  if (!allowed) throw new Error("dataforseo vendor budget exhausted this window");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(`${HOST}/v3/ai_optimization/${platform}/llm_responses/live`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify([buildResponseBody(platform, MODELS[platform], question)]),
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => null);
    const task = payload?.tasks?.[0];
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!task || task.status_code !== 20000) throw new Error(`status ${task?.status_code ?? payload?.status_code}: ${task?.status_message ?? payload?.status_message}`);
    return task.result;
  } finally {
    clearTimeout(timer);
  }
}

async function settle(clientId: string, success: boolean, error: string | null, intervalMinutes: number): Promise<void> {
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: clientId,
    p_job_type: JOB_TYPE,
    p_success: success,
    p_error: error,
    p_base_interval_minutes: intervalMinutes,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: null,
  });
  if (jobError) console.error(`seo-ai-responses ${clientId}: complete_job_attempt failed: ${jobError.message}`);
}

async function step(clientId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + STEP_BUDGET_MS;
  if (PLATFORMS.length === 0) {
    await settle(clientId, true, null, BASE_INTERVAL_MINUTES);
    return { status: "no_platforms" };
  }

  const { data: locations, error: locError } = await supabase.from("seo_locations").select("website_url").eq("client_id", clientId).eq("is_active", true);
  if (locError) throw new Error(locError.message);
  const domain = primaryDomain((locations ?? []).map((l) => l.website_url));
  if (!domain) {
    await settle(clientId, true, null, BASE_INTERVAL_MINUTES);
    return { status: "no_domain" };
  }

  const { data: queryRows, error: qError } = await supabase
    .from("seo_ai_queries")
    .select("id, query")
    .eq("client_id", clientId)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  if (qError) throw new Error(qError.message);
  const allowed = new Set(pickQueries((queryRows ?? []).map((q) => q.query), MAX_QUERIES_PER_CLIENT).map((q) => q.toLowerCase()));
  const queries = ((queryRows ?? []) as { id: string; query: string }[]).filter((q) => allowed.has(q.query.trim().toLowerCase()));
  if (queries.length === 0) {
    await settle(clientId, true, null, BASE_INTERVAL_MINUTES);
    return { status: "no_queries" };
  }

  const { data: locIds, error: lErr } = await supabase.from("seo_locations").select("id").eq("client_id", clientId).eq("is_active", true);
  if (lErr) throw new Error(lErr.message);
  const { data: comps, error: cErr } = await supabase
    .from("seo_competitors")
    .select("domain")
    .eq("is_active", true)
    .in("location_id", (locIds ?? []).map((l) => l.id));
  if (cErr) throw new Error(cErr.message);
  const domains = [domain, ...competitorDomains((comps ?? []) as { domain: string }[], domain)];

  const since = new Date(Date.now() - DONE_WITHIN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { data: doneRows, error: dErr } = await supabase
    .from("seo_ai_mentions")
    .select("query_id, platform")
    .eq("client_id", clientId)
    .in("platform", PLATFORMS)
    .gte("check_date", since);
  if (dErr) throw new Error(dErr.message);
  const done = new Set(((doneRows ?? []) as { query_id: string; platform: string }[]).map((r) => `${r.query_id}|${r.platform}`));
  const pending = pendingPairs(queries, PLATFORMS, done);

  let ok = 0;
  let spent = 0;
  const errors: string[] = [];
  while (pending.length && Date.now() < deadline) {
    const batch = pending.splice(0, CONCURRENCY);
    await Promise.all(
      batch.map(async ({ q, platform }) => {
        try {
          const parsed = parseResponse(await ask(platform, q.query));
          const counts = citedCounts(parsed.citations, domains);
          spent += parsed.money_spent ?? 0;
          const { error: mErr } = await supabase.from("seo_ai_mentions").upsert(
            {
              client_id: clientId,
              query_id: q.id,
              platform,
              domain,
              cited_count: counts.get(domain) ?? 0,
              top_sources: clientSources(parsed.citations, domain, q.query),
              raw: {
                method: "response",
                model: parsed.model ?? MODELS[platform],
                money_spent: parsed.money_spent,
                cited_hosts: [...new Set(parsed.citations.map((c) => c.host).filter(Boolean))].slice(0, 30),
                answer_excerpt: parsed.answer.slice(0, 600),
              },
            },
            { onConflict: "query_id,platform,check_date" },
          );
          if (mErr) throw new Error(`writing seo_ai_mentions failed: ${mErr.message}`);
          const { error: sErr } = await supabase.from("seo_ai_share_of_voice").upsert(
            domains.map((d) => ({
              client_id: clientId,
              query_id: q.id,
              platform,
              domain: d,
              is_client: d === domain,
              cited_count: counts.get(d) ?? 0,
              method: "response",
            })),
            { onConflict: "query_id,platform,domain,check_date" },
          );
          if (sErr) throw new Error(`writing seo_ai_share_of_voice failed: ${sErr.message}`);
          ok++;
        } catch (e) {
          errors.push(`${platform} "${q.query}": ${e instanceof Error ? e.message : "failed"}`);
        }
      }),
    );
  }

  const remaining = pending.length + errors.length;
  if (ok === 0 && errors.length > 0) {
    await settle(clientId, false, errors[0].slice(0, 500), BASE_INTERVAL_MINUTES);
  } else {
    await settle(clientId, true, null, remaining > 0 ? CONTINUE_MINUTES : BASE_INTERVAL_MINUTES);
  }
  return { status: remaining > 0 ? "continuing" : "done", answered: ok, remaining, money_spent: Math.round(spent * 10000) / 10000, errors };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!VOICE_TOOL_SECRET) {
    console.error("VOICE_TOOL_SECRET unset — refusing to run");
    return json({ error: "Server not configured" }, 500);
  }
  if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    console.error("DATAFORSEO_LOGIN/PASSWORD unset — refusing to run");
    return json({ error: "Server not configured" }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const clientId = String(body.client_id ?? "").trim();
  if (!clientId) return json({ error: "client_id is required" }, 400);

  try {
    const result = await step(clientId);
    console.log(`seo-ai-responses ${clientId}: ${JSON.stringify(result)}`);
    return json({ ok: true, client_id: clientId, ...result });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "AI responses failed";
    console.error(`seo-ai-responses ${clientId} failed: ${reason}`);
    await settle(clientId, false, reason, BASE_INTERVAL_MINUTES);
    return json({ ok: false, error: reason }, 500);
  }
});
