// =============================================================================
// seo-ai-visibility — module 20 (plan.md): weekly AI search visibility for one
// CLIENT, from DataForSEO's LLM Mentions API.
//
//   POST /seo-ai-visibility
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "client_id": "<uuid>", "platforms": ["google", "chat_gpt"] }
//           (platforms is optional — it exists to test whether the API accepts
//           a platform value the docs don't list; the default is lib.ts's)
//           and "sandbox": true sends the calls to DataForSEO's free Sandbox
//
// Admin endpoint. MUST be deployed with --no-verify-jwt (see this repo's
// memory on that).
//
// ONE LIVE CALL PER (query, platform). For each of the client's active
// priority queries and each platform, ask LLM Mentions for answers whose
// question contains the query and whose sources include the client's domain,
// and store how many there are. See 0053's header for what that does and does
// not measure, and for the cost (per request, not just per row).
//
// PARTIAL FAILURE. Each call is independent: one platform rejecting a value or
// one query failing writes nothing for that pair and is reported in the
// response, without failing the others. Only when EVERY call fails does the
// run fail and back off, so a wrong platform value can't hide behind a
// "success".
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  buildSearchBody,
  DEFAULT_PLATFORMS,
  MAX_QUERIES_PER_CLIENT,
  parseMentions,
  pickQueries,
  primaryDomain,
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

const LLM_MENTIONS_PATH = "/v3/ai_optimization/llm_mentions/search/live";
// DataForSEO's Sandbox: same credentials and request shapes, free, dummy data.
// Only ever reached by an explicit { "sandbox": true } in the request body —
// the scheduled job never sends it — so tests cost nothing.
const LIVE_HOST = "https://api.dataforseo.com";
const SANDBOX_HOST = "https://sandbox.dataforseo.com";
const CONCURRENCY = 4;
const BUDGET_RETRY_MS = 2_000;
const BUDGET_MAX_TRIES = 30; // ~60s, one full vendor_budgets window
const BASE_INTERVAL_MINUTES = 7 * 24 * 60; // weekly, per plan.md
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A client's whole grid (queries x platforms) can exceed one vendor_budgets
 * window, so wait for headroom instead of dropping the call. */
async function reserveBudget(): Promise<void> {
  for (let i = 0; i < BUDGET_MAX_TRIES; i++) {
    const { data: allowed, error } = await supabase.rpc("check_and_reserve_vendor_budget", { p_vendor: "dataforseo" });
    if (error) throw new Error(`vendor budget check failed: ${error.message}`);
    if (allowed) return;
    await sleep(BUDGET_RETRY_MS);
  }
  throw new Error("dataforseo vendor budget stayed exhausted");
}

async function searchMentions(query: string, domain: string, platform: string, sandbox: boolean): Promise<unknown> {
  await reserveBudget();
  const res = await fetch(`${sandbox ? SANDBOX_HOST : LIVE_HOST}${LLM_MENTIONS_PATH}`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`),
      "Content-Type": "application/json",
    },
    body: JSON.stringify([buildSearchBody(query, domain, platform)]),
  });
  const payload = await res.json().catch(() => null);
  const task = payload?.tasks?.[0];
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!task || task.status_code !== 20000) throw new Error(`status ${task?.status_code}: ${task?.status_message}`);
  return task.result;
}

async function settle(clientId: string, success: boolean, error: string | null): Promise<void> {
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: clientId,
    p_job_type: "seo_ai_visibility",
    p_success: success,
    p_error: error,
    p_base_interval_minutes: BASE_INTERVAL_MINUTES,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: null,
  });
  if (jobError) console.error(`seo-ai-visibility ${clientId}: complete_job_attempt failed: ${jobError.message}`);
}

async function pullClient(clientId: string, platforms: string[], sandbox: boolean) {
  const { data: locations, error: locError } = await supabase
    .from("seo_locations")
    .select("website_url")
    .eq("client_id", clientId)
    .eq("is_active", true);
  if (locError) throw new Error(locError.message);
  const domain = primaryDomain((locations ?? []).map((l) => l.website_url));
  if (!domain) {
    await settle(clientId, true, null);
    return { status: "no_domain" as const };
  }

  const { data: queryRows, error: qError } = await supabase
    .from("seo_ai_queries")
    .select("id, query")
    .eq("client_id", clientId)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  if (qError) throw new Error(qError.message);

  const allowed = new Set(pickQueries((queryRows ?? []).map((q) => q.query), MAX_QUERIES_PER_CLIENT).map((q) => q.toLowerCase()));
  const queries = (queryRows ?? []).filter((q) => allowed.has(q.query.trim().toLowerCase()));
  if (queries.length === 0) {
    await settle(clientId, true, null);
    return { status: "no_queries" as const };
  }

  const pairs = queries.flatMap((q) => platforms.map((platform) => ({ q, platform })));
  const rows: Record<string, unknown>[] = [];
  const errors: string[] = [];

  for (let i = 0; i < pairs.length; i += CONCURRENCY) {
    await Promise.all(
      pairs.slice(i, i + CONCURRENCY).map(async ({ q, platform }) => {
        try {
          const result = await searchMentions(q.query, domain, platform, sandbox);
          const parsed = parseMentions(result, domain);
          rows.push({
            client_id: clientId,
            query_id: q.id,
            platform,
            domain,
            cited_count: parsed.cited_count,
            top_sources: parsed.top_sources,
            raw: { items_returned: parsed.items_returned, sandbox, result },
          });
        } catch (e) {
          errors.push(`${platform} "${q.query}": ${e instanceof Error ? e.message : "failed"}`);
        }
      }),
    );
  }

  if (rows.length === 0) throw new Error(`every call failed; first error: ${errors[0] ?? "unknown"}`);

  const { error: upsertError } = await supabase
    .from("seo_ai_mentions")
    .upsert(rows, { onConflict: "query_id,platform,check_date" });
  if (upsertError) throw new Error(`writing seo_ai_mentions failed: ${upsertError.message}`);

  await settle(clientId, true, null);
  console.log(`seo-ai-visibility ${clientId}: ${domain} wrote=${rows.length}/${pairs.length} errors=${errors.length}`);
  return { status: "pulled" as const, domain, written: rows.length, attempted: pairs.length, errors };
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

  const platforms =
    Array.isArray(body.platforms) && body.platforms.length > 0
      ? (body.platforms as unknown[]).map((p) => String(p)).slice(0, 6)
      : DEFAULT_PLATFORMS;

  const sandbox = body.sandbox === true;

  try {
    const result = await pullClient(clientId, platforms, sandbox);
    return json({ ok: true, client_id: clientId, platforms, sandbox, ...result });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "AI visibility pull failed";
    console.error(`seo-ai-visibility ${clientId} failed: ${reason}`);
    await settle(clientId, false, reason);
    return json({ ok: false, error: reason }, 500);
  }
});
