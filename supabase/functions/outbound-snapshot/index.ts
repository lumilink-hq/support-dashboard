// =============================================================================
// outbound-snapshot — outbound engine Phase 4 (docs/OUTBOUND-PLAN.md): the
// pre-call SEO snapshot for one lead. What the caller opens before the call,
// and the to-do list the prospect is promised whether they sign up or not.
//
//   POST /outbound-snapshot
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "lead_id": "<uuid>" }
//           { "lead_id", "keyword": "dispensary near me detroit" }   override the search
//           { "lead_id", "force": true }    rebuild even if one is under 7 days old
//
// MUST be deployed with --no-verify-jwt (shared-secret auth).
//
// THREE PARTS, each optional so one failure doesn't sink the rest:
//   1. Website (no spend): homepage redirects, robots.txt, sitemap, https,
//      mobile viewport, and seo-crawl's single-page rules (title,
//      description, H1, LocalBusiness markup, phone on page, thin content).
//      Reuses seo-crawl / seo-technical-audit code, not copies.
//   2. Google listing vs competitors: one business listings search around
//      the lead's coordinates in its primary category (about $0.016 for 10).
//   3. Ranking: one live Google SERP for "<category> <city>" (or `keyword`)
//      from the lead's coordinates, depth 20: map pack and organic position.
// status 'ready' when all three ran, 'partial' when one or two failed (the
// error says which), 'failed' when none did.
//
// ON DEMAND ONLY. Nothing schedules this; it's built for a lead someone is
// about to call (Phase 2/3 trigger it on a positive reply). A snapshot under
// 7 days old is returned instead of buying a new one, unless `force`.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD,
//      OUTBOUND_USER_AGENT (optional), DATAFORSEO_BASE (optional, tests).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { auditPage, isAllowedByRobots } from "../seo-crawl/lib.ts";
import { analyzeRedirectChain, analyzeRobotsTxt, analyzeSitemap, type RedirectHop } from "../seo-technical-audit/lib.ts";
import { findOwnRanking, type SerpItem } from "../seo-rank-tracking/lib.ts";
import {
  buildTodo,
  compareListing,
  type Competitor,
  competitorsFrom,
  coordinatesOf,
  extraSiteFindings,
  keywordFor,
  type ListingComparison,
  primaryCategoryId,
  type RankResult,
  type SiteFinding,
  summaryLines,
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

const USER_AGENT =
  Deno.env.get("OUTBOUND_USER_AGENT") ??
  "LumilinkBot/1.0 (+https://www.lumilinkhub.com; reads public contact pages)";
const DATAFORSEO_BASE = Deno.env.get("DATAFORSEO_BASE") ?? "https://api.dataforseo.com/v3"; // override for tests only
const FETCH_TIMEOUT_MS = 12_000;
const MAX_REDIRECT_HOPS = 6;
const MAX_HTML_BYTES = 1_500_000;
const REUSE_DAYS = 7;
const COMPETITOR_RADIUS_KM = 15; // business listings: km
const SERP_RADIUS_MM = 1000; // SERP location_coordinate: the third value is millimetres (min 199)
const SERP_DEPTH = 20;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Lead = {
  id: string;
  profile_id: string;
  business_name: string;
  category: string | null;
  city: string | null;
  phone: string | null;
  website_url: string | null;
  domain: string | null;
  rating: number | null;
  review_count: number | null;
  source_ref: string;
  raw: Record<string, unknown> | null;
};

// -----------------------------------------------------------------------------
// 1. Website
// -----------------------------------------------------------------------------

async function timedFetch(url: string, init: RequestInit = {}): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) }, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function checkWebsite(lead: Lead): Promise<{ findings: SiteFinding[]; final_url: string | null; hops: RedirectHop[] }> {
  if (!lead.website_url) return { findings: [], final_url: null, hops: [] };
  const start = /^https?:\/\//i.test(lead.website_url) ? lead.website_url : `https://${lead.website_url}`;
  const origin = new URL(start).origin;

  const robotsRes = await timedFetch(`${origin}/robots.txt`);
  const robots = robotsRes?.ok ? (await robotsRes.text()).slice(0, 200_000) : null;
  if (robotsRes && !robotsRes.ok) await robotsRes.body?.cancel();

  // Homepage, following redirects by hand so each hop is recorded.
  const hops: RedirectHop[] = [];
  let current = start;
  let html: string | null = null;
  for (let i = 0; i <= MAX_REDIRECT_HOPS; i++) {
    if (!isAllowedByRobots(robots, new URL(current).pathname, "lumilinkbot")) break;
    const res = await timedFetch(current, { redirect: "manual", headers: { Accept: "text/html" } });
    hops.push({ url: current, status: res ? res.status : null });
    if (!res) break;
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, current).href;
      continue;
    }
    if (res.ok && /text\/html|application\/xhtml/i.test(res.headers.get("content-type") ?? "")) {
      const buf = new Uint8Array(await res.arrayBuffer());
      html = new TextDecoder().decode(buf.byteLength > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf);
    } else {
      await res.body?.cancel();
    }
    break;
  }

  // Sitemap: robots.txt's Sitemap: line, else /sitemap.xml.
  const declared = robots?.match(/^\s*sitemap:\s*(\S+)/im)?.[1] ?? null;
  const sitemapUrl = declared ?? `${new URL(current).origin}/sitemap.xml`;
  const sitemapRes = await timedFetch(sitemapUrl, { method: "GET" });
  const sitemapFound = !!sitemapRes?.ok;
  await sitemapRes?.body?.cancel();

  const findings: SiteFinding[] = [
    ...analyzeRedirectChain(hops),
    ...analyzeRobotsTxt(robots !== null, robots),
    ...analyzeSitemap(sitemapFound, sitemapUrl),
    ...extraSiteFindings(current, html),
    ...(html ? auditPage(html, { name: lead.business_name, phone_number: lead.phone }, { isRoot: true }) : []),
  ];
  return { findings, final_url: html ? current : null, hops };
}

// -----------------------------------------------------------------------------
// 2 and 3. DataForSEO
// -----------------------------------------------------------------------------

async function dataForSeo(path: string, body: Record<string, unknown>): Promise<{ result: unknown; cost: number }> {
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
  if (!res.ok) throw new Error(`dataforseo ${path} HTTP ${res.status}: ${message ?? ""}`.trim());
  if (!task || statusCode !== 20000) throw new Error(`dataforseo ${path} status ${statusCode}: ${message}`);
  return { result: task.result, cost: typeof payload?.cost === "number" ? payload.cost : 0 };
}

async function checkCompetitors(lead: Lead): Promise<{ competitors: Competitor[]; listing: ListingComparison; cost: number }> {
  const coords = coordinatesOf(lead.raw);
  const category = primaryCategoryId(lead.raw);
  if (!coords || !category) throw new Error("listing has no coordinates or category id");
  const { result, cost } = await dataForSeo("/business_data/business_listings/search/live", {
    categories: [category],
    location_coordinate: `${coords.lat},${coords.lng},${COMPETITOR_RADIUS_KM}`,
    order_by: ["rating.votes_count,desc"],
    limit: 10,
  });
  const items = (Array.isArray(result) ? (result[0] as { items?: unknown[] })?.items : null) ?? [];
  const competitors = competitorsFrom(items, { cid: lead.source_ref, domain: lead.domain, name: lead.business_name });
  return { competitors, listing: compareListing({ rating: lead.rating, reviews: lead.review_count }, competitors), cost };
}

async function checkRanking(lead: Lead, keyword: string): Promise<{ rank: RankResult; cost: number }> {
  const coords = coordinatesOf(lead.raw);
  if (!coords) throw new Error("listing has no coordinates");
  const { result, cost } = await dataForSeo("/serp/google/organic/live/advanced", {
    keyword,
    language_code: "en",
    location_coordinate: `${coords.lat},${coords.lng},${SERP_RADIUS_MM}`,
    device: "mobile",
    depth: SERP_DEPTH,
  });
  const items = ((Array.isArray(result) ? (result[0] as { items?: SerpItem[] })?.items : null) ?? []) as SerpItem[];
  const own = { domain: lead.domain, phone: lead.phone, businessName: lead.business_name };
  return {
    rank: {
      keyword,
      local_pack: findOwnRanking(items, "local_pack", own)?.position ?? null,
      organic: findOwnRanking(items, "organic", own)?.position ?? null,
      local_pack_names: items
        .filter((i) => i.type === "local_pack" && typeof i.title === "string")
        .map((i) => i.title as string)
        .slice(0, 5),
    },
    cost,
  };
}

// -----------------------------------------------------------------------------
// Handler
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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) ?? {};
  } catch {
    body = {};
  }
  if (typeof body.lead_id !== "string") return json({ error: "lead_id is required" }, 400);
  const force = body.force === true;

  const { data: lead, error: leadError } = await supabase
    .from("outbound_leads")
    .select("id, profile_id, business_name, category, city, phone, website_url, domain, rating, review_count, source_ref, raw")
    .eq("id", body.lead_id)
    .maybeSingle();
  if (leadError) return json({ error: `lead lookup failed: ${leadError.message}` }, 500);
  if (!lead) return json({ error: "Lead not found" }, 404);

  if (!force) {
    const { data: recent } = await supabase
      .from("outbound_snapshots")
      .select("*")
      .eq("lead_id", lead.id)
      .neq("status", "failed")
      .gte("created_at", new Date(Date.now() - REUSE_DAYS * 86_400_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recent) return json({ reused: true, snapshot: recent });
  }

  const keyword = typeof body.keyword === "string" && body.keyword.trim()
    ? body.keyword.trim().toLowerCase()
    : keywordFor((lead as Lead).category, (lead as Lead).city);
  const vendorReady = !!DATAFORSEO_LOGIN && !!DATAFORSEO_PASSWORD;

  const errors: string[] = [];
  let cost = 0;
  const [siteR, compR, rankR] = await Promise.allSettled([
    checkWebsite(lead as Lead),
    vendorReady ? checkCompetitors(lead as Lead) : Promise.reject(new Error("DataForSEO not configured")),
    !vendorReady
      ? Promise.reject(new Error("DataForSEO not configured"))
      : keyword
      ? checkRanking(lead as Lead, keyword)
      : Promise.reject(new Error("no keyword: listing has no category or city")),
  ]);

  const site = siteR.status === "fulfilled" ? siteR.value : null;
  if (siteR.status === "rejected") errors.push(`website: ${siteR.reason?.message ?? siteR.reason}`);
  const comp = compR.status === "fulfilled" ? compR.value : null;
  if (compR.status === "rejected") errors.push(`competitors: ${compR.reason?.message ?? compR.reason}`);
  else cost += compR.value.cost;
  const rank = rankR.status === "fulfilled" ? rankR.value.rank : null;
  if (rankR.status === "rejected") errors.push(`ranking: ${rankR.reason?.message ?? rankR.reason}`);
  else cost += rankR.value.cost;

  const todo = buildTodo({
    businessName: lead.business_name,
    rank,
    listing: comp?.listing ?? null,
    competitors: comp?.competitors ?? [],
    site: site?.findings ?? [],
  });
  const summary = summaryLines({ businessName: lead.business_name, rank, listing: comp?.listing ?? null, todo });
  const ran = [site, comp, rank].filter((x) => x !== null).length;
  const status = ran === 3 ? "ready" : ran === 0 ? "failed" : "partial";

  const { data: snapshot, error: insertError } = await supabase
    .from("outbound_snapshots")
    .insert({
      lead_id: lead.id,
      status,
      keyword,
      data: {
        website: site,
        competitors: comp?.competitors ?? null,
        listing: comp?.listing ?? null,
        rank,
      },
      todo,
      summary,
      cost,
      error: errors.length ? errors.join("; ") : null,
    })
    .select()
    .single();
  if (insertError) return json({ error: `saving the snapshot failed: ${insertError.message}` }, 500);

  const { error: eventError } = await supabase.from("outbound_events").insert({
    lead_id: lead.id,
    profile_id: lead.profile_id,
    type: "snapshot",
    detail: { snapshot_id: snapshot.id, status, todo_items: todo.length, cost },
  });
  if (eventError) console.error(`outbound-snapshot ${lead.id}: event insert failed: ${eventError.message}`);

  return json({ reused: false, snapshot });
});
