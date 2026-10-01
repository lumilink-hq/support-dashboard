// =============================================================================
// seo-competitor-gaps — module 23 (plan.md, Phase 6c): the searches each of a
// location's competitors ranks for in Google's top 20 that the location's
// website doesn't show up for at all.
//
//   POST /seo-competitor-gaps
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "location_id": "<uuid>" }
//
// Admin endpoint, same posture as the other seo-* functions. MUST be deployed
// with --no-verify-jwt.
//
// ONE DataForSEO Labs domain_intersection call per active competitor (at most
// 5 per location, module 18's cap), about $0.024 each at 100 items. Each
// (location, competitor) pair's rows are replaced wholesale, and a fetch row
// is written even when nothing comes back, so 0063's pull-forward only fires
// for a competitor that has truly never been fetched.
//
// SHARED WEBSITES. A sibling location of the same client with the same site
// and the same competitor fetched in the last day is copied, not re-bought
// (same idea as seo-backlinks). Only a real fetch is copied, never a copy, so
// stale rows can't pass from sibling to sibling.
//
// A competitor that fails doesn't stop the others; the run is settled as a
// failure (and backs off) if any competitor failed, with each error named.
//
// No model is involved; the phrases go to DataForSEO as search terms.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD,
//      DATAFORSEO_BASE_URL (optional; tests point it at a mock).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { brandToken, filterGaps, gapRequest, type GapItem, parseGapItems, targetDomain } from "./lib.ts";

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
const JOB_TYPE = "seo_competitor_gaps";
const BASE_INTERVAL_MINUTES = 30 * 24 * 60; // monthly
const MAX_BACKOFF_MINUTES = 24 * 60;
const SIBLING_REUSE_MS = 24 * 60 * 60 * 1000;

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

async function settle(clientId: string, locationId: string, success: boolean, error: string | null): Promise<void> {
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: clientId,
    p_job_type: JOB_TYPE,
    p_success: success,
    p_error: error,
    p_base_interval_minutes: BASE_INTERVAL_MINUTES,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: locationId,
  });
  if (jobError) console.error(`seo-competitor-gaps ${locationId}: complete_job_attempt failed: ${jobError.message}`);
}

type LocationRow = { id: string; client_id: string; website_url: string | null };
type CompetitorRow = { id: string; domain: string };

/** Rows a sibling location already fetched for the same site and competitor
 * in the last day, or null if there is no such fetch. */
async function siblingGaps(loc: LocationRow, site: string, competitor: string): Promise<GapItem[] | null> {
  const since = new Date(Date.now() - SIBLING_REUSE_MS).toISOString();
  const { data: fetch } = await supabase
    .from("seo_competitor_gap_fetches")
    .select("location_id, competitor_id")
    .eq("client_id", loc.client_id)
    .eq("target_domain", site)
    .eq("competitor_domain", competitor)
    .eq("copied", false)
    .neq("location_id", loc.id)
    .gte("fetched_at", since)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!fetch) return null;
  const { data, error } = await supabase
    .from("seo_competitor_keyword_gaps")
    .select("keyword, competitor_position, competitor_url, search_volume, cpc, keyword_difficulty, main_intent")
    .eq("location_id", fetch.location_id)
    .eq("competitor_id", fetch.competitor_id);
  if (error) return null;
  type Stored = Pick<GapItem, "keyword" | "competitor_position" | "competitor_url" | "search_volume" | "cpc" | "keyword_difficulty" | "main_intent">;
  return ((data ?? []) as Stored[]).map((r): GapItem => ({ ...r, competition_level: null, monthly_searches: [] }));
}

async function writePair(
  loc: LocationRow,
  comp: CompetitorRow,
  site: string,
  competitor: string,
  gaps: GapItem[],
  copied: boolean,
): Promise<void> {
  const { error: delErr } = await supabase
    .from("seo_competitor_keyword_gaps")
    .delete()
    .eq("location_id", loc.id)
    .eq("competitor_id", comp.id);
  if (delErr) throw new Error(`clearing old gaps failed: ${delErr.message}`);

  const now = new Date().toISOString();
  if (gaps.length) {
    const { error } = await supabase.from("seo_competitor_keyword_gaps").insert(
      gaps.map((g) => ({
        client_id: loc.client_id,
        location_id: loc.id,
        competitor_id: comp.id,
        keyword: g.keyword,
        competitor_position: g.competitor_position,
        competitor_url: g.competitor_url,
        search_volume: g.search_volume,
        cpc: g.cpc,
        keyword_difficulty: g.keyword_difficulty,
        main_intent: g.main_intent,
        fetched_at: now,
      })),
    );
    if (error) throw new Error(`writing gaps failed: ${error.message}`);
  }

  const { error: fErr } = await supabase.from("seo_competitor_gap_fetches").upsert(
    {
      client_id: loc.client_id,
      location_id: loc.id,
      competitor_id: comp.id,
      target_domain: site,
      competitor_domain: competitor,
      fetched_at: now,
      item_count: gaps.length,
      copied,
    },
    { onConflict: "location_id,competitor_id" },
  );
  if (fErr) throw new Error(`recording the fetch failed: ${fErr.message}`);
}

async function pullLocation(loc: LocationRow): Promise<Record<string, unknown>> {
  const site = targetDomain(loc.website_url);
  if (!site) return { status: "no_domain" };

  const { data: comps, error: cErr } = await supabase
    .from("seo_competitors")
    .select("id, domain")
    .eq("location_id", loc.id)
    .eq("is_active", true);
  if (cErr) throw new Error(`reading seo_competitors failed: ${cErr.message}`);

  const ownBrand = brandToken(site);
  const errors: string[] = [];
  const counts: Record<string, number | string> = {};

  for (const comp of (comps ?? []) as CompetitorRow[]) {
    const competitor = targetDomain(comp.domain);
    if (!competitor || competitor === site) {
      counts[comp.domain] = "skipped";
      continue;
    }
    try {
      let gaps = await siblingGaps(loc, site, competitor);
      let source = "copied";
      if (gaps === null) {
        const result = await dataForSeo("/dataforseo_labs/google/domain_intersection/live", gapRequest(competitor, site));
        gaps = filterGaps(parseGapItems(result), [brandToken(competitor), ownBrand]);
        source = "fetched";
      }
      await writePair(loc, comp, site, competitor, gaps, source === "copied");
      counts[competitor] = `${source} ${gaps.length}`;
    } catch (e) {
      errors.push(`${competitor}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }

  return { status: errors.length ? "partial" : "ok", site, competitors: counts, errors };
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

  const locationId = String(body.location_id ?? "").trim();
  if (!locationId) return json({ error: "location_id is required" }, 400);

  const { data: loc, error } = await supabase
    .from("seo_locations")
    .select("id, client_id, website_url")
    .eq("id", locationId)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!loc) return json({ error: "location not found" }, 404);

  try {
    const result = await pullLocation(loc as LocationRow);
    const errors = (result.errors as string[] | undefined) ?? [];
    await settle(loc.client_id, loc.id, errors.length === 0, errors.length ? errors.join("; ").slice(0, 500) : null);
    console.log(`seo-competitor-gaps ${locationId}: ${JSON.stringify(result)}`);
    return json({ ok: errors.length === 0, location_id: locationId, ...result }, errors.length ? 502 : 200);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "competitor gap pull failed";
    console.error(`seo-competitor-gaps ${locationId} failed: ${reason}`);
    await settle(loc.client_id, loc.id, false, reason);
    return json({ ok: false, error: reason }, 500);
  }
});
