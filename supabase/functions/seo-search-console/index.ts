// =============================================================================
// seo-search-console — module 21 (plan.md, Phase 6b): daily Search Console
// Search Analytics pull for one client's properties.
//
//   POST /seo-search-console
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "client_id": "<uuid>", "full": true? }
//
// Admin endpoint, same posture as the other seo-* functions. MUST be deployed
// with --no-verify-jwt (see this repo's memory on that). `full: true` redoes
// the 16-month backfill (safe: every write is an upsert or a per-month replace).
//
// PER PROPERTY. The client's distinct seo_locations.search_console_site_url
// values are pulled once each, however many locations share them.
//
// PER RUN, PER PROPERTY:
//   1. ["date"]           -> seo_search_daily (device 'all'): the true totals.
//   2. ["date","device"]  -> seo_search_daily per device.
//   3. monthly rollups, from a queue (seo_search_properties.months_pending):
//      the months this run touched join it, then the newest MONTHS_PER_RUN are
//      built: ["page"] and ["query"] over that month -> top 500 of each,
//      replacing the month's rows; the query rows are first counted in full
//      into seo_search_keyword_counts. The edge runtime's CPU limit is why it's
//      a queue: a month can be tens of thousands of query rows, so a 16-month
//      backfill drains over several calls, 15 minutes apart.
// dataState is Google's default, "final", so a day is only stored once
// Search Console calls it final (it lags 2 to 3 days); the trailing days are
// re-pulled every run anyway (lib.ts REPULL_DAYS).
//
// TOKEN. Reads module 2's cached access token, like seo-technical-audit. A stale
// cache means google-token-refresh is unhealthy; this run fails and retries
// instead of refreshing inline.
//
// NEVER ZEROS. No connection / no scope -> the property is marked
// 'not_connected'; Google refusing the property -> 'no_access'. The portal says
// so with the last data date. Nothing here writes a zero row for a missing day.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET; GOOGLE_API_BASE (optional, default
//      https://www.googleapis.com; only ever changed to point a local test run
//      at a mock Search Console).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  backoffMs,
  classifyStatus,
  dailyRows,
  isoDate,
  keywordCounts,
  latestDate,
  mergeTop,
  monthEnd,
  monthsBetween,
  MONTHS_PER_RUN,
  normalisePageUrl,
  normaliseQuery,
  pendingMonths,
  syncWindow,
  type ApiRow,
  type DailyRow,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const GOOGLE_API_BASE = (Deno.env.get("GOOGLE_API_BASE") ?? "https://www.googleapis.com").replace(/\/+$/, "");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const JOB_TYPE = "seo_search_console";
const BASE_INTERVAL_MINUTES = 24 * 60; // daily
const RETRY_INTERVAL_MINUTES = 60;
const BACKFILL_INTERVAL_MINUTES = 15; // while monthly rollups are still queued
const MAX_BACKOFF_MINUTES = 24 * 60;
const ROW_LIMIT = 25_000; // the API's maximum per request
const MAX_PAGES = 8; // 200k rows per query: far above any site we serve; a circuit breaker
const MAX_ATTEMPTS = 3;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class PropertyError extends Error {
  constructor(public outcome: "no_access" | "retry" | "fatal", message: string) {
    super(message);
  }
}

/** One Search Analytics request, with budget reservation and exponential backoff (rule 6). */
async function queryOnce(token: string, siteUrl: string, body: Record<string, unknown>): Promise<ApiRow[]> {
  const url = `${GOOGLE_API_BASE}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  for (let attempt = 0; ; attempt++) {
    const { data: allowed, error: budgetError } = await supabase.rpc("check_and_reserve_vendor_budget", { p_vendor: "google" });
    if (budgetError) throw new PropertyError("retry", `vendor budget check failed: ${budgetError.message}`);
    if (!allowed) throw new PropertyError("retry", "google vendor budget exhausted this window");

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (attempt + 1 < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      throw new PropertyError("retry", `Search Analytics fetch failed: ${String(e)}`);
    }

    const outcome = classifyStatus(res.status);
    if (outcome === "ok") {
      const payload = (await res.json()) as { rows?: ApiRow[] };
      return payload.rows ?? [];
    }
    const text = (await res.text().catch(() => "")).slice(0, 300);
    // 401 won't fix itself in a second; 429/5xx might.
    if (outcome === "retry" && res.status !== 401 && attempt + 1 < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      continue;
    }
    throw new PropertyError(outcome === "ok" ? "fatal" : outcome, `Search Analytics ${res.status}: ${text}`);
  }
}

/** Every row of a query, paging with startRow until a short page. */
async function queryAll(token: string, siteUrl: string, body: Record<string, unknown>): Promise<ApiRow[]> {
  const out: ApiRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await queryOnce(token, siteUrl, { ...body, rowLimit: ROW_LIMIT, startRow: page * ROW_LIMIT });
    out.push(...rows);
    if (rows.length < ROW_LIMIT) return out;
  }
  console.warn(`seo-search-console: ${siteUrl} hit the ${MAX_PAGES}-page cap for ${JSON.stringify(body.dimensions)}`);
  return out;
}

async function upsertChunks(table: string, rows: Record<string, unknown>[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + 1000), { onConflict });
    if (error) throw new PropertyError("retry", `writing ${table} failed: ${error.message}`);
  }
}

async function setProperty(clientId: string, siteUrl: string, patch: Record<string, unknown>) {
  const { error } = await supabase
    .from("seo_search_properties")
    .upsert({ client_id: clientId, site_url: siteUrl, ...patch }, { onConflict: "client_id,site_url" });
  if (error) console.error(`seo-search-console ${clientId} ${siteUrl}: recording property state failed: ${error.message}`);
}

type PropertyRow = { data_through: string | null; backfilled_at: string | null; months_pending: string[] };

async function syncProperty(clientId: string, siteUrl: string, token: string, full: boolean): Promise<Record<string, unknown>> {
  const { data: existing } = await supabase
    .from("seo_search_properties")
    .select("data_through, backfilled_at, months_pending")
    .eq("client_id", clientId)
    .eq("site_url", siteUrl)
    .maybeSingle();
  const prop = (existing as PropertyRow | null) ?? { data_through: null, backfilled_at: null, months_pending: [] };
  const today = isoDate(new Date());
  const win = syncWindow(full ? { data_through: null, backfilled_at: null } : prop, today);
  const previousQueue = full ? [] : prop.months_pending ?? [];
  const base = { startDate: win.start, endDate: win.end, type: "web", dataState: "final" };

  // 1 + 2: daily totals and the device split.
  const totals = dailyRows(await queryAll(token, siteUrl, { ...base, dimensions: ["date"] }), false);
  const devices = dailyRows(await queryAll(token, siteUrl, { ...base, dimensions: ["date", "device"] }), true);
  const toRow = (r: DailyRow) => ({ client_id: clientId, site_url: siteUrl, ...r });
  await upsertChunks("seo_search_daily", [...totals, ...devices].map(toRow), "client_id,site_url,date,device");

  const newest = latestDate(totals);
  const dataThrough = !newest ? prop.data_through : !prop.data_through || newest > prop.data_through ? newest : prop.data_through;

  // 3: monthly rollups from the queue, newest first. No final data at all yet
  // (a brand-new property): nothing to build.
  // The months this run's window touched join the queue only when new final
  // data arrived (or on a backfill). Otherwise every 15-minute drain run would
  // rebuild the current month again instead of working through the queue.
  const fresh = win.backfill || (!!newest && (!prop.data_through || newest > prop.data_through));
  const queue = pendingMonths(previousQueue, fresh && dataThrough ? monthsBetween(win.start, dataThrough) : [], dataThrough);
  const months = queue.slice(0, MONTHS_PER_RUN);
  const left = queue.slice(MONTHS_PER_RUN);
  for (const m of months) {
    const end = monthEnd(m) < dataThrough! ? monthEnd(m) : dataThrough!;
    const range = { ...base, startDate: m, endDate: end };
    const pageRows = await queryAll(token, siteUrl, { ...range, dimensions: ["page"] });
    const queryRows = await queryAll(token, siteUrl, { ...range, dimensions: ["query"] });

    const pages = mergeTop(pageRows, normalisePageUrl);
    const queries = mergeTop(queryRows, normaliseQuery);
    const counts = keywordCounts(queryRows);

    for (const table of ["seo_search_monthly_pages", "seo_search_monthly_queries"]) {
      const { error } = await supabase.from(table).delete().eq("client_id", clientId).eq("site_url", siteUrl).eq("month", m);
      if (error) throw new PropertyError("retry", `clearing ${table} for ${m} failed: ${error.message}`);
    }
    await upsertChunks(
      "seo_search_monthly_pages",
      pages.map((p) => ({ client_id: clientId, site_url: siteUrl, month: m, page: p.key, clicks: p.clicks, impressions: p.impressions, position: p.position })),
      "client_id,site_url,month,page",
    );
    await upsertChunks(
      "seo_search_monthly_queries",
      queries.map((q) => ({ client_id: clientId, site_url: siteUrl, month: m, query: q.key, clicks: q.clicks, impressions: q.impressions, position: q.position })),
      "client_id,site_url,month,query",
    );

    const { count: days } = await supabase
      .from("seo_search_daily")
      .select("date", { count: "exact", head: true })
      .eq("client_id", clientId)
      .eq("site_url", siteUrl)
      .eq("device", "all")
      .gte("date", m)
      .lte("date", monthEnd(m));
    await upsertChunks(
      "seo_search_keyword_counts",
      [{
        client_id: clientId,
        site_url: siteUrl,
        month: m,
        ...counts,
        is_complete: monthEnd(m) <= dataThrough!,
        days_covered: days ?? 0,
      }],
      "client_id,site_url,month",
    );
  }

  const now = new Date().toISOString();
  await setProperty(clientId, siteUrl, {
    status: "ok",
    data_through: dataThrough,
    months_pending: left,
    // The backfill counts as done only if it actually returned data; an empty
    // new property retries the full window tomorrow.
    backfilled_at: win.backfill ? (dataThrough ? now : null) : prop.backfilled_at,
    last_synced_at: now,
    last_error: null,
  });

  return { site_url: siteUrl, from: win.start, data_through: dataThrough, days: totals.length, months_built: months, months_left: left.length, backfill: win.backfill };
}

async function accessToken(clientId: string): Promise<{ token: string } | { state: "not_connected" | "stale"; reason: string }> {
  const { data: connection } = await supabase
    .from("google_oauth_connections")
    .select("status, granted_scopes")
    .eq("client_id", clientId)
    .maybeSingle();
  if (!connection || connection.status !== "connected") {
    return { state: "not_connected", reason: connection ? `Google connection is ${connection.status}` : "Google isn't connected" };
  }
  if (!(connection.granted_scopes as string[]).some((s) => s.includes("webmasters"))) {
    return { state: "not_connected", reason: "the Google connection doesn't include Search Console" };
  }
  const { data: tokenRow } = await supabase
    .from("google_oauth_tokens")
    .select("access_token_cache, access_token_expires_at")
    .eq("client_id", clientId)
    .maybeSingle();
  if (!tokenRow?.access_token_cache) return { state: "stale", reason: "no cached access token yet" };
  // Two minutes of margin: a backfill makes a few dozen calls.
  if (tokenRow.access_token_expires_at && new Date(tokenRow.access_token_expires_at).getTime() < Date.now() + 120_000) {
    return { state: "stale", reason: "cached access token is expired (is google-token-refresh running?)" };
  }
  return { token: tokenRow.access_token_cache as string };
}

async function settle(clientId: string, success: boolean, error: string | null, more = false) {
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: clientId,
    p_job_type: JOB_TYPE,
    p_success: success,
    p_error: error,
    p_base_interval_minutes: !success ? RETRY_INTERVAL_MINUTES : more ? BACKFILL_INTERVAL_MINUTES : BASE_INTERVAL_MINUTES,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: null,
  });
  if (jobError) console.error(`seo-search-console ${clientId}: complete_job_attempt failed: ${jobError.message}`);
}

async function runClient(clientId: string, full: boolean): Promise<{ ok: boolean; more: boolean; results: Record<string, unknown>[] }> {
  const { data: locs, error } = await supabase
    .from("seo_locations")
    .select("search_console_site_url")
    .eq("client_id", clientId)
    .eq("is_active", true);
  if (error) throw new Error(`loading locations failed: ${error.message}`);
  const sites = [...new Set((locs ?? []).map((l) => String(l.search_console_site_url ?? "").trim()).filter(Boolean))].sort();
  if (sites.length === 0) return { ok: true, more: false, results: [{ status: "no_properties" }] };

  const tok = await accessToken(clientId);
  if (!("token" in tok)) {
    if (tok.state === "not_connected") {
      for (const s of sites) await setProperty(clientId, s, { status: "not_connected", last_error: tok.reason });
      // Nothing to retry hourly: check again tomorrow.
      return { ok: true, more: false, results: sites.map((s) => ({ site_url: s, status: "not_connected", reason: tok.reason })) };
    }
    return { ok: false, more: false, results: [{ status: "token_stale", reason: tok.reason }] };
  }

  const results: Record<string, unknown>[] = [];
  let ok = true;
  for (const s of sites) {
    try {
      results.push(await syncProperty(clientId, s, tok.token, full));
    } catch (e) {
      const outcome = e instanceof PropertyError ? e.outcome : "retry";
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`seo-search-console ${clientId} ${s}: ${reason}`);
      await setProperty(clientId, s, { status: outcome === "no_access" ? "no_access" : "error", last_error: reason });
      // A property Google refuses is recorded and shown; it isn't worth an hourly retry.
      if (outcome !== "no_access") ok = false;
      results.push({ site_url: s, status: outcome, error: reason });
    }
  }
  const more = results.some((r) => typeof r.months_left === "number" && r.months_left > 0);
  return { ok, more, results };
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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const clientId = String(body.client_id ?? "").trim();
  if (!clientId) return json({ error: "client_id is required" }, 400);

  try {
    const { ok, more, results } = await runClient(clientId, body.full === true);
    const failed = results.filter((r) => r.status === "retry" || r.status === "fatal" || r.status === "token_stale");
    await settle(clientId, ok, ok ? null : failed.map((r) => String(r.error ?? r.reason ?? r.status)).join("; ").slice(0, 500), more);
    console.log(`seo-search-console ${clientId}: ${JSON.stringify(results)}`);
    return json({ ok, client_id: clientId, results }, ok ? 200 : 502);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "Search Console pull failed";
    console.error(`seo-search-console ${clientId} failed: ${reason}`);
    await settle(clientId, false, reason);
    return json({ ok: false, error: reason }, 500);
  }
});
