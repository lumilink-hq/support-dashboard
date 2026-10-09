// =============================================================================
// seo-gbp-sync — module 3 (plan.md, Phase 4): Google Business Profile read
// sync for one client, plus module 11's location mapping.
//
//   POST /seo-gbp-sync
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "client_id": "<uuid>", "full": true? }
//
// Admin endpoint, same posture as the other seo-* functions. MUST be deployed
// with --no-verify-jwt. `full: true` redoes every linked profile's six-month
// metrics backfill and first review pull (safe: every write is an upsert).
//
// PER RUN:
//   1. accounts.list, then accounts.locations.list per account -> upsert
//      seo_gbp_locations (a profile reachable through two accounts is kept once,
//      under the first). seo_gbp_sync records whether listing worked.
//   2. unambiguous profile <-> seo_location pairs are linked (lib.ts
//      matchLocations); everything else waits for /seo?tab=settings.
//   3. per linked profile: daily metrics -> seo_metrics_daily (lib.ts
//      metricsWindow / performanceDays), reviews -> seo_gbp_reviews, then the
//      completeness audit -> seo_findings (module 'gbp_profile').
//
// NEVER ZEROS. No connection / no business.manage -> seo_gbp_sync
// 'not_connected'. Reviews API not enabled -> reviews_status 'unavailable'.
// Metrics trailing days Google has no data for yet are dropped, not stored as 0.
//
// QUOTA. The project has 300 requests a minute across the Business Profile
// APIs. Every call reserves the shared 'google' vendor budget (0048) first and
// backs off on 429/5xx (rule 6). A first review pull pages at most
// MAX_REVIEW_PAGES_PER_RUN per profile, then resumes 15 minutes later.
//
// TOKEN. Reads module 2's cached access token, like seo-search-console.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET; GBP_API_BASE (optional, test only: when set, every
//      Google host is replaced by `${GBP_API_BASE}/<host>` so a local run can
//      point at a mock).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  auditProfile,
  backoffMs,
  classifyStatus,
  isoDate,
  LOCATION_READ_MASK,
  matchLocations,
  MAX_INCREMENTAL_REVIEW_PAGES,
  MAX_REVIEW_PAGES_PER_RUN,
  metricsWindow,
  parseAccounts,
  parseLocation,
  parseReviews,
  performanceDays,
  performanceQuery,
  reachedKnown,
  type GbpLocationRow,
  type ReviewRow,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const GBP_API_BASE = (Deno.env.get("GBP_API_BASE") ?? "").replace(/\/+$/, "");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const JOB_TYPE = "seo_gbp_sync";
const BASE_INTERVAL_MINUTES = 24 * 60; // daily
const RETRY_INTERVAL_MINUTES = 60;
const CONTINUE_INTERVAL_MINUTES = 15; // while a first review pull is still paging
const MAX_BACKOFF_MINUTES = 24 * 60;
const MAX_ATTEMPTS = 3;
const MAX_LIST_PAGES = 50; // circuit breaker on accounts / locations paging
/** Stop starting new profiles after this long; the rest continue in 15 minutes. */
const SOFT_DEADLINE_MS = 100_000;

const HOSTS = {
  accounts: "mybusinessaccountmanagement.googleapis.com",
  info: "mybusinessbusinessinformation.googleapis.com",
  perf: "businessprofileperformance.googleapis.com",
  v4: "mybusiness.googleapis.com",
};

function api(host: string, path: string): string {
  return GBP_API_BASE ? `${GBP_API_BASE}/${host}${path}` : `https://${host}${path}`;
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class CallError extends Error {
  constructor(public outcome: "no_access" | "retry" | "fatal", public status: number, message: string) {
    super(message);
  }
}

/** One GET to a Business Profile API, with budget reservation and exponential backoff (rule 6). */
async function getJson(token: string, url: string, label: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const { data: allowed, error: budgetError } = await supabase.rpc("check_and_reserve_vendor_budget", { p_vendor: "google" });
    if (budgetError) throw new CallError("retry", 0, `vendor budget check failed: ${budgetError.message}`);
    if (!allowed) throw new CallError("retry", 0, "google vendor budget exhausted this window");

    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) {
      if (attempt + 1 < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      throw new CallError("retry", 0, `${label} fetch failed: ${String(e)}`);
    }

    const outcome = classifyStatus(res.status);
    if (outcome === "ok") return await res.json();
    const text = (await res.text().catch(() => "")).slice(0, 300);
    if (outcome === "retry" && res.status !== 401 && attempt + 1 < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      continue;
    }
    throw new CallError(outcome === "ok" ? "fatal" : outcome, res.status, `${label} ${res.status}: ${text}`);
  }
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
  if (!(connection.granted_scopes as string[]).some((s) => s.endsWith("/business.manage"))) {
    return { state: "not_connected", reason: "the Google connection doesn't include Business Profile" };
  }
  const { data: tokenRow } = await supabase
    .from("google_oauth_tokens")
    .select("access_token_cache, access_token_expires_at")
    .eq("client_id", clientId)
    .maybeSingle();
  if (!tokenRow?.access_token_cache) return { state: "stale", reason: "no cached access token yet" };
  if (tokenRow.access_token_expires_at && new Date(tokenRow.access_token_expires_at).getTime() < Date.now() + 120_000) {
    return { state: "stale", reason: "cached access token is expired (is google-token-refresh running?)" };
  }
  return { token: tokenRow.access_token_cache as string };
}

async function setSync(clientId: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from("seo_gbp_sync").upsert({ client_id: clientId, ...patch }, { onConflict: "client_id" });
  if (error) console.error(`seo-gbp-sync ${clientId}: recording sync state failed: ${error.message}`);
}

async function updateListing(clientId: string, locationName: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from("seo_gbp_locations").update(patch).eq("client_id", clientId).eq("location_name", locationName);
  if (error) console.error(`seo-gbp-sync ${clientId} ${locationName}: update failed: ${error.message}`);
}

// -----------------------------------------------------------------------------
// 1. Accounts and locations
// -----------------------------------------------------------------------------

async function listEverything(token: string): Promise<{ accounts: number; rows: GbpLocationRow[] }> {
  const accounts: string[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const q = new URLSearchParams({ pageSize: "20" });
    if (pageToken) q.set("pageToken", pageToken);
    const payload = await getJson(token, api(HOSTS.accounts, `/v1/accounts?${q}`), "accounts.list");
    accounts.push(...parseAccounts(payload).map((a) => a.name));
    pageToken = (payload as { nextPageToken?: string })?.nextPageToken || null;
    if (!pageToken) break;
  }

  const seen = new Set<string>();
  const rows: GbpLocationRow[] = [];
  for (const account of accounts) {
    let locToken: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const q = new URLSearchParams({ pageSize: "100", readMask: LOCATION_READ_MASK });
      if (locToken) q.set("pageToken", locToken);
      let payload: unknown;
      try {
        payload = await getJson(token, api(HOSTS.info, `/v1/${account}/locations?${q}`), "locations.list");
      } catch (e) {
        // One account the login can't list (e.g. a group it was removed from)
        // shouldn't hide the others.
        if (e instanceof CallError && e.outcome === "no_access") {
          console.warn(`seo-gbp-sync: ${account}: ${e.message}`);
          break;
        }
        throw e;
      }
      for (const raw of ((payload as { locations?: unknown[] })?.locations ?? [])) {
        const row = parseLocation(raw, account);
        if (row && !seen.has(row.location_name)) {
          seen.add(row.location_name);
          rows.push(row);
        }
      }
      locToken = (payload as { nextPageToken?: string })?.nextPageToken || null;
      if (!locToken) break;
    }
  }
  return { accounts: accounts.length, rows };
}

// -----------------------------------------------------------------------------
// 2. Auto-linking
// -----------------------------------------------------------------------------

type SeoLoc = {
  id: string;
  address_line1: string | null;
  postal_code: string | null;
  phone_number: string | null;
  website_url: string | null;
  is_active: boolean;
};

async function autoLink(clientId: string, seoLocs: SeoLoc[]): Promise<number> {
  const { data: listings } = await supabase
    .from("seo_gbp_locations")
    .select("location_name, account_name, address_text, postal_code, phone, place_id, linked_location_id")
    .eq("client_id", clientId);
  const all = (listings ?? []) as { location_name: string; account_name: string; address_text: string | null; postal_code: string | null; phone: string | null; place_id: string | null; linked_location_id: string | null }[];
  const taken = new Set(all.map((l) => l.linked_location_id).filter(Boolean));
  const pairs = matchLocations(
    all.filter((l) => !l.linked_location_id),
    seoLocs.filter((s) => s.is_active && !taken.has(s.id)),
  );
  let linked = 0;
  for (const p of pairs) {
    const listing = all.find((l) => l.location_name === p.location_name)!;
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("seo_gbp_locations")
      .update({ linked_location_id: p.location_id, link_source: "auto", linked_at: now })
      .eq("client_id", clientId)
      .eq("location_name", p.location_name)
      .is("linked_location_id", null);
    if (error) {
      // The unique index refuses a location someone linked meanwhile; skip it.
      console.warn(`seo-gbp-sync ${clientId}: auto-link ${p.location_name} failed: ${error.message}`);
      continue;
    }
    await supabase
      .from("seo_locations")
      .update({ gbp_location_name: p.location_name, gbp_account_id: listing.account_name, google_place_id: listing.place_id, gbp_connected_at: now })
      .eq("id", p.location_id)
      .eq("client_id", clientId);
    linked++;
  }
  return linked;
}

// -----------------------------------------------------------------------------
// 3. Per linked profile
// -----------------------------------------------------------------------------

type Listing = GbpLocationRow & {
  linked_location_id: string;
  metrics_through: string | null;
  metrics_backfilled_at: string | null;
  reviews_status: string;
  reviews_backfilled_at: string | null;
  reviews_page_token: string | null;
};

async function syncMetrics(clientId: string, l: Listing, token: string, full: boolean): Promise<Record<string, unknown>> {
  const today = isoDate(new Date());
  const win = metricsWindow(full ? { metrics_through: null, metrics_backfilled_at: null } : l, today);
  try {
    const payload = await getJson(
      token,
      api(HOSTS.perf, `/v1/${l.location_name}:fetchMultiDailyMetricsTimeSeries?${performanceQuery(win)}`),
      "performance",
    );
    const days = performanceDays(payload);
    for (let i = 0; i < days.length; i += 500) {
      const { error } = await supabase.from("seo_metrics_daily").upsert(
        days.slice(i, i + 500).map((d) => ({ client_id: clientId, location_id: l.linked_location_id, metric_date: d.metric_date, metrics: d.metrics, source: "gbp" })),
        { onConflict: "location_id,metric_date" },
      );
      if (error) throw new CallError("retry", 0, `writing seo_metrics_daily failed: ${error.message}`);
    }
    const newest = days.length ? days[days.length - 1].metric_date : null;
    const through = !newest ? l.metrics_through : !l.metrics_through || newest > l.metrics_through ? newest : l.metrics_through;
    await updateListing(clientId, l.location_name, {
      metrics_through: through,
      // A backfill that returned nothing (a brand-new profile) is retried tomorrow.
      metrics_backfilled_at: win.backfill ? (through ? new Date().toISOString() : null) : l.metrics_backfilled_at,
      metrics_error: null,
    });
    return { from: win.start, to: win.end, days: days.length, through, backfill: win.backfill };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateListing(clientId, l.location_name, { metrics_error: msg.slice(0, 500) });
    if (e instanceof CallError && e.outcome === "no_access") return { error: msg, retry: false };
    throw e;
  }
}

async function syncReviews(clientId: string, l: Listing, token: string, full: boolean): Promise<{ result: Record<string, unknown>; more: boolean }> {
  const backfilling = full || !l.reviews_backfilled_at;
  let pageToken = backfilling && !full ? l.reviews_page_token : null;

  const { data: hwRow } = await supabase
    .from("seo_gbp_reviews")
    .select("updated_at_google")
    .eq("client_id", clientId)
    .eq("location_name", l.location_name)
    .order("updated_at_google", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const highWater = (hwRow?.updated_at_google as string | null) ?? null;

  const maxPages = backfilling ? MAX_REVIEW_PAGES_PER_RUN : MAX_INCREMENTAL_REVIEW_PAGES;
  let stored = 0;
  let avg: number | null = null;
  let total: number | null = null;
  let next: string | null = null;
  try {
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ pageSize: "50", orderBy: "updateTime desc" });
      if (pageToken) q.set("pageToken", pageToken);
      const parentId = l.location_name.split("/")[1];
      let payload: unknown;
      try {
        payload = await getJson(token, api(HOSTS.v4, `/v4/${l.account_name}/locations/${parentId}/reviews?${q}`), "reviews.list");
      } catch (e) {
        // A stale resume token: start the first pull over next time.
        if (e instanceof CallError && e.status === 400 && pageToken) {
          await updateListing(clientId, l.location_name, { reviews_page_token: null });
          return { result: { status: "restarting", error: e.message }, more: true };
        }
        throw e;
      }
      const parsed = parseReviews(payload);
      if (page === 0 || avg === null) {
        avg = parsed.averageRating ?? avg;
        total = parsed.totalReviewCount ?? total;
      }
      if (parsed.reviews.length > 0) {
        const { error } = await supabase.from("seo_gbp_reviews").upsert(
          parsed.reviews.map((r: ReviewRow) => ({
            client_id: clientId,
            location_name: l.location_name,
            location_id: l.linked_location_id,
            ...r,
            synced_at: new Date().toISOString(),
          })),
          { onConflict: "client_id,location_name,review_id" },
        );
        if (error) throw new CallError("retry", 0, `writing seo_gbp_reviews failed: ${error.message}`);
        stored += parsed.reviews.length;
      }
      next = parsed.nextPageToken;
      if (!next) break;
      if (!backfilling && reachedKnown(parsed.reviews, highWater)) {
        next = null;
        break;
      }
      pageToken = next;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof CallError && e.outcome === "no_access") {
      await updateListing(clientId, l.location_name, { reviews_status: "unavailable", reviews_error: msg.slice(0, 500) });
      return { result: { status: "unavailable", error: msg }, more: false };
    }
    await updateListing(clientId, l.location_name, { reviews_status: "error", reviews_error: msg.slice(0, 500) });
    throw e;
  }

  const now = new Date().toISOString();
  const unfinished = backfilling && !!next;
  await updateListing(clientId, l.location_name, {
    reviews_status: "ok",
    reviews_error: null,
    reviews_synced_at: now,
    average_rating: avg,
    total_review_count: total,
    reviews_page_token: unfinished ? next : null,
    reviews_backfilled_at: backfilling ? (unfinished ? null : now) : l.reviews_backfilled_at,
  });
  return { result: { status: "ok", stored, backfill: backfilling, unfinished }, more: unfinished };
}

async function auditListing(clientId: string, l: Listing, seo: SeoLoc | undefined, reviewsOk: boolean) {
  let reviews: { star_rating: number | null; reply_comment: string | null; created_at_google: string | null }[] | null = null;
  if (reviewsOk) {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const { data } = await supabase
      .from("seo_gbp_reviews")
      .select("star_rating, reply_comment, created_at_google")
      .eq("client_id", clientId)
      .eq("location_name", l.location_name)
      .gte("created_at_google", since)
      .limit(5000);
    reviews = (data ?? []) as typeof reviews;
  }
  const findings = auditProfile({ gbp: l, seo: seo ?? null, reviews, now: new Date() });

  // A finding someone dismissed or acted on isn't re-reported as new.
  const { data: closed } = await supabase
    .from("seo_findings")
    .select("finding_type")
    .eq("location_id", l.linked_location_id)
    .eq("module", "gbp_profile")
    .in("status", ["dismissed", "actioned"]);
  const skip = new Set(((closed ?? []) as { finding_type: string }[]).map((f) => f.finding_type));

  const { error: delErr } = await supabase
    .from("seo_findings")
    .delete()
    .eq("location_id", l.linked_location_id)
    .eq("module", "gbp_profile")
    .eq("status", "open");
  if (delErr) {
    console.error(`seo-gbp-sync ${clientId} ${l.location_name}: clearing findings failed: ${delErr.message}`);
    return 0;
  }
  const rows = findings
    .filter((f) => !skip.has(f.finding_type))
    .map((f) => ({
      client_id: clientId,
      location_id: l.linked_location_id,
      module: "gbp_profile",
      finding_type: f.finding_type,
      severity: f.severity,
      title: f.title,
      details: { ...f.details, gbp_location_name: l.location_name },
      target_url: l.maps_uri,
    }));
  if (rows.length > 0) {
    const { error } = await supabase.from("seo_findings").insert(rows);
    if (error) console.error(`seo-gbp-sync ${clientId} ${l.location_name}: inserting findings failed: ${error.message}`);
  }
  return rows.length;
}

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------

async function runClient(clientId: string, full: boolean): Promise<{ ok: boolean; more: boolean; result: Record<string, unknown> }> {
  const started = Date.now();
  const tok = await accessToken(clientId);
  if (!("token" in tok)) {
    if (tok.state === "not_connected") {
      await setSync(clientId, { status: "not_connected", last_error: tok.reason, last_synced_at: new Date().toISOString() });
      return { ok: true, more: false, result: { status: "not_connected", reason: tok.reason } };
    }
    return { ok: false, more: false, result: { status: "token_stale", reason: tok.reason } };
  }
  const token = tok.token;

  // 1. Accounts and locations.
  let listed: { accounts: number; rows: GbpLocationRow[] };
  try {
    listed = await listEverything(token);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const noAccess = e instanceof CallError && e.outcome === "no_access";
    await setSync(clientId, { status: noAccess ? "no_access" : "error", last_error: msg.slice(0, 500), last_synced_at: new Date().toISOString() });
    // Google refusing isn't fixed by retrying hourly.
    return { ok: noAccess, more: false, result: { status: noAccess ? "no_access" : "error", error: msg } };
  }

  const now = new Date().toISOString();
  for (let i = 0; i < listed.rows.length; i += 200) {
    const { error } = await supabase.from("seo_gbp_locations").upsert(
      listed.rows.slice(i, i + 200).map((r) => ({ client_id: clientId, ...r, last_seen_at: now })),
      { onConflict: "client_id,location_name" },
    );
    if (error) throw new Error(`writing seo_gbp_locations failed: ${error.message}`);
  }
  await setSync(clientId, {
    status: "ok",
    accounts_count: listed.accounts,
    locations_count: listed.rows.length,
    last_synced_at: now,
    last_error: null,
  });

  // 2. Linking.
  const { data: seoData, error: seoErr } = await supabase
    .from("seo_locations")
    .select("id, address_line1, postal_code, phone_number, website_url, is_active")
    .eq("client_id", clientId);
  if (seoErr) throw new Error(`loading locations failed: ${seoErr.message}`);
  const seoLocs = (seoData ?? []) as SeoLoc[];
  const autoLinked = await autoLink(clientId, seoLocs);

  // 3. Linked profiles seen this run.
  const { data: linkedData } = await supabase
    .from("seo_gbp_locations")
    .select("*")
    .eq("client_id", clientId)
    .not("linked_location_id", "is", null);
  const seen = new Set(listed.rows.map((r) => r.location_name));
  const linked = ((linkedData ?? []) as Listing[]).filter(
    (l) => seen.has(l.location_name) && seoLocs.find((s) => s.id === l.linked_location_id)?.is_active,
  );

  const profiles: Record<string, unknown>[] = [];
  let ok = true;
  let more = false;
  for (const l of linked) {
    if (Date.now() - started > SOFT_DEADLINE_MS) {
      more = true;
      profiles.push({ location_name: l.location_name, status: "deferred" });
      continue;
    }
    const entry: Record<string, unknown> = { location_name: l.location_name, location_id: l.linked_location_id };
    try {
      entry.metrics = await syncMetrics(clientId, l, token, full);
      const rv = await syncReviews(clientId, l, token, full);
      entry.reviews = rv.result;
      more ||= rv.more;
      entry.findings = await auditListing(clientId, l, seoLocs.find((s) => s.id === l.linked_location_id), rv.result.status === "ok");
    } catch (e) {
      ok = false;
      entry.error = e instanceof Error ? e.message : String(e);
      console.error(`seo-gbp-sync ${clientId} ${l.location_name}: ${entry.error}`);
    }
    profiles.push(entry);
  }

  return {
    ok,
    more,
    result: { status: "ok", accounts: listed.accounts, locations: listed.rows.length, auto_linked: autoLinked, linked: linked.length, profiles },
  };
}

async function settle(clientId: string, success: boolean, error: string | null, more = false) {
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: clientId,
    p_job_type: JOB_TYPE,
    p_success: success,
    p_error: error,
    p_base_interval_minutes: !success ? RETRY_INTERVAL_MINUTES : more ? CONTINUE_INTERVAL_MINUTES : BASE_INTERVAL_MINUTES,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: null,
  });
  if (jobError) console.error(`seo-gbp-sync ${clientId}: complete_job_attempt failed: ${jobError.message}`);
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
    const { ok, more, result } = await runClient(clientId, body.full === true);
    const errors = ((result.profiles ?? []) as Record<string, unknown>[])
      .map((p) => p.error)
      .filter(Boolean)
      .map(String);
    const err = ok ? null : (errors.join("; ") || String(result.reason ?? result.error ?? result.status)).slice(0, 500);
    await settle(clientId, ok, err, more);
    console.log(`seo-gbp-sync ${clientId}: ${JSON.stringify(result)}`);
    return json({ ok, client_id: clientId, more, result }, ok ? 200 : 502);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "GBP sync failed";
    console.error(`seo-gbp-sync ${clientId} failed: ${reason}`);
    await settle(clientId, false, reason);
    return json({ ok: false, error: reason }, 500);
  }
});
