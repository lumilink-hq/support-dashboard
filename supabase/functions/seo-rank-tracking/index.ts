// =============================================================================
// seo-rank-tracking — module 7 (plan.md): DataForSEO organic + local pack
// rank tracking, weekly, plus a 5x5 geo grid on priority keywords.
//
//   POST /seo-rank-tracking
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "action": "submit", "location_id": "<uuid>" }
//        or { "action": "collect" }
//
// Admin endpoint. MUST be deployed with --no-verify-jwt (see this repo's
// memory on that).
//
// ASYNC, TWO-PHASE, UNLIKE EVERY OTHER SEO EDGE FUNCTION SO FAR. 'submit'
// posts tasks to DataForSEO's standard queue and records their ids in
// seo_rank_tasks; 'collect' is a separate, later invocation (its own cron
// tick, not tied to any one location) that asks DataForSEO which tasks are
// ready and writes results for the ones that are ours. See 0051's migration
// header for why collect isn't on the job_attempts claim model the other
// jobs use — it's a global sweep, not a per-tenant operation.
//
// ORGANIC + LOCAL PACK FROM ONE TASK. Confirmed against DataForSEO's docs
// before writing this: one google/organic Advanced task's `items` can
// contain both organic entries and a local_pack entry for the same query.
// 'submit' posts ONE task per (keyword, grid-point-or-not); 'collect' reads
// BOTH rank_types out of that single result.
//
// RAW SERP STORED ON PURPOSE. seo_rankings.raw carries the full items array
// so module 18 (competitor tracking) needs "no new vendor calls" (plan.md's
// own words for that module). collectOne matches competitors against the same
// SERP it just parsed and writes seo_competitor_rankings alongside the
// location's own rows.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { buildGeoGrid, findOwnRanking, formatLocationCoordinate, matchCompetitors, type SerpItem } from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const DATAFORSEO_LOGIN = Deno.env.get("DATAFORSEO_LOGIN");
const DATAFORSEO_PASSWORD = Deno.env.get("DATAFORSEO_PASSWORD");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const DATAFORSEO_BASE = "https://api.dataforseo.com/v3";
const TASKS_PER_CALL = 100; // DataForSEO's own limit per task_post call
const STANDARD_RADIUS_KM = 10; // broader than a geo-grid cell — "where do I rank in my area", not a precise point
const GEO_GRID_SPACING_KM = 2;
const GEO_GRID_RADIUS_KM = 3; // per-cell search radius, wide enough to overlap neighboring cells slightly
const DEFAULT_LOCATION_CODE = 2840; // United States — fallback when a location has no lat/lng yet
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

function dataForSeoAuthHeader(): string {
  return "Basic " + btoa(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// -----------------------------------------------------------------------------
// SUBMIT
// -----------------------------------------------------------------------------

type SubmitTask = {
  keyword_id: string;
  keyword: string;
  is_geo_grid: boolean;
  grid_row: number;
  grid_col: number;
  location_code?: number;
  location_coordinate?: string;
};

async function submitForLocation(locationId: string): Promise<void> {
  const { data: loc, error: locError } = await supabase
    .from("seo_locations")
    .select("id, client_id, name, phone_number, lat, lng")
    .eq("id", locationId)
    .maybeSingle();
  if (locError) throw new Error(locError.message);
  if (!loc) throw new Error("location not found");

  const { data: keywords, error: kwError } = await supabase
    .from("seo_keywords")
    .select("id, keyword, is_geo_grid_enabled")
    .eq("location_id", locationId);
  if (kwError) throw new Error(kwError.message);

  const hasCoords = loc.lat !== null && loc.lng !== null;
  const tasks: SubmitTask[] = [];

  for (const kw of keywords ?? []) {
    tasks.push({
      keyword_id: kw.id,
      keyword: kw.keyword,
      is_geo_grid: false,
      grid_row: 0,
      grid_col: 0,
      ...(hasCoords
        ? { location_coordinate: formatLocationCoordinate(loc.lat, loc.lng, STANDARD_RADIUS_KM) }
        : { location_code: DEFAULT_LOCATION_CODE }),
    });

    if (kw.is_geo_grid_enabled && hasCoords) {
      for (const point of buildGeoGrid(loc.lat, loc.lng, GEO_GRID_SPACING_KM)) {
        tasks.push({
          keyword_id: kw.id,
          keyword: kw.keyword,
          is_geo_grid: true,
          grid_row: point.row,
          grid_col: point.col,
          location_coordinate: formatLocationCoordinate(point.lat, point.lng, GEO_GRID_RADIUS_KM),
        });
      }
    }
  }

  if (tasks.length === 0) {
    await settleSubmit(loc.client_id, locationId, true, null);
    return;
  }

  let submittedCount = 0;
  for (const batch of chunk(tasks, TASKS_PER_CALL)) {
    const { data: allowed, error: budgetError } = await supabase.rpc("check_and_reserve_vendor_budget", {
      p_vendor: "dataforseo",
    });
    if (budgetError) {
      console.error(`seo-rank-tracking submit ${locationId}: vendor budget check failed: ${budgetError.message}`);
      continue;
    }
    if (!allowed) {
      console.log(`seo-rank-tracking submit ${locationId}: dataforseo vendor budget exhausted — ${batch.length} tasks skipped this run`);
      continue;
    }

    const body = batch.map((t) => ({
      keyword: t.keyword,
      language_code: "en",
      ...(t.location_coordinate ? { location_coordinate: t.location_coordinate } : { location_code: t.location_code }),
    }));

    const res = await fetch(`${DATAFORSEO_BASE}/serp/google/organic/task_post`, {
      method: "POST",
      headers: { Authorization: dataForSeoAuthHeader(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`seo-rank-tracking submit ${locationId}: task_post HTTP ${res.status}`);
      continue;
    }
    const result = await res.json();
    const returnedTasks: { id: string; status_code: number }[] = result.tasks ?? [];

    const rows = [];
    for (let i = 0; i < returnedTasks.length && i < batch.length; i++) {
      const t = returnedTasks[i];
      const source = batch[i];
      if (t.status_code !== 20100 && t.status_code !== 20000) {
        // 20100 = "Task Created" (the expected success code for task_post).
        console.error(`seo-rank-tracking submit ${locationId}: task for "${source.keyword}" rejected, status_code=${t.status_code}`);
        continue;
      }
      rows.push({
        client_id: loc.client_id,
        location_id: locationId,
        keyword_id: source.keyword_id,
        is_geo_grid: source.is_geo_grid,
        grid_row: source.grid_row,
        grid_col: source.grid_col,
        dataforseo_task_id: t.id,
      });
      submittedCount++;
    }

    if (rows.length > 0) {
      const { error: insErr } = await supabase.from("seo_rank_tasks").insert(rows);
      if (insErr) console.error(`seo-rank-tracking submit ${locationId}: inserting seo_rank_tasks failed: ${insErr.message}`);
    }
  }

  await settleSubmit(loc.client_id, locationId, true, null, submittedCount, tasks.length);
}

async function settleSubmit(
  clientId: string,
  locationId: string,
  success: boolean,
  error: string | null,
  submitted = 0,
  attempted = 0,
): Promise<void> {
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: clientId,
    p_job_type: "seo_rank_submit",
    p_success: success,
    p_error: error,
    p_base_interval_minutes: BASE_INTERVAL_MINUTES,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: locationId,
  });
  if (jobError) console.error(`seo-rank-tracking submit ${locationId}: complete_job_attempt failed: ${jobError.message}`);
  console.log(`seo-rank-tracking submit ${locationId}: ${submitted}/${attempted} tasks submitted`);
}

// -----------------------------------------------------------------------------
// COLLECT
// -----------------------------------------------------------------------------

async function collectReadyTasks(): Promise<{ collected: number; stillPending: number }> {
  const res = await fetch(`${DATAFORSEO_BASE}/serp/google/organic/tasks_ready`, {
    headers: { Authorization: dataForSeoAuthHeader() },
  });
  if (!res.ok) {
    console.error(`seo-rank-tracking collect: tasks_ready HTTP ${res.status}`);
    return { collected: 0, stillPending: 0 };
  }
  const readyBody = await res.json();
  const readyIds = new Set<string>(
    ((readyBody.tasks?.[0]?.result ?? []) as { id: string }[]).map((r) => r.id),
  );

  const { data: pending, error: pendingError } = await supabase
    .from("seo_rank_tasks")
    .select("id, client_id, location_id, keyword_id, is_geo_grid, grid_row, grid_col, dataforseo_task_id")
    .eq("status", "submitted");
  if (pendingError) {
    console.error(`seo-rank-tracking collect: reading pending tasks failed: ${pendingError.message}`);
    return { collected: 0, stillPending: 0 };
  }

  const ours = (pending ?? []).filter((t) => readyIds.has(t.dataforseo_task_id));
  let collected = 0;

  for (const task of ours) {
    try {
      await collectOne(task);
      collected++;
    } catch (e) {
      const reason = e instanceof Error ? e.message : "collect failed";
      console.error(`seo-rank-tracking collect ${task.id}: ${reason}`);
      await supabase
        .from("seo_rank_tasks")
        .update({ status: "failed", last_error: reason })
        .eq("id", task.id);
    }
  }

  return { collected, stillPending: (pending?.length ?? 0) - collected };
}

type PendingTask = {
  id: string;
  client_id: string;
  location_id: string;
  keyword_id: string;
  is_geo_grid: boolean;
  grid_row: number;
  grid_col: number;
  dataforseo_task_id: string;
};

async function collectOne(task: PendingTask): Promise<void> {
  const res = await fetch(`${DATAFORSEO_BASE}/serp/google/organic/task_get/advanced/${task.dataforseo_task_id}`, {
    headers: { Authorization: dataForSeoAuthHeader() },
  });
  if (!res.ok) throw new Error(`task_get HTTP ${res.status}`);
  const body = await res.json();
  const taskResult = body.tasks?.[0];
  if (!taskResult || taskResult.status_code >= 40000) {
    throw new Error(`dataforseo task error: status_code=${taskResult?.status_code}`);
  }

  const result = taskResult.result?.[0];
  const items: SerpItem[] = result?.items ?? [];
  const checkUrl: string | null = result?.check_url ?? null;

  const { data: loc } = await supabase
    .from("seo_locations")
    .select("name, phone_number, website_url")
    .eq("id", task.location_id)
    .maybeSingle();
  const own = { domain: loc?.website_url ?? null, phone: loc?.phone_number ?? null, businessName: loc?.name ?? null };

  const rankingRows: Record<string, unknown>[] = [];

  if (task.is_geo_grid) {
    // Geo grid tracks LOCAL PACK visibility specifically — that's the
    // conventional meaning of a geo-grid tool (organic barely moves over a
    // few km; local pack moves a lot, which is the whole reason to check).
    const match = findOwnRanking(items, "local_pack", own);
    rankingRows.push({
      client_id: task.client_id,
      location_id: task.location_id,
      keyword_id: task.keyword_id,
      rank_type: "geo_grid",
      grid_row: task.grid_row,
      grid_col: task.grid_col,
      position: match?.position ?? null,
      serp_url: checkUrl,
      raw: { items },
    });
  } else {
    const organicMatch = findOwnRanking(items, "organic", own);
    rankingRows.push({
      client_id: task.client_id,
      location_id: task.location_id,
      keyword_id: task.keyword_id,
      rank_type: "organic",
      position: organicMatch?.position ?? null,
      serp_url: checkUrl,
      raw: { items },
    });

    const localPackMatch = findOwnRanking(items, "local_pack", own);
    const hasLocalPack = items.some((i) => i.type === "local_pack");
    if (hasLocalPack) {
      rankingRows.push({
        client_id: task.client_id,
        location_id: task.location_id,
        keyword_id: task.keyword_id,
        rank_type: "local_pack",
        position: localPackMatch?.position ?? null,
        serp_url: checkUrl,
        raw: { items },
      });
    }
  }

  const { error: upsertError } = await supabase
    .from("seo_rankings")
    .upsert(rankingRows, { onConflict: "keyword_id,rank_type,grid_row,grid_col,check_date" });
  if (upsertError) throw new Error(`writing seo_rankings failed: ${upsertError.message}`);

  // Module 18: competitor positions from this same SERP, no extra vendor
  // call. Not for geo-grid cells — seo_competitor_rankings has no grid
  // columns. A failure here must not fail the task: the location's own
  // rankings are already written, and a 'failed' task is never retried, so
  // the error goes on the row while it is still marked collected.
  let competitorError: string | null = null;
  if (!task.is_geo_grid) {
    try {
      await writeCompetitorRankings(task, items, checkUrl);
    } catch (e) {
      competitorError = `competitor rankings: ${e instanceof Error ? e.message : "failed"}`;
      console.error(`seo-rank-tracking collect ${task.id}: ${competitorError}`);
    }
  }

  const { error: updateError } = await supabase
    .from("seo_rank_tasks")
    .update({ status: "collected", collected_at: new Date().toISOString(), last_error: competitorError })
    .eq("id", task.id);
  if (updateError) throw new Error(`marking task collected failed: ${updateError.message}`);
}

async function writeCompetitorRankings(task: PendingTask, items: SerpItem[], checkUrl: string | null): Promise<void> {
  const { data: competitors, error: compError } = await supabase
    .from("seo_competitors")
    .select("id, domain")
    .eq("location_id", task.location_id)
    .eq("is_active", true);
  if (compError) throw new Error(compError.message);
  if (!competitors || competitors.length === 0) return;

  const rows = matchCompetitors(items, competitors).map((r) => ({
    client_id: task.client_id,
    location_id: task.location_id,
    keyword_id: task.keyword_id,
    serp_url: checkUrl,
    ...r,
  }));
  if (rows.length === 0) return;

  const { error } = await supabase
    .from("seo_competitor_rankings")
    .upsert(rows, { onConflict: "competitor_id,keyword_id,rank_type,check_date" });
  if (error) throw new Error(error.message);
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

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

  const action = String(body.action ?? "");

  if (action === "submit") {
    const locationId = String(body.location_id ?? "").trim();
    if (!locationId) return json({ error: "location_id is required for submit" }, 400);
    try {
      await submitForLocation(locationId);
      return json({ ok: true, action: "submit", location_id: locationId });
    } catch (e) {
      const reason = e instanceof Error ? e.message : "submit failed";
      console.error(`seo-rank-tracking submit ${locationId} unhandled: ${reason}`);
      const { data: loc } = await supabase.from("seo_locations").select("client_id").eq("id", locationId).maybeSingle();
      if (loc) await settleSubmit(loc.client_id, locationId, false, reason);
      return json({ ok: false, error: reason }, 500);
    }
  }

  if (action === "collect") {
    try {
      const result = await collectReadyTasks();
      return json({ ok: true, action: "collect", ...result });
    } catch (e) {
      const reason = e instanceof Error ? e.message : "collect failed";
      console.error(`seo-rank-tracking collect unhandled: ${reason}`);
      return json({ ok: false, error: reason }, 500);
    }
  }

  return json({ error: "action must be 'submit' or 'collect'" }, 400);
});
