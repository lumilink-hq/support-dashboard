// =============================================================================
// seo-crawl — module 6 (plan.md): crawl a location's site (root + up to 19
// more same-domain pages) and write on-page SEO findings.
//
//   POST /seo-crawl
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "location_id": "<uuid>" }
//
// Admin endpoint, same posture as product-sync/google-token-refresh: the
// shared secret is the whole gate, dispatched only by request_seo_crawl
// (0049) via pg_cron -> pg_net, never reachable from an unauthenticated
// caller.
//
// FINDING LIFECYCLE: open 'crawl' findings for this location are DELETED and
// replaced with this run's fresh set before inserting — same delete-then-
// insert reasoning kb-ingest uses for kb_chunks (an upsert would leave stale,
// no-longer-true findings behind). Dismissed/actioned findings are untouched
// (the delete only targets status='open'), so a tenant's dismissal survives
// the next crawl even if the underlying page still has the issue.
//
// "FAIL CLEARLY INSTEAD OF RETURNING EMPTY RESULTS" (plan.md): a
// JavaScript-rendered site (or a fetch/robots failure) writes ONE critical
// finding saying so, rather than silently reporting zero findings — which
// would look like a clean bill of health rather than "we couldn't check."
//
// HEADLESS-BROWSER FALLBACK (built 2026-09-22, render-service/): when the root
// page looks JS-rendered AND RENDER_SERVICE_URL is set, one render is tried
// before giving up. If it comes back with real content, that rendered HTML
// replaces the plain fetch for the root page's audit AND for link discovery
// (a JS-shell's raw HTML has no real internal links to find either).
// Subsequent pages are still fetched plainly, not rendered — rendering all 20
// pages of every site every week is a cost/latency trade this doesn't make;
// a subpage that's still a JS shell falls through to the ordinary thin-content
// rule rather than a second render. If the service isn't configured, times
// out, errors, or the render is ALSO too thin, this falls back to the
// critical finding exactly as before — never a silent gap.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, SEO_CRAWL_USER_AGENT (optional), RENDER_SERVICE_URL
//      and RENDER_SERVICE_SECRET (optional — the fallback above is skipped,
//      not attempted, when either is unset).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  auditPage,
  CRAWL_PAGE_LIMIT,
  discoverLinks,
  isAllowedByRobots,
  normalizeUrl,
  visibleWordCount,
  type CrawlFinding,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const RENDER_SERVICE_URL = Deno.env.get("RENDER_SERVICE_URL");
const RENDER_SERVICE_SECRET = Deno.env.get("RENDER_SERVICE_SECRET");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const USER_AGENT =
  Deno.env.get("SEO_CRAWL_USER_AGENT") ??
  "LumilinkSeoBot/1.0 (+https://lumilinkhub.com/bot; SEO audit for our customer's own site)";

const FETCH_TIMEOUT_MS = 15_000;
const RENDER_TIMEOUT_MS = 20_000; // generous: the render service's own Playwright nav timeout is 15s
// A JS-rendered shell has SOME markup (the <head>, maybe a nav skeleton) but
// almost no prose — well under thin-content's own 300-word bar. Deliberately
// far below it: this check exists to catch "basically nothing rendered", not
// to also fire the ordinary thin-content finding's job.
const JS_RENDERED_WORD_THRESHOLD = 40;

const BASE_INTERVAL_MINUTES = 7 * 24 * 60; // weekly, per plan.md's scheduled-jobs table
const MAX_BACKOFF_MINUTES = 24 * 60; // cap a failing site's retry at once a day

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const ctype = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(ctype)) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One call to render-service, if configured. Null on any failure — never
 * throws, so a down/misconfigured render service degrades to the pre-existing
 * "fail clearly" finding rather than crashing the whole crawl. */
async function tryRender(url: string): Promise<string | null> {
  if (!RENDER_SERVICE_URL || !RENDER_SERVICE_SECRET) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    const res = await fetch(RENDER_SERVICE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-render-secret": RENDER_SERVICE_SECRET },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { html?: unknown } | null;
    return typeof body?.html === "string" ? body.html : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

type LocationRow = {
  id: string;
  client_id: string;
  name: string | null;
  website_url: string | null;
  phone_number: string | null;
};

async function crawlLocation(loc: LocationRow): Promise<void> {
  const startUrl = normalizeUrl(loc.website_url!);
  const origin = new URL(startUrl).origin;

  const robots = await fetchRobots(origin);
  const allowed = (u: string) => {
    try {
      return isAllowedByRobots(robots, new URL(u).pathname, "lumilinkseobot");
    } catch {
      return false;
    }
  };

  if (!allowed(startUrl)) {
    await settleCrawl(loc, "robots_disallowed", `robots.txt on ${origin} disallows crawling`, [
      {
        finding_type: "robots_disallowed",
        severity: "critical",
        title: "robots.txt blocks LumiLink from auditing this site",
        details: { origin },
      },
    ]);
    return;
  }

  const rootHtml = await fetchText(startUrl);
  if (rootHtml === null) {
    await settleCrawl(loc, "fetch_failed", `could not fetch ${startUrl}`, [
      {
        finding_type: "crawl_fetch_failed",
        severity: "critical",
        title: "Couldn't fetch this site to audit it",
        details: { url: startUrl },
      },
    ]);
    return;
  }

  let effectiveRootHtml = rootHtml;
  let renderedFallback = false;

  if (visibleWordCount(rootHtml) < JS_RENDERED_WORD_THRESHOLD) {
    const rendered = await tryRender(startUrl);
    const renderedWordCount = rendered !== null ? visibleWordCount(rendered) : null;

    if (rendered !== null && renderedWordCount !== null && renderedWordCount >= JS_RENDERED_WORD_THRESHOLD) {
      // The headless render found real content — use it as the root page from
      // here on, same pipeline as any other crawl, just fed rendered markup.
      // A JS-shell's raw HTML has no real internal links either, so link
      // discovery also switches to the rendered version.
      effectiveRootHtml = rendered;
      renderedFallback = true;
    } else {
      const note =
        rendered !== null
          ? "Rendered with a headless browser, but the page still had almost no text — likely broken, not just JS-rendered."
          : RENDER_SERVICE_URL
            ? "The headless-browser fallback was attempted but failed or timed out."
            : "The headless-browser fallback isn't configured (RENDER_SERVICE_URL unset).";
      await settleCrawl(
        loc,
        "js_rendered",
        `root page has almost no visible text after a plain fetch (${note})`,
        [
          {
            finding_type: "javascript_rendered_site",
            severity: "critical",
            title: "This site appears JavaScript-rendered — a plain fetch can't audit it",
            details: {
              url: startUrl,
              word_count: visibleWordCount(rootHtml),
              render_attempted: rendered !== null || RENDER_SERVICE_URL != null,
              render_word_count: renderedWordCount,
              note,
            },
          },
        ],
      );
      return;
    }
  }

  const pages: { url: string; html: string }[] = [{ url: startUrl, html: effectiveRootHtml }];
  const links = discoverLinks(effectiveRootHtml, startUrl, CRAWL_PAGE_LIMIT * 2).filter(allowed).slice(0, CRAWL_PAGE_LIMIT - 1);
  for (const link of links) {
    // Sequential with a gap — a small business's shared host must not read a
    // weekly audit as a burst of traffic, same courtesy kb-ingest applies.
    // Subsequent pages are fetched plainly, not rendered: rendering all 20
    // pages of every site every week is a cost/latency trade this doesn't
    // make. A subpage that's still a JS shell falls through to the ordinary
    // thin-content rule rather than a second render.
    await new Promise((r) => setTimeout(r, 250));
    const html = await fetchText(link);
    if (html !== null) pages.push({ url: link, html });
  }

  const allFindings: (CrawlFinding & { target_url: string })[] = [];
  for (const page of pages) {
    const findings = auditPage(page.html, { name: loc.name, phone_number: loc.phone_number });
    for (const f of findings) allFindings.push({ ...f, target_url: page.url });
  }

  if (renderedFallback) {
    // Informational, not critical: the audit DID complete, just via the
    // slower path — worth surfacing so a look at the findings list explains
    // why this site is slower to crawl than most, not a silent difference.
    allFindings.push({
      finding_type: "javascript_rendered_site_audited_via_render",
      severity: "info",
      title: "This site needed a headless-browser render to audit — a plain fetch alone wasn't enough",
      details: { url: startUrl },
      target_url: startUrl,
    });
  }

  await settleCrawl(loc, "ok", null, allFindings, pages.length);
}

async function settleCrawl(
  loc: LocationRow,
  status: "ok" | "js_rendered" | "fetch_failed" | "robots_disallowed",
  error: string | null,
  findings: (CrawlFinding & { target_url?: string })[],
  pagesCrawled = 0,
): Promise<void> {
  // Replace this location's OPEN crawl findings with the fresh set — a fixed
  // issue disappears on its own next week instead of accumulating duplicate
  // rows for a persistent one. Dismissed/actioned findings are untouched
  // (status='open' is the only thing deleted), so a tenant's dismissal
  // survives even if the underlying page still has the issue.
  const { error: delErr } = await supabase
    .from("seo_findings")
    .delete()
    .eq("location_id", loc.id)
    .eq("module", "crawl")
    .eq("status", "open");
  if (delErr) console.error(`seo-crawl ${loc.id}: clearing old findings failed: ${delErr.message}`);

  if (findings.length > 0) {
    const rows = findings.map((f) => ({
      client_id: loc.client_id,
      location_id: loc.id,
      module: "crawl",
      finding_type: f.finding_type,
      severity: f.severity,
      title: f.title,
      details: f.details,
      target_url: f.target_url ?? loc.website_url,
    }));
    const { error: insErr } = await supabase.from("seo_findings").insert(rows);
    if (insErr) console.error(`seo-crawl ${loc.id}: inserting findings failed: ${insErr.message}`);
  }

  const { error: updErr } = await supabase
    .from("seo_locations")
    .update({ last_crawled_at: new Date().toISOString(), crawl_status: status, crawl_error: error })
    .eq("id", loc.id);
  if (updErr) console.error(`seo-crawl ${loc.id}: updating location status failed: ${updErr.message}`);

  // js_rendered/robots_disallowed are STEADY STATES, not transient technical
  // failures — retrying sooner won't fix them (the site's rendering approach
  // or robots.txt won't change by Tuesday). Only a genuine fetch failure
  // (network, DNS, timeout) gets the exponential-backoff treatment; the other
  // two settle on the normal weekly cadence, same as a clean crawl, with the
  // finding itself carrying the "still broken" signal for a human to see.
  const success = status !== "fetch_failed";
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: loc.client_id,
    p_job_type: "seo_crawl",
    p_success: success,
    p_error: success ? null : error,
    p_base_interval_minutes: BASE_INTERVAL_MINUTES,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: loc.id,
  });
  if (jobError) console.error(`seo-crawl ${loc.id}: complete_job_attempt failed: ${jobError.message}`);

  console.log(
    `seo-crawl ${loc.id}: status=${status} pages=${pagesCrawled} findings=${findings.length}` +
      (error ? ` error=${error}` : ""),
  );
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
    .select("id, client_id, name, website_url, phone_number")
    .eq("id", locationId)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!loc) return json({ error: "location not found" }, 404);
  if (!loc.website_url) return json({ status: "no_website", location_id: locationId });

  try {
    await crawlLocation(loc as LocationRow);
    return json({ ok: true, location_id: locationId });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "crawl failed";
    console.error(`seo-crawl ${locationId} unhandled: ${reason}`);
    await supabase.rpc("complete_job_attempt", {
      p_client_id: loc.client_id,
      p_job_type: "seo_crawl",
      p_success: false,
      p_error: reason,
      p_base_interval_minutes: BASE_INTERVAL_MINUTES,
      p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
      p_entity_id: loc.id,
    });
    return json({ ok: false, error: reason }, 500);
  }
});
