// =============================================================================
// seo-keyword-research — module 22 (plan.md, Phase 6c): search volume and
// difficulty for every tracked keyword, plus keyword suggestions, for one client.
//
//   POST /seo-keyword-research
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "client_id": "<uuid>" }
//
// Admin endpoint, same posture as the other seo-* functions. MUST be deployed
// with --no-verify-jwt.
//
// ONE RUN, IN ORDER
//   1. Striking distance (no vendor call): module 21's monthly queries for each
//      of the client's Search Console properties, latest complete month,
//      average position 8–20 with 20+ impressions, not tracked, not dismissed.
//   2. keyword_overview (required) on every tracked phrase plus the striking-
//      distance picks, in calls of up to 700. A failure fails the run and backs
//      off. Every phrase asked gets a seo_keyword_metrics row, null-filled when
//      DataForSEO has no data, so "no row" means "never asked" (0062).
//   3. keyword_ideas (best-effort) seeded with up to 20 tracked phrases. A
//      failure is logged and the previous related suggestions are kept.
//   4. Suggestions upserted; open suggestions a source no longer produces are
//      deleted, dismissed ones are kept so they stay dismissed.
//
// COST: about $0.012 a call plus $0.00012 an item, so two calls and ~150 items
// is roughly $0.04 a client-month (DataForSEO pricing page, 2026-10-01).
//
// No model is involved, so rule 5 (client text out of prompts) doesn't arise;
// the phrases go to DataForSEO as search terms, as rank tracking already does.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  chunk,
  IDEAS_LIMIT,
  isQueryable,
  LANGUAGE_CODE,
  latestCompleteMonth,
  LOCATION_CODE,
  type KeywordMetrics,
  metricsFor,
  normalizeKeyword,
  OVERVIEW_MAX_CALLS,
  OVERVIEW_MAX_KEYWORDS,
  parseItems,
  pickRelated,
  pickSeeds,
  pickStrikingDistance,
  type QueryRow,
  type StrikingPick,
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

const DATAFORSEO_BASE = Deno.env.get("DATAFORSEO_BASE_URL") ?? "https://api.dataforseo.com/v3";
const JOB_TYPE = "seo_keyword_research";
const BASE_INTERVAL_MINUTES = 30 * 24 * 60; // monthly
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

/** One DataForSEO Live call. Reserves vendor budget first; returns the first
 * task's `result`, or throws with a message worth storing as last_error. */
async function dataForSeo(path: string, body: Record<string, unknown>): Promise<unknown> {
  const { data: allowed, error: budgetError } = await supabase.rpc("check_and_reserve_vendor_budget", {
    p_vendor: "dataforseo",
  });
  if (budgetError) throw new Error(`vendor budget check failed: ${budgetError.message}`);
  if (!allowed) throw new Error("dataforseo vendor budget exhausted this window");

  const res = await fetch(`${DATAFORSEO_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`),
      "Content-Type": "application/json",
    },
    body: JSON.stringify([body]),
  });
  const payload = await res.json().catch(() => null);
  const task = payload?.tasks?.[0];
  const statusCode: number | undefined = task?.status_code ?? payload?.status_code;
  const message: string | undefined = task?.status_message ?? payload?.status_message;

  if (!res.ok) throw new Error(`dataforseo ${path} HTTP ${res.status}`);
  if (!task || statusCode !== 20000) throw new Error(`dataforseo ${path} status ${statusCode}: ${message}`);
  return task.result;
}

async function settle(clientId: string, success: boolean, error: string | null): Promise<void> {
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: clientId,
    p_job_type: JOB_TYPE,
    p_success: success,
    p_error: error,
    p_base_interval_minutes: BASE_INTERVAL_MINUTES,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: null,
  });
  if (jobError) console.error(`seo-keyword-research ${clientId}: complete_job_attempt failed: ${jobError.message}`);
}

async function strikingDistance(clientId: string, sites: string[], exclude: Set<string>): Promise<StrikingPick[]> {
  const rows: QueryRow[] = [];
  for (const site of sites) {
    const { data: counts, error: countErr } = await supabase
      .from("seo_search_keyword_counts")
      .select("month, is_complete")
      .eq("client_id", clientId)
      .eq("site_url", site);
    if (countErr) throw new Error(`reading seo_search_keyword_counts failed: ${countErr.message}`);
    const month = latestCompleteMonth((counts ?? []) as { month: string; is_complete: boolean }[]);
    if (!month) continue;

    const { data, error } = await supabase
      .from("seo_search_monthly_queries")
      .select("site_url, month, query, clicks, impressions, position")
      .eq("client_id", clientId)
      .eq("site_url", site)
      .eq("month", month)
      .order("impressions", { ascending: false })
      .limit(500);
    if (error) throw new Error(`reading seo_search_monthly_queries failed: ${error.message}`);
    rows.push(...((data ?? []) as QueryRow[]));
  }
  return pickStrikingDistance(rows, exclude);
}

async function research(clientId: string): Promise<Record<string, unknown>> {
  const { data: locs, error: locErr } = await supabase
    .from("seo_locations")
    .select("id, search_console_site_url")
    .eq("client_id", clientId)
    .eq("is_active", true)
    .not("website_url", "is", null);
  if (locErr) throw new Error(`reading seo_locations failed: ${locErr.message}`);
  const locations = (locs ?? []) as { id: string; search_console_site_url: string | null }[];
  if (locations.length === 0) return { status: "no_locations" };

  const { data: kws, error: kwErr } = await supabase
    .from("seo_keywords")
    .select("keyword")
    .eq("client_id", clientId)
    .eq("is_active", true)
    .in("location_id", locations.map((l) => l.id));
  if (kwErr) throw new Error(`reading seo_keywords failed: ${kwErr.message}`);
  const tracked = [...new Set(((kws ?? []) as { keyword: string }[]).map((k) => normalizeKeyword(k.keyword)))].filter(isQueryable);

  const { data: dismissedRows, error: disErr } = await supabase
    .from("seo_keyword_suggestions")
    .select("keyword")
    .eq("client_id", clientId)
    .eq("status", "dismissed");
  if (disErr) throw new Error(`reading seo_keyword_suggestions failed: ${disErr.message}`);
  const exclude = new Set([...tracked, ...((dismissedRows ?? []) as { keyword: string }[]).map((d) => d.keyword)]);

  // 1. Striking distance.
  const sites = [...new Set(locations.map((l) => (l.search_console_site_url ?? "").trim()).filter(Boolean))];
  const striking = sites.length ? await strikingDistance(clientId, sites, exclude) : [];

  // 2. Metrics for tracked + striking (required).
  const asked = [...new Set([...tracked, ...striking.map((s) => s.keyword)])].slice(0, OVERVIEW_MAX_KEYWORDS * OVERVIEW_MAX_CALLS);
  const got: KeywordMetrics[] = [];
  for (const part of chunk(asked, OVERVIEW_MAX_KEYWORDS)) {
    const result = await dataForSeo("/dataforseo_labs/google/keyword_overview/live", {
      keywords: part,
      location_code: LOCATION_CODE,
      language_code: LANGUAGE_CODE,
    });
    got.push(...parseItems(result));
  }
  const metrics = metricsFor(asked, got);
  const fetchedAt = new Date().toISOString();
  if (metrics.length) {
    const { error } = await supabase.from("seo_keyword_metrics").upsert(
      metrics.map((m) => ({
        client_id: clientId,
        ...m,
        location_code: LOCATION_CODE,
        language_code: LANGUAGE_CODE,
        fetched_at: fetchedAt,
      })),
      { onConflict: "client_id,keyword" },
    );
    if (error) throw new Error(`writing seo_keyword_metrics failed: ${error.message}`);
  }
  const metricsByKeyword = new Map(metrics.map((m) => [m.keyword, m]));

  // 3. Related ideas (best-effort).
  const errors: string[] = [];
  const seeds = pickSeeds(tracked);
  let related: KeywordMetrics[] | null = seeds.length ? null : [];
  if (seeds.length) {
    try {
      const result = await dataForSeo("/dataforseo_labs/google/keyword_ideas/live", {
        keywords: seeds,
        location_code: LOCATION_CODE,
        language_code: LANGUAGE_CODE,
        limit: IDEAS_LIMIT,
      });
      related = pickRelated(parseItems(result), new Set([...exclude, ...striking.map((s) => s.keyword)]));
    } catch (e) {
      errors.push(`keyword_ideas: ${e instanceof Error ? e.message : "failed"}`);
    }
  }

  // 4. Suggestions.
  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = striking.map((s) => {
    const m = metricsByKeyword.get(s.keyword);
    return {
      client_id: clientId,
      keyword: s.keyword,
      source: "search_console",
      search_volume: m?.search_volume ?? null,
      cpc: m?.cpc ?? null,
      keyword_difficulty: m?.keyword_difficulty ?? null,
      main_intent: m?.main_intent ?? null,
      site_url: s.site_url,
      gsc_month: s.gsc_month,
      gsc_clicks: s.gsc_clicks,
      gsc_impressions: s.gsc_impressions,
      gsc_position: s.gsc_position,
      refreshed_at: now,
    };
  });
  for (const r of related ?? []) {
    rows.push({
      client_id: clientId,
      keyword: r.keyword,
      source: "related",
      search_volume: r.search_volume,
      cpc: r.cpc,
      keyword_difficulty: r.keyword_difficulty,
      main_intent: r.main_intent,
      site_url: null,
      gsc_month: null,
      gsc_clicks: null,
      gsc_impressions: null,
      gsc_position: null,
      refreshed_at: now,
    });
  }
  if (rows.length) {
    // status isn't in the payload: a new row is 'open', an existing one keeps
    // its status (dismissed phrases were excluded above, so none is touched).
    const { error } = await supabase.from("seo_keyword_suggestions").upsert(rows, { onConflict: "client_id,keyword" });
    if (error) throw new Error(`writing seo_keyword_suggestions failed: ${error.message}`);
  }

  // Drop open suggestions a refreshed source no longer produces. Related ones
  // are kept when the ideas call failed, so a vendor blip doesn't empty the list.
  const refreshedSources = related === null ? ["search_console"] : ["search_console", "related"];
  const { error: delErr } = await supabase
    .from("seo_keyword_suggestions")
    .delete()
    .eq("client_id", clientId)
    .eq("status", "open")
    .in("source", refreshedSources)
    .lt("refreshed_at", now);
  if (delErr) throw new Error(`pruning seo_keyword_suggestions failed: ${delErr.message}`);

  return {
    status: "ok",
    tracked: tracked.length,
    metrics_written: metrics.length,
    metrics_with_volume: got.length,
    search_console_suggestions: striking.length,
    related_suggestions: related?.length ?? null,
    errors,
  };
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

  const { data: client, error } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!client) return json({ error: "client not found" }, 404);

  try {
    const result = await research(clientId);
    await settle(clientId, true, null);
    console.log(`seo-keyword-research ${clientId}: ${JSON.stringify(result)}`);
    return json({ ok: true, client_id: clientId, ...result });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "keyword research failed";
    console.error(`seo-keyword-research ${clientId} failed: ${reason}`);
    await settle(clientId, false, reason);
    return json({ ok: false, error: reason }, 500);
  }
});
