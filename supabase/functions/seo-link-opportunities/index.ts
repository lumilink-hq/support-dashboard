// =============================================================================
// seo-link-opportunities — module 26 (plan.md, Phase 6c): monthly link
// opportunities for one location: the link gap with its competitors, links
// pointing at broken pages on its site, and recently lost links.
//
//   POST /seo-link-opportunities
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "location_id": "<uuid>" }
//
// Admin endpoint, same posture as the other seo-* functions. MUST be deployed
// with --no-verify-jwt.
//
// THREE INDEPENDENT PARTS (each best-effort; the run fails and backs off only
// when all of them fail):
//   gap    — one domain_intersection call per pair of active competitors (at
//            most 10), skipped with fewer than 2 competitors.
//   broken — one backlinks call: live links to 4xx/5xx pages on the site.
//            Written as seo_findings (module 'backlinks'), delete-then-insert
//            of the open ones like every other findings module, so Site
//            health lists them and a dismissal survives.
//   lost   — one backlinks call: links removed in the last 90 days.
// Gap and lost rows replace the location's previous ones; a part that failed
// keeps its previous rows.
//
// About $0.35 a location-month at 5 competitors (see 0066).
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD,
//      DATAFORSEO_BASE_URL (optional; tests point it at a mock).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  brokenBody,
  brokenFinding,
  competitorList,
  gapBody,
  groupBroken,
  lostBody,
  mergeGaps,
  pairs,
  parseLost,
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

const DATAFORSEO_BASE = Deno.env.get("DATAFORSEO_BASE_URL") ?? "https://api.dataforseo.com/v3";
const JOB_TYPE = "seo_link_opportunities";
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

async function dataForSeo(path: string, body: Record<string, unknown>): Promise<unknown> {
  const { data: allowed, error: budgetError } = await supabase.rpc("check_and_reserve_vendor_budget", { p_vendor: "dataforseo" });
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
  if (jobError) console.error(`seo-link-opportunities ${locationId}: complete_job_attempt failed: ${jobError.message}`);
}

type LocationRow = { id: string; client_id: string; website_url: string | null };

async function replaceRows(loc: LocationRow, kind: "gap" | "lost", rows: Record<string, unknown>[]): Promise<void> {
  const { error: delErr } = await supabase.from("seo_link_opportunities").delete().eq("location_id", loc.id).eq("kind", kind);
  if (delErr) throw new Error(`clearing ${kind} rows failed: ${delErr.message}`);
  if (!rows.length) return;
  const { error } = await supabase
    .from("seo_link_opportunities")
    .insert(rows.map((r) => ({ client_id: loc.client_id, location_id: loc.id, kind, ...r })));
  if (error) throw new Error(`writing ${kind} rows failed: ${error.message}`);
}

async function pullLocation(loc: LocationRow): Promise<Record<string, unknown>> {
  const site = targetDomain(loc.website_url);
  if (!site) return { status: "no_domain", errors: [] };

  const errors: string[] = [];
  const out: Record<string, unknown> = { site };
  let parts = 0;
  let ok = 0;

  // ---- Link gap -------------------------------------------------------------
  const { data: comps, error: cErr } = await supabase.from("seo_competitors").select("domain").eq("location_id", loc.id).eq("is_active", true).order("created_at");
  if (cErr) throw new Error(`reading seo_competitors failed: ${cErr.message}`);
  const competitors = competitorList(((comps ?? []) as { domain: string }[]).map((c) => c.domain), site);
  if (competitors.length < 2) {
    out.gap = `skipped: ${competitors.length} competitor${competitors.length === 1 ? "" : "s"} (needs 2)`;
  } else {
    parts++;
    const results: { pair: [string, string]; result: unknown }[] = [];
    for (const pair of pairs(competitors)) {
      try {
        results.push({ pair, result: await dataForSeo("/backlinks/domain_intersection/live", gapBody(pair[0], pair[1], site)) });
      } catch (e) {
        errors.push(`gap ${pair.join("+")}: ${e instanceof Error ? e.message : "failed"}`);
      }
    }
    if (results.length) {
      const gaps = mergeGaps(results, site);
      await replaceRows(
        loc,
        "gap",
        gaps.map((g) => ({ referring_domain: g.referring_domain, competitors: g.competitors, domain_rank: g.domain_rank, backlinks: g.backlinks })),
      );
      out.gap = `${gaps.length} sites from ${results.length} pair${results.length === 1 ? "" : "s"}`;
      ok++;
    }
  }

  // ---- Broken pages ---------------------------------------------------------
  parts++;
  try {
    const pages = groupBroken(await dataForSeo("/backlinks/backlinks/live", brokenBody(site)), site);
    const { error: delErr } = await supabase.from("seo_findings").delete().eq("location_id", loc.id).eq("module", "backlinks").eq("status", "open");
    if (delErr) throw new Error(`clearing findings failed: ${delErr.message}`);
    // A page already dismissed or actioned isn't re-reported as a new open finding.
    const { data: kept } = await supabase.from("seo_findings").select("target_url").eq("location_id", loc.id).eq("module", "backlinks").neq("status", "open");
    const skip = new Set(((kept ?? []) as { target_url: string | null }[]).map((k) => k.target_url));
    const rows = pages.filter((p) => !skip.has(p.url_to)).map((p) => ({ client_id: loc.client_id, location_id: loc.id, module: "backlinks", ...brokenFinding(p) }));
    if (rows.length) {
      const { error } = await supabase.from("seo_findings").insert(rows);
      if (error) throw new Error(`writing findings failed: ${error.message}`);
    }
    out.broken = `${pages.length} broken page${pages.length === 1 ? "" : "s"} with links`;
    ok++;
  } catch (e) {
    errors.push(`broken: ${e instanceof Error ? e.message : "failed"}`);
  }

  // ---- Lost links -----------------------------------------------------------
  parts++;
  try {
    const lost = parseLost(await dataForSeo("/backlinks/backlinks/live", lostBody(site)), site, new Date());
    await replaceRows(loc, "lost", lost.map((l) => ({ ...l })));
    out.lost = `${lost.length} lost link${lost.length === 1 ? "" : "s"}`;
    ok++;
  } catch (e) {
    errors.push(`lost: ${e instanceof Error ? e.message : "failed"}`);
  }

  out.status = ok === parts ? "ok" : ok === 0 ? "failed" : "partial";
  out.errors = errors;
  return out;
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

  const { data: loc, error } = await supabase.from("seo_locations").select("id, client_id, website_url").eq("id", locationId).maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!loc) return json({ error: "location not found" }, 404);

  try {
    const result = await pullLocation(loc as LocationRow);
    const failed = result.status === "failed";
    const errors = (result.errors as string[]) ?? [];
    await settle(loc.client_id, loc.id, !failed, failed ? errors.join("; ").slice(0, 500) : null);
    console.log(`seo-link-opportunities ${locationId}: ${JSON.stringify(result)}`);
    return json({ ok: !failed, location_id: locationId, ...result }, failed ? 502 : 200);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "link opportunities failed";
    console.error(`seo-link-opportunities ${locationId} failed: ${reason}`);
    await settle(loc.client_id, loc.id, false, reason);
    return json({ ok: false, error: reason }, 500);
  }
});
