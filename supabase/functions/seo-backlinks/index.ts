// =============================================================================
// seo-backlinks — module 15 (plan.md): monthly backlink profile for one
// location from DataForSEO's Backlinks API.
//
//   POST /seo-backlinks
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "location_id": "<uuid>" }
//
// Admin endpoint, same posture as seo-crawl/seo-technical-audit. MUST be
// deployed with --no-verify-jwt (see this repo's memory on that).
//
// THREE LIVE CALLS PER LOCATION, all request/response (unlike rank tracking's
// async queue): summary (totals), timeseries_new_lost_summary (gained/lost for
// the last COMPLETE month), domain_pages_summary (top linked pages). Summary is
// required — if it fails the run fails and backs off. The other two are
// best-effort: a snapshot with null gained/lost or no top pages is still
// useful, and the failure is recorded in raw.errors rather than hidden.
//
// SUBSCRIPTION. DataForSEO's docs disagree on whether the Backlinks API needs
// its own subscription. An access-denied response fails the run with the
// distinct last_error 'dataforseo_backlinks_not_subscribed' so it can be told
// apart from a transient failure in job_attempts.
//
// SHARED WEBSITES. Backlinks belong to a domain, not a location. If a sibling
// location of the same client already has a snapshot for the same domain
// today, it is copied instead of buying the same three calls again.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  isNotSubscribedError,
  lastCompleteMonth,
  parseNewLost,
  parseSummary,
  parseTopPages,
  targetDomain,
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

const DATAFORSEO_BASE = "https://api.dataforseo.com/v3";
const TOP_PAGES_LIMIT = 10;
const BASE_INTERVAL_MINUTES = 30 * 24 * 60; // monthly, per plan.md
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
 * task's `result` array, or throws with a message worth storing as last_error. */
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

  if (isNotSubscribedError(statusCode, message)) throw new Error("dataforseo_backlinks_not_subscribed");
  if (!res.ok) throw new Error(`dataforseo ${path} HTTP ${res.status}`);
  if (!task || statusCode !== 20000) throw new Error(`dataforseo ${path} status ${statusCode}: ${message}`);
  return task.result;
}

async function settle(clientId: string, locationId: string, success: boolean, error: string | null): Promise<void> {
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: clientId,
    p_job_type: "seo_backlinks",
    p_success: success,
    p_error: error,
    p_base_interval_minutes: BASE_INTERVAL_MINUTES,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: locationId,
  });
  if (jobError) console.error(`seo-backlinks ${locationId}: complete_job_attempt failed: ${jobError.message}`);
}

type LocationRow = { id: string; client_id: string; website_url: string | null };

async function pullLocation(loc: LocationRow): Promise<string> {
  const domain = targetDomain(loc.website_url);
  if (!domain) {
    await settle(loc.client_id, loc.id, true, null);
    return "no_domain";
  }

  const today = new Date();
  const snapshotDate = today.toISOString().slice(0, 10);

  // A sibling location on the same domain already pulled today — copy it.
  const { data: sibling } = await supabase
    .from("seo_backlink_snapshots")
    .select("referring_domains_count, total_backlinks, gained_count, lost_count, top_linked_pages, raw")
    .eq("client_id", loc.client_id)
    .eq("snapshot_date", snapshotDate)
    .eq("raw->>target", domain)
    .neq("location_id", loc.id)
    .limit(1)
    .maybeSingle();
  if (sibling) {
    const { error } = await supabase.from("seo_backlink_snapshots").upsert(
      {
        client_id: loc.client_id,
        location_id: loc.id,
        snapshot_date: snapshotDate,
        ...sibling,
        raw: { ...(sibling.raw as Record<string, unknown>), copied_from_sibling: true },
      },
      { onConflict: "location_id,snapshot_date" },
    );
    if (error) throw new Error(`copying sibling snapshot failed: ${error.message}`);
    await settle(loc.client_id, loc.id, true, null);
    return "copied";
  }

  // Required: totals. Any failure here fails the run.
  const summaryResult = (await dataForSeo("/backlinks/summary/live", { target: domain, internal_list_limit: 1 })) as
    | Record<string, unknown>[]
    | null;
  const summaryRow = summaryResult?.[0] ?? null;
  const summary = parseSummary(summaryRow);

  const errors: string[] = [];
  const month = lastCompleteMonth(today);

  let newLostRaw: unknown = null;
  let newLost = parseNewLost(null, month.from);
  try {
    newLostRaw = await dataForSeo("/backlinks/timeseries_new_lost_summary/live", {
      target: domain,
      date_from: month.from,
      date_to: month.to,
      group_range: "month",
    });
    newLost = parseNewLost(newLostRaw, month.from);
  } catch (e) {
    errors.push(`timeseries_new_lost_summary: ${e instanceof Error ? e.message : "failed"}`);
  }

  let topPagesRaw: unknown = null;
  let topPages: ReturnType<typeof parseTopPages> = [];
  try {
    topPagesRaw = await dataForSeo("/backlinks/domain_pages_summary/live", {
      target: domain,
      limit: TOP_PAGES_LIMIT,
      order_by: ["backlinks,desc"],
    });
    topPages = parseTopPages(topPagesRaw, TOP_PAGES_LIMIT);
  } catch (e) {
    errors.push(`domain_pages_summary: ${e instanceof Error ? e.message : "failed"}`);
  }

  const { error: upsertError } = await supabase.from("seo_backlink_snapshots").upsert(
    {
      client_id: loc.client_id,
      location_id: loc.id,
      snapshot_date: snapshotDate,
      referring_domains_count: summary.referring_domains,
      total_backlinks: summary.total_backlinks,
      gained_count: newLost.gained_count,
      lost_count: newLost.lost_count,
      top_linked_pages: topPages,
      raw: {
        target: domain,
        rank: summary.rank,
        new_lost_period: newLost.period,
        new_referring_domains: newLost.new_referring_domains,
        lost_referring_domains: newLost.lost_referring_domains,
        summary: summaryRow,
        timeseries_new_lost_summary: newLostRaw,
        domain_pages_summary: topPagesRaw,
        errors,
      },
    },
    { onConflict: "location_id,snapshot_date" },
  );
  if (upsertError) throw new Error(`writing seo_backlink_snapshots failed: ${upsertError.message}`);

  await settle(loc.client_id, loc.id, true, null);
  console.log(
    `seo-backlinks ${loc.id}: ${domain} refdomains=${summary.referring_domains} backlinks=${summary.total_backlinks} errors=${errors.length}`,
  );
  return "pulled";
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
    const status = await pullLocation(loc as LocationRow);
    return json({ ok: true, status, location_id: locationId });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "backlink pull failed";
    console.error(`seo-backlinks ${locationId} failed: ${reason}`);
    await settle(loc.client_id, loc.id, false, reason);
    return json({ ok: false, error: reason }, 500);
  }
});
