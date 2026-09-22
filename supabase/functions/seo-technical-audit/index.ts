// =============================================================================
// seo-technical-audit — module 17 (plan.md): PageSpeed Insights, Search
// Console URL Inspection, and plain-HTTP status/redirect/robots/sitemap
// checks for one location.
//
//   POST /seo-technical-audit
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "location_id": "<uuid>" }
//
// Admin endpoint, same posture as seo-crawl/product-sync. MUST be deployed
// with --no-verify-jwt (see this repo's memory on that — every admin
// function here needs it, the deploy succeeds either way).
//
// THREE INDEPENDENT CHECKS, each best-effort — a PageSpeed failure must not
// skip the redirect/robots/sitemap checks, and a missing Search Console
// connection must not skip PageSpeed. Findings accumulate from whichever
// checks actually ran; nothing here treats "no Google connection yet" as a
// reason to produce zero findings.
//
// FINDING LIFECYCLE: same delete-then-insert as seo-crawl — open 'technical'
// findings for this location are replaced with this run's fresh set.
// Dismissed/actioned findings are untouched.
//
// MANUAL ACTIONS IS NOT HERE. See lib.ts's header — no public API exists.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, PAGESPEED_API_KEY, SEO_AUDIT_USER_AGENT (optional).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  analyzePsiResult,
  analyzeRedirectChain,
  analyzeRobotsTxt,
  analyzeSitemap,
  analyzeUrlInspection,
  type Finding,
  type RedirectHop,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const PAGESPEED_API_KEY = Deno.env.get("PAGESPEED_API_KEY");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const USER_AGENT =
  Deno.env.get("SEO_AUDIT_USER_AGENT") ??
  "LumilinkSeoBot/1.0 (+https://lumilinkhub.com/bot; technical SEO audit for our customer's own site)";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECT_HOPS = 10; // circuit breaker, distinct from the "3+ is a finding" threshold
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

// -----------------------------------------------------------------------------
// Redirect chain — manual redirect following (fetch's redirect:'manual'
// surfaces the Location header instead of silently resolving it), so each
// hop's status is visible rather than collapsed into just the final one.
// -----------------------------------------------------------------------------
async function traceRedirectChain(startUrl: string): Promise<RedirectHop[]> {
  const hops: RedirectHop[] = [];
  let current = startUrl;

  for (let i = 0; i < MAX_REDIRECT_HOPS; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(current, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "manual",
        signal: controller.signal,
      });
      hops.push({ url: current, status: res.status });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) break;
        current = new URL(location, current).toString();
        continue;
      }
      break;
    } catch {
      hops.push({ url: current, status: null });
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return hops;
}

async function fetchRobots(origin: string): Promise<string | null> {
  try {
    const res = await fetch(new URL("/robots.txt", origin).toString(), {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function findSitemap(origin: string, robots: string | null): Promise<{ found: boolean; url: string | null }> {
  // robots.txt's own Sitemap: directive wins — it's the site's explicit
  // statement of where its sitemap lives, which may not be the conventional
  // /sitemap.xml path at all.
  if (robots) {
    const m = /^sitemap:\s*(\S+)/im.exec(robots);
    if (m) {
      const url = m[1];
      try {
        const res = await fetch(url, { method: "HEAD", headers: { "User-Agent": USER_AGENT } });
        if (res.ok) return { found: true, url };
      } catch {
        // fall through to the conventional path
      }
    }
  }
  const conventional = new URL("/sitemap.xml", origin).toString();
  try {
    const res = await fetch(conventional, { method: "HEAD", headers: { "User-Agent": USER_AGENT } });
    return { found: res.ok, url: conventional };
  } catch {
    return { found: false, url: conventional };
  }
}

async function runPageSpeed(url: string): Promise<Finding[]> {
  if (!PAGESPEED_API_KEY) {
    console.log("seo-technical-audit: PAGESPEED_API_KEY not set — skipping PageSpeed Insights");
    return [];
  }

  const { data: allowed, error: budgetError } = await supabase.rpc("check_and_reserve_vendor_budget", {
    p_vendor: "google_pagespeed",
  });
  if (budgetError) {
    console.error(`seo-technical-audit: vendor budget check failed: ${budgetError.message}`);
    return [];
  }
  if (!allowed) {
    console.log("seo-technical-audit: google_pagespeed vendor budget exhausted this window — skipping");
    return [];
  }

  const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${PAGESPEED_API_KEY}&strategy=mobile&category=performance`;
  try {
    const res = await fetch(psiUrl);
    if (!res.ok) {
      console.error(`seo-technical-audit: PageSpeed Insights returned ${res.status} for ${url}`);
      return [];
    }
    const body = await res.json();
    return analyzePsiResult(body, "mobile");
  } catch (e) {
    console.error(`seo-technical-audit: PageSpeed Insights fetch failed: ${String(e)}`);
    return [];
  }
}

/** Reads the cached access token directly — service_role has table grants on
 * google_oauth_tokens (0046), no RPC needed for a backend job like this one. */
async function runUrlInspection(
  clientId: string,
  pageUrl: string,
  siteUrl: string,
): Promise<Finding[]> {
  const { data: connection } = await supabase
    .from("google_oauth_connections")
    .select("status, granted_scopes")
    .eq("client_id", clientId)
    .maybeSingle();
  if (!connection || connection.status !== "connected") return [];
  if (!(connection.granted_scopes as string[]).some((s) => s.includes("webmasters"))) return [];

  const { data: tokenRow } = await supabase
    .from("google_oauth_tokens")
    .select("access_token_cache, access_token_expires_at")
    .eq("client_id", clientId)
    .maybeSingle();
  if (!tokenRow?.access_token_cache) return [];
  // A token expiring within the next minute is as good as expired for this
  // one-shot call — module 2's scheduled refresh runs every 15 minutes and
  // renews anything within 10, so a stale cache here means that job is
  // unhealthy, not something to paper over with an inline refresh.
  if (tokenRow.access_token_expires_at && new Date(tokenRow.access_token_expires_at) < new Date()) return [];

  const { data: allowed, error: budgetError } = await supabase.rpc("check_and_reserve_vendor_budget", {
    p_vendor: "google",
  });
  if (budgetError || !allowed) return [];

  try {
    const res = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenRow.access_token_cache}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inspectionUrl: pageUrl, siteUrl }),
    });
    if (!res.ok) {
      console.error(`seo-technical-audit: URL Inspection returned ${res.status} for ${pageUrl}`);
      return [];
    }
    const body = await res.json();
    return analyzeUrlInspection(body.inspectionResult ?? {}, pageUrl);
  } catch (e) {
    console.error(`seo-technical-audit: URL Inspection fetch failed: ${String(e)}`);
    return [];
  }
}

type LocationRow = {
  id: string;
  client_id: string;
  website_url: string | null;
  search_console_site_url: string | null;
};

async function auditLocation(loc: LocationRow): Promise<void> {
  const startUrl = loc.website_url!;
  const origin = new URL(startUrl).origin;

  const [hops, robots, psiFindings] = await Promise.all([
    traceRedirectChain(startUrl),
    fetchRobots(origin),
    runPageSpeed(startUrl),
  ]);

  const sitemap = await findSitemap(origin, robots);

  const findings: (Finding & { target_url: string })[] = [
    ...analyzeRedirectChain(hops).map((f) => ({ ...f, target_url: startUrl })),
    ...analyzeRobotsTxt(robots !== null, robots).map((f) => ({ ...f, target_url: new URL("/robots.txt", origin).toString() })),
    ...analyzeSitemap(sitemap.found, sitemap.url).map((f) => ({ ...f, target_url: sitemap.url ?? startUrl })),
    ...psiFindings.map((f) => ({ ...f, target_url: startUrl })),
  ];

  if (loc.search_console_site_url) {
    const urlInspectionFindings = await runUrlInspection(loc.client_id, startUrl, loc.search_console_site_url);
    findings.push(...urlInspectionFindings.map((f) => ({ ...f, target_url: startUrl })));
  }

  const { error: delErr } = await supabase
    .from("seo_findings")
    .delete()
    .eq("location_id", loc.id)
    .eq("module", "technical")
    .eq("status", "open");
  if (delErr) console.error(`seo-technical-audit ${loc.id}: clearing old findings failed: ${delErr.message}`);

  if (findings.length > 0) {
    const rows = findings.map((f) => ({
      client_id: loc.client_id,
      location_id: loc.id,
      module: "technical",
      finding_type: f.finding_type,
      severity: f.severity,
      title: f.title,
      details: f.details,
      target_url: f.target_url,
    }));
    const { error: insErr } = await supabase.from("seo_findings").insert(rows);
    if (insErr) console.error(`seo-technical-audit ${loc.id}: inserting findings failed: ${insErr.message}`);
  }

  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: loc.client_id,
    p_job_type: "seo_technical_audit",
    p_success: true, // every sub-check is already best-effort/self-skipping; nothing here is a transient failure to back off
    p_base_interval_minutes: BASE_INTERVAL_MINUTES,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: loc.id,
  });
  if (jobError) console.error(`seo-technical-audit ${loc.id}: complete_job_attempt failed: ${jobError.message}`);

  console.log(`seo-technical-audit ${loc.id}: findings=${findings.length} hops=${hops.length}`);
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

  const locationId = String(body.location_id ?? "").trim();
  if (!locationId) return json({ error: "location_id is required" }, 400);

  const { data: loc, error } = await supabase
    .from("seo_locations")
    .select("id, client_id, website_url, search_console_site_url")
    .eq("id", locationId)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!loc) return json({ error: "location not found" }, 404);
  if (!loc.website_url) return json({ status: "no_website", location_id: locationId });

  try {
    await auditLocation(loc as LocationRow);
    return json({ ok: true, location_id: locationId });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "audit failed";
    console.error(`seo-technical-audit ${locationId} unhandled: ${reason}`);
    await supabase.rpc("complete_job_attempt", {
      p_client_id: loc.client_id,
      p_job_type: "seo_technical_audit",
      p_success: false,
      p_error: reason,
      p_base_interval_minutes: BASE_INTERVAL_MINUTES,
      p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
      p_entity_id: loc.id,
    });
    return json({ ok: false, error: reason }, 500);
  }
});
