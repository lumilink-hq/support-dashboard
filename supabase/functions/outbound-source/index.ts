// =============================================================================
// outbound-source — outbound engine Phase 1 step 2 (docs/OUTBOUND-PLAN.md):
// buy one page of businesses from DataForSEO's business listings search for
// each due profile, and save them as outbound_leads.
//
//   POST /outbound-source
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   {}                              every due active profile
//           { "profile_id": "<uuid>" }      one profile (must be active)
//           { "profile_id", "force": true } one profile in any status, ignoring
//                                           the daily spacing and backlog cap
//           { ..., "dry_run": true }        build and return the request only;
//                                           no DataForSEO call, no spend
//
// MUST be deployed with --no-verify-jwt (shared-secret auth, like every other
// function in this project).
//
// SPEND CONTROL. One Live call per profile per run (about $0.012 + $0.00036
// per listing, so a 1,000-listing page is about $0.37). A profile is skipped
// when it was sourced in the last 20 hours, when its audience is exhausted,
// or when it already has 5 days of leads waiting (sourced / email_found /
// verified) — buying more than enrich and verify can work through wastes
// money. Every call reserves the shared 'dataforseo' vendor budget (0048).
//
// PAGING. The profile keeps DataForSEO's offset_token plus a key of the
// request it belongs to (0301). An audience edit changes the key, so paging
// restarts from the top and dedupe drops what's already on file.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  AudienceError,
  buildListingsRequest,
  cursorKey,
  type LeadRow,
  pageLimit,
  parseListing,
  readPage,
  type SkipReason,
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

const LISTINGS_PATH = "/business_data/business_listings/search/live";
const DATAFORSEO_BASE = "https://api.dataforseo.com/v3";
const MIN_HOURS_BETWEEN_RUNS = 20;
const BACKLOG_DAYS = 5;
const WAITING_STAGES = ["sourced", "email_found", "verified"];

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Profile = {
  id: string;
  name: string;
  status: string;
  audience: unknown;
  daily_lead_target: number;
  source_cursor_key: string | null;
  source_offset_token: string | null;
  source_exhausted_at: string | null;
  last_sourced_at: string | null;
};

type Outcome = Record<string, unknown> & { profile_id: string; outcome: string };

/** One Live call. Reserves vendor budget first; returns tasks[0].result and
 * the call's cost, or throws with a message worth returning. */
async function listings(body: Record<string, unknown>): Promise<{ result: unknown; cost: number | null }> {
  const { data: allowed, error: budgetError } = await supabase.rpc("check_and_reserve_vendor_budget", {
    p_vendor: "dataforseo",
  });
  if (budgetError) throw new Error(`vendor budget check failed: ${budgetError.message}`);
  if (!allowed) throw new Error("dataforseo vendor budget exhausted this window");

  const res = await fetch(`${DATAFORSEO_BASE}${LISTINGS_PATH}`, {
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
  if (!res.ok) throw new Error(`dataforseo listings HTTP ${res.status}: ${message ?? ""}`.trim());
  if (!task || statusCode !== 20000) throw new Error(`dataforseo listings status ${statusCode}: ${message}`);
  return { result: task.result, cost: typeof payload?.cost === "number" ? payload.cost : null };
}

async function waitingCount(profileId: string): Promise<number> {
  const { count, error } = await supabase
    .from("outbound_leads")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId)
    .in("stage", WAITING_STAGES);
  if (error) throw new Error(`backlog count failed: ${error.message}`);
  return count ?? 0;
}

async function sourceProfile(p: Profile, opts: { force: boolean; dryRun: boolean }): Promise<Outcome> {
  const base = { profile_id: p.id, profile: p.name };
  const limit = pageLimit(p.daily_lead_target);

  let request;
  try {
    request = buildListingsRequest(p.audience, limit);
  } catch (e) {
    if (e instanceof AudienceError) return { ...base, outcome: "bad_audience", error: e.message };
    throw e;
  }
  const key = cursorKey(request);
  const sameRequest = key === p.source_cursor_key;

  if (!opts.force) {
    if (sameRequest && p.source_exhausted_at) return { ...base, outcome: "exhausted" };
    if (p.last_sourced_at && Date.now() - Date.parse(p.last_sourced_at) < MIN_HOURS_BETWEEN_RUNS * 3600_000) {
      return { ...base, outcome: "sourced_recently", last_sourced_at: p.last_sourced_at };
    }
    const waiting = await waitingCount(p.id);
    if (waiting >= p.daily_lead_target * BACKLOG_DAYS) return { ...base, outcome: "backlog_full", waiting };
  }

  const token = sameRequest ? p.source_offset_token : null;
  const body = token ? { ...request, offset_token: token } : request;
  if (opts.dryRun) return { ...base, outcome: "dry_run", request: body, restarts_paging: !sameRequest };

  const { result, cost } = await listings(body);
  const page = readPage(result, limit);

  const requireWebsite = (p.audience as { require_website?: boolean })?.require_website !== false;
  const rows: LeadRow[] = [];
  const skipped: Partial<Record<SkipReason, number>> = {};
  for (const item of page.items) {
    const parsed = parseListing(item, requireWebsite);
    if ("row" in parsed) rows.push(parsed.row);
    else skipped[parsed.skip] = (skipped[parsed.skip] ?? 0) + 1;
  }

  let saved: Record<string, number> = { received: 0, inserted: 0, duplicates: 0, suppressed: 0, invalid: 0 };
  if (rows.length > 0) {
    const { data, error } = await supabase.rpc("outbound_insert_leads", {
      p_profile_id: p.id,
      p_rows: rows,
    });
    if (error) throw new Error(`outbound_insert_leads failed: ${error.message}`);
    saved = data as Record<string, number>;
  }

  const { error: cursorError } = await supabase
    .from("outbound_profiles")
    .update({
      source_cursor_key: key,
      source_offset_token: page.exhausted ? null : page.nextToken,
      source_total_count: page.total,
      source_exhausted_at: page.exhausted ? new Date().toISOString() : null,
      last_sourced_at: new Date().toISOString(),
    })
    .eq("id", p.id);
  // The leads are saved either way; a lost cursor only means the next run
  // re-buys this page, and dedupe drops it.
  if (cursorError) console.error(`outbound-source ${p.id}: cursor update failed: ${cursorError.message}`);

  return {
    ...base,
    outcome: "sourced",
    cost,
    listings: page.items.length,
    total_available: page.total,
    exhausted: page.exhausted,
    skipped,
    ...saved,
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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) ?? {};
  } catch {
    body = {};
  }
  const profileId = typeof body.profile_id === "string" ? body.profile_id : null;
  const force = body.force === true;
  const dryRun = body.dry_run === true;

  if (!dryRun && (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD)) {
    console.error("DATAFORSEO_LOGIN/PASSWORD unset — refusing to run");
    return json({ error: "Server not configured" }, 500);
  }

  let query = supabase
    .from("outbound_profiles")
    .select(
      "id, name, status, audience, daily_lead_target, source_cursor_key, source_offset_token, source_exhausted_at, last_sourced_at",
    );
  if (profileId) query = query.eq("id", profileId);
  else query = query.eq("status", "active");

  const { data: profiles, error } = await query;
  if (error) return json({ error: `profile lookup failed: ${error.message}` }, 500);
  if (profileId && (!profiles || profiles.length === 0)) return json({ error: "Profile not found" }, 404);

  const results: Outcome[] = [];
  for (const p of (profiles ?? []) as Profile[]) {
    if (p.status !== "active" && !force) {
      results.push({ profile_id: p.id, profile: p.name, outcome: "not_active", status: p.status });
      continue;
    }
    try {
      results.push(await sourceProfile(p, { force, dryRun }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`outbound-source ${p.id}: ${message}`);
      results.push({ profile_id: p.id, profile: p.name, outcome: "error", error: message });
    }
  }

  return json({ profiles: results.length, results });
});
