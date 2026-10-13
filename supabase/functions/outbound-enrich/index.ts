// =============================================================================
// outbound-enrich — outbound engine Phase 1 step 3 (docs/OUTBOUND-PLAN.md):
// find an email address for leads at stage 'sourced' by reading their own
// website: the homepage, then up to three contact / about pages.
//
//   POST /outbound-enrich
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   {}                         a batch of the oldest 'sourced' leads
//           { "batch": 25 }            batch size, 1-25 (default 10)
//           { "lead_id": "<uuid>" }    one lead (must still be 'sourced')
//
// MUST be deployed with --no-verify-jwt (shared-secret auth).
//
// WHAT IT SAVES. outbound_record_email (0302) is the only writer: email_found
// with the address and the page it came from, or no_email, or suppressed, or
// no_email + a duplicate_email event when another lead already has it. Every
// lead also gets one 'enrich' event recording the pages read and why the
// address was (or wasn't) chosen, so a miss can be checked by hand.
//
// WHICH ADDRESS. Only the business's own domain or a free mailbox provider
// (gmail.com etc.) qualifies; others are usually the web designer or a
// platform (lib.ts pickEmail). An own-domain address on the homepage ends the
// search early.
//
// POLITE. robots.txt is honoured for every page. At most 4 pages per site,
// sequentially, with an honest user agent. Leads are claimed with a lease
// (outbound_claim_leads) so overlapping runs never fetch the same site, and
// leads a run didn't reach are released at the end.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, OUTBOUND_USER_AGENT (optional),
//      RENDER_SERVICE_URL and RENDER_SERVICE_SECRET (optional, for
//      JavaScript-rendered homepages; same service seo-crawl uses).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { isAllowedByRobots, normalizeUrl } from "../seo-crawl/lib.ts";
import {
  type Candidate,
  contactLinks,
  extractEmails,
  JS_SHELL_WORDS,
  pickEmail,
  startUrl,
  visibleWordCount,
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
  Deno.env.get("OUTBOUND_USER_AGENT") ??
  "LumilinkBot/1.0 (+https://www.lumilinkhub.com; reads public contact pages)";
const ROBOTS_AGENT = "lumilinkbot";

const DEFAULT_BATCH = 10;
const MAX_BATCH = 25;
const CONCURRENCY = 4; // different sites, so a few at once is fine
const FETCH_TIMEOUT_MS = 10_000;
const RENDER_TIMEOUT_MS = 20_000;
const MAX_REDIRECT_HOPS = 5;
const MAX_HTML_BYTES = 1_500_000;
const RUN_BUDGET_MS = 110_000; // stop starting new leads after this; the rest are released
const LEASE_SECONDS = 300;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Lead = { id: string; profile_id: string; website_url: string | null; domain: string | null; stage: string };

type Fetched = { finalUrl: string; html: string | null; status: number; error: string | null };

/** GET with redirects followed by hand (counted, capped) and the body size capped. */
async function fetchHtml(url: string): Promise<Fetched> {
  let current = url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let hops = 0; ; hops++) {
      const res = await fetch(current, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
        redirect: "manual",
        signal: controller.signal,
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        if (hops >= MAX_REDIRECT_HOPS) return { finalUrl: current, html: null, status: res.status, error: "too_many_redirects" };
        current = new URL(location, current).href;
        continue;
      }
      const isHtml = /text\/html|application\/xhtml/i.test(res.headers.get("content-type") ?? "");
      if (!res.ok || !isHtml) {
        await res.body?.cancel();
        return { finalUrl: current, html: null, status: res.status, error: res.ok ? "not_html" : `http_${res.status}` };
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      const html = new TextDecoder().decode(buf.byteLength > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf);
      return { finalUrl: current, html, status: res.status, error: null };
    }
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { finalUrl: current, html: null, status: 0, error: name === "AbortError" ? "timeout" : "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRobots(origin: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return (await res.text()).slice(0, 200_000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One call to render-service, if configured. Null on any failure, never throws. */
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

type Page = { url: string; status: number; error: string | null; emails: number; rendered?: boolean; robots?: boolean };

async function enrichLead(lead: Lead): Promise<Record<string, unknown>> {
  const pages: Page[] = [];
  const sourceOf = new Map<string, string>();
  const candidates: Candidate[] = [];
  const collect = (html: string, url: string) => {
    const found = extractEmails(html);
    for (const c of found) {
      if (!sourceOf.has(c.email)) {
        sourceOf.set(c.email, url);
        candidates.push(c);
      }
    }
    return found.length;
  };

  let pick = null as ReturnType<typeof pickEmail>;
  let note: string | null = null;
  const start = lead.website_url ? startUrl(lead.website_url) : null;

  if (!start) {
    note = "no_website";
  } else {
    const origin = new URL(start).origin;
    const robots = await fetchRobots(origin);
    if (!isAllowedByRobots(robots, "/", ROBOTS_AGENT)) {
      note = "robots_disallowed";
      pages.push({ url: start, status: 0, error: null, emails: 0, robots: false });
    } else {
      const home = await fetchHtml(start);
      let html = home.html;
      let rendered = false;
      if (html !== null && visibleWordCount(html) < JS_SHELL_WORDS) {
        const r = await tryRender(home.finalUrl);
        if (r) {
          html = r;
          rendered = true;
        }
      }
      pages.push({ url: home.finalUrl, status: home.status, error: home.error, emails: html ? collect(html, home.finalUrl) : 0, rendered });

      if (html === null) {
        note = home.error ?? "unreachable";
      } else {
        // A redirect to another domain (rebrand, parent site) is that business's site now.
        const finalDomain = new URL(home.finalUrl).hostname;
        const siteDomain = lead.domain ?? finalDomain;
        pick = pickEmail(candidates, siteDomain) ?? pickEmail(candidates, finalDomain);

        // An own-domain address on the homepage is as good as it gets.
        if (!pick || pick.rank >= 100) {
          const finalRobots = new URL(home.finalUrl).origin === origin ? robots : await fetchRobots(new URL(home.finalUrl).origin);
          for (const url of contactLinks(html, home.finalUrl)) {
            const path = new URL(url).pathname;
            if (!isAllowedByRobots(finalRobots, path, ROBOTS_AGENT)) {
              pages.push({ url, status: 0, error: null, emails: 0, robots: false });
              continue;
            }
            const page = await fetchHtml(url);
            pages.push({ url: page.finalUrl, status: page.status, error: page.error, emails: page.html ? collect(page.html, page.finalUrl) : 0 });
            pick = pickEmail(candidates, siteDomain) ?? pickEmail(candidates, finalDomain);
            if (pick && pick.rank < 100) break;
          }
        }
        if (!pick) note = candidates.length > 0 ? "no_usable_address" : "no_address_on_site";
      }
    }
  }

  const sourceUrl = pick ? sourceOf.get(pick.email) ?? null : null;
  const { data: outcome, error } = await supabase.rpc("outbound_record_email", {
    p_lead_id: lead.id,
    p_email: pick?.email ?? null,
    p_source_url: sourceUrl ? normalizeUrl(sourceUrl) : null,
  });
  if (error) throw new Error(`outbound_record_email failed: ${error.message}`);

  const detail = {
    outcome,
    email: pick?.email ?? null,
    reason: pick?.reason ?? note,
    pages,
    // Rejected candidates, so a miss can be checked by hand.
    other_addresses: candidates.map((c) => c.email).filter((e) => e !== pick?.email).slice(0, 10),
  };
  const { error: eventError } = await supabase
    .from("outbound_events")
    .insert({ lead_id: lead.id, profile_id: lead.profile_id, type: "enrich", detail });
  if (eventError) console.error(`outbound-enrich ${lead.id}: event insert failed: ${eventError.message}`);

  return { lead_id: lead.id, ...detail, pages: pages.length };
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
  const started = Date.now();

  let leads: Lead[];
  if (typeof body.lead_id === "string") {
    const { data, error } = await supabase
      .from("outbound_leads")
      .select("id, profile_id, website_url, domain, stage")
      .eq("id", body.lead_id)
      .maybeSingle();
    if (error) return json({ error: `lead lookup failed: ${error.message}` }, 500);
    if (!data) return json({ error: "Lead not found" }, 404);
    if (data.stage !== "sourced") return json({ error: `Lead is at stage '${data.stage}', not 'sourced'` }, 409);
    leads = [data as Lead];
  } else {
    const requested = Number(body.batch ?? DEFAULT_BATCH);
    const batch = Number.isInteger(requested) ? Math.min(MAX_BATCH, Math.max(1, requested)) : DEFAULT_BATCH;
    const { data, error } = await supabase.rpc("outbound_claim_leads", {
      p_stage: "sourced",
      p_limit: batch,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (error) return json({ error: `claim failed: ${error.message}` }, 500);
    leads = (data ?? []) as Lead[];
  }

  const results: Record<string, unknown>[] = [];
  const unstarted: string[] = [];
  let next = 0;
  async function worker() {
    while (next < leads.length) {
      const lead = leads[next++];
      if (Date.now() - started > RUN_BUDGET_MS) {
        unstarted.push(lead.id);
        continue;
      }
      try {
        results.push(await enrichLead(lead));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`outbound-enrich ${lead.id}: ${message}`);
        results.push({ lead_id: lead.id, outcome: "error", error: message });
        unstarted.push(lead.id); // release so a later run retries it
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, leads.length) }, worker));

  if (unstarted.length > 0) {
    const { error } = await supabase.from("outbound_leads").update({ claimed_until: null }).in("id", unstarted);
    if (error) console.error(`outbound-enrich: release failed: ${error.message}`);
  }

  const tally: Record<string, number> = {};
  for (const r of results) tally[String(r.outcome)] = (tally[String(r.outcome)] ?? 0) + 1;
  return json({ claimed: leads.length, released: unstarted.length, tally, results });
});
