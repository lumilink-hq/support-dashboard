// =============================================================================
// seo-detail-suggestions — module 30 (plan.md): after a website's weekly
// crawl, suggest each location's article details (module 28's intake) from
// what the site says: licence numbers on each store's page, the page's JSON-LD,
// and one Claude call per location that must quote its source word for word.
//
//   POST /seo-detail-suggestions
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "location_id": "<uuid of the website's primary location>" }
//
// Admin endpoint, same posture as the other seo-* functions: dispatched by
// request_seo_detail_suggestions (0071) once a website's crawl has finished
// since the last run. MUST be deployed with --no-verify-jwt.
//
// ONE RUN PER WEBSITE, every location on it (module 29): the crawl's pages are
// stored under the primary. Each location gets its own store page's licence
// and JSON-LD, and a model call over its store page plus the site's fact pages
// (homepage, about, locations, FAQ…), never another store's page.
//
// WRITES ONLY SUGGESTIONS (seo_detail_suggestions, status 'open'). A person
// ticks them in /seo and confirms; nothing here touches seo_location_details.
// The model doesn't list the same items every run, so an open model
// suggestion stays until its quote leaves its page (or a rule now rejects
// it); an exact (licence / JSON-LD) one goes as soon as a run doesn't find
// it. Accepted and dismissed ones are kept, so a dismissal sticks.
//
// COST BOUND. One model call per location per crawl (weekly), effort low, a
// few thousand tokens in. A location with no kept page text costs nothing.
//
// Imports ../seo-crawl/stores.ts and ../seo-content/details.ts: a change in
// either means redeploying this too.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, ANTHROPIC_API_KEY (without it only the licence and
//      JSON-LD suggestions are made), SEO_DETAILS_MODEL (optional).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import Anthropic from "npm:@anthropic-ai/sdk@0.127.0";
import { type LocationDetails } from "../seo-content/details.ts";
import { type SiteMember, siteGroup, storeFor, storePageMap } from "../seo-crawl/stores.ts";
import {
  buildPayload,
  checkCandidate,
  finalSuggestions,
  licencesByAddress,
  licenceSuggestions,
  keepOpen,
  MAX_PER_LOCATION,
  type OpenRow,
  nameWords,
  OUTPUT_SCHEMA,
  parseModelOutput,
  type SourcePage,
  structuredSuggestions,
  type Suggestion,
  suggestionKey,
  SYSTEM_PROMPT,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("SEO_DETAILS_MODEL") ?? "claude-sonnet-5"; // same class as seo-draft / seo-content

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const JOB_TYPE = "seo_detail_suggestions";
const BASE_INTERVAL_MINUTES = 24 * 60; // due again only after the next crawl (0071's view)
const MAX_BACKOFF_MINUTES = 24 * 60;
const BUDGET_RETRY_MS = 5_000;
const BUDGET_MAX_TRIES = 6;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: 4 }) : null;

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reserveBudget(): Promise<void> {
  for (let i = 0; i < BUDGET_MAX_TRIES; i++) {
    const { data: allowed, error } = await supabase.rpc("check_and_reserve_vendor_budget", { p_vendor: "anthropic" });
    if (error) throw new Error(`vendor budget check failed: ${error.message}`);
    if (allowed) return;
    await sleep(BUDGET_RETRY_MS);
  }
  throw new Error("anthropic vendor budget stayed exhausted");
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
  if (jobError) console.error(`seo-detail-suggestions ${locationId}: complete_job_attempt failed: ${jobError.message}`);
}

async function askModel(loc: Member, pages: SourcePage[]): Promise<string> {
  await reserveBudget();
  const res = await anthropic!.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    messages: [{ role: "user", content: buildPayload({ name: loc.name, city: loc.city }, pages) }],
  } as never);
  const r = res as unknown as { stop_reason: string; content: { type: string; text?: string }[] };
  if (r.stop_reason === "refusal") throw new Error("model refused");
  if (r.stop_reason === "max_tokens") throw new Error("model output was cut off");
  return r.content.find((b) => b.type === "text")?.text ?? "";
}

type Member = SiteMember & { client_id: string; city: string | null; address_line1: string | null };
const LOCATION_COLUMNS = "id, client_id, name, city, address_line1, website_url, store_page_url, created_at";

type PageRow = { url: string; final_url: string | null; is_root: boolean; page_text: string | null; json_ld: unknown[] | null };

async function suggestForSite(primary: Member, members: Member[], brand: string | null): Promise<Record<string, unknown>> {
  const group = siteGroup(members, primary)!;

  const { data: run } = await supabase.from("seo_crawl_runs").select("run_id, phase").eq("location_id", primary.id).maybeSingle();
  if (!run || run.phase !== "done") return { status: "no_finished_crawl" };

  const { data: pageData, error: pErr } = await supabase
    .from("seo_crawl_pages")
    .select("url, final_url, is_root, page_text, json_ld")
    .eq("location_id", primary.id)
    .eq("run_id", run.run_id)
    .not("page_text", "is", null);
  if (pErr) throw new Error(`reading crawled pages failed: ${pErr.message}`);
  const rows = (pageData ?? []) as PageRow[];
  const root = rows.find((r) => r.is_root);
  const stores = storePageMap(group, root?.url ?? primary.website_url);
  const toPage = (r: PageRow): SourcePage => ({ url: r.url, text: r.page_text ?? "", json_ld: r.json_ld });
  const factPages = rows.filter((r) => !storeFor(stores, r.url)).map(toPage);
  // Homepage first among the fact pages: it's the most general.
  factPages.sort((a, b) => Number(b.url === root?.url) - Number(a.url === root?.url));

  const ids = group.members.map((m) => m.id);
  const [{ data: detailRows }, { data: existing }] = await Promise.all([
    supabase.from("seo_location_details").select("*").in("location_id", ids),
    supabase.from("seo_detail_suggestions").select("location_id, field, value, status, quote, source_url, method").in("location_id", ids),
  ]);
  const savedBy = new Map(((detailRows ?? []) as (LocationDetails & { location_id: string })[]).map((d) => [d.location_id, d]));

  // Licences on any kept page (a contact page or footer listing every store),
  // each matched to the store whose street address sits just before it.
  const licencesByStore = licencesByAddress(rows.map(toPage), group.members);

  const results: Record<string, unknown> = {};
  let modelFailures = 0;
  for (const m of group.members) {
    const own = rows.find((r) => storeFor(stores, r.url)?.id === m.id);
    const storePage = own ? toPage(own) : null;
    const found: Suggestion[] = [];
    if (storePage) found.push(...licenceSuggestions(storePage), ...structuredSuggestions(storePage));
    found.push(...(licencesByStore.get(m.id) ?? []));

    const pages = [...(storePage ? [storePage] : []), ...factPages];
    const ctx = {
      pages: new Map(pages.map((p) => [p.url, p])),
      storeUrl: storePage?.url ?? null,
      shared: group.shared,
      city: m.city,
      nameWords: nameWords(m.name, brand),
    };
    let dropped = 0;
    let modelError: string | null = null;
    if (anthropic && pages.length) {
      try {
        const raw = await askModel(m, pages);
        for (const c of parseModelOutput(raw)) {
          const r = checkCandidate(c, ctx);
          if (r.ok) found.push(r.s);
          else dropped++;
        }
      } catch (e) {
        modelError = e instanceof Error ? e.message : String(e);
        modelFailures++;
        console.error(`seo-detail-suggestions ${m.id}: model call failed: ${modelError}`);
      }
    }

    const mine = ((existing ?? []) as (OpenRow & { location_id: string; status: string })[]).filter((e) => e.location_id === m.id);
    const decided = new Set(mine.filter((e) => e.status !== "open").map(suggestionKey));
    const saved = savedBy.get(m.id) ?? null;
    const final = finalSuggestions(found, saved, decided);
    const keep = new Set(final.map(suggestionKey));

    // An open suggestion this run didn't produce stays while the site still
    // says it (keepOpen); otherwise it goes. Kept ones count toward the cap.
    const notFound = mine.filter((e) => e.status === "open" && !keep.has(suggestionKey(e)));
    const carried = notFound.filter((e) => keepOpen(e, ctx, saved)).slice(0, Math.max(0, MAX_PER_LOCATION - final.length));
    const carriedKeys = new Set(carried.map(suggestionKey));
    const stale = notFound.filter((e) => !carriedKeys.has(suggestionKey(e)));
    for (const s of stale) {
      await supabase.from("seo_detail_suggestions").delete().eq("location_id", m.id).eq("field", s.field).eq("value", s.value).eq("status", "open");
    }
    if (final.length) {
      const { error } = await supabase.from("seo_detail_suggestions").upsert(
        // No status: a new row defaults to 'open', and a row that already
        // exists keeps its own (a dismissal is never reopened here).
        final.map((s) => ({ client_id: m.client_id, location_id: m.id, ...s, found_at: new Date().toISOString() })),
        { onConflict: "location_id,field,value_key", ignoreDuplicates: false },
      );
      if (error) throw new Error(`writing suggestions failed: ${error.message}`);
    }
    results[m.id] = { store_page: storePage?.url ?? null, suggested: final.length, kept: carried.length, dropped, removed: stale.length, model_error: modelError };
  }
  return { status: modelFailures ? "partial" : "ok", pages: rows.length, locations: results, model_failures: modelFailures };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!VOICE_TOOL_SECRET) {
    console.error("VOICE_TOOL_SECRET unset — refusing to run");
    return json({ error: "Server not configured" }, 500);
  }
  if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) return json({ error: "Unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const locationId = String(body.location_id ?? "").trim();
  if (!locationId) return json({ error: "location_id is required" }, 400);

  const { data: loc, error } = await supabase.from("seo_locations").select(LOCATION_COLUMNS).eq("id", locationId).maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!loc) return json({ error: "location not found" }, 404);

  try {
    const [{ data: all, error: sErr }, { data: client }] = await Promise.all([
      supabase.from("seo_locations").select(LOCATION_COLUMNS).eq("client_id", loc.client_id).eq("is_active", true),
      supabase.from("clients").select("name").eq("id", loc.client_id).maybeSingle(),
    ]);
    if (sErr) throw new Error(`reading sibling locations failed: ${sErr.message}`);
    const group = siteGroup((all ?? []) as Member[], loc as Member);
    if (!group) {
      await settle(loc.client_id, loc.id, true, null);
      return json({ ok: true, location_id: locationId, status: "no_website" });
    }
    if (group.primary.id !== loc.id) {
      await settle(loc.client_id, loc.id, true, null);
      return json({ ok: true, location_id: locationId, status: "not_primary", primary_location_id: group.primary.id });
    }
    const result = await suggestForSite(loc as Member, group.members, client?.name ?? null);
    // A model failure backs off and retries; the licence and JSON-LD
    // suggestions it did make are already written.
    const failed = Number(result.model_failures ?? 0) > 0;
    await settle(loc.client_id, loc.id, !failed, failed ? `${result.model_failures} model call(s) failed` : null);
    console.log(`seo-detail-suggestions ${locationId}: ${JSON.stringify(result)}`);
    return json({ ok: !failed, location_id: locationId, ...result });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "suggestions failed";
    console.error(`seo-detail-suggestions ${locationId} failed: ${reason}`);
    await settle(loc.client_id, loc.id, false, reason);
    return json({ ok: false, error: reason }, 500);
  }
});
