// =============================================================================
// seo-report — module 13 (plan.md): the monthly SEO report for one client.
//
//   POST /seo-report
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "client_id": "<uuid>", "period_start": "2026-08-01"?, "force": true? }
//
// Admin endpoint, same posture as the other seo-* functions. MUST be deployed
// with --no-verify-jwt (see this repo's memory on that).
//
// Scheduled by pg_cron (0057) hourly on days 1 to 5 of each month; the report
// covers the calendar month just ended. `period_start` (any date in the month)
// regenerates a specific month by hand.
//
// NO MODEL CALLS. Every sentence in the report is computed from stored rows, so
// rule 5 (client-supplied text stays out of prompts) has nothing to enforce here
// and the report can't invent a number.
//
// WHAT IT DOES: reads the month's rankings, geo-grid radius, GBP metrics,
// backlinks, AI-visibility checks, shipped and queued actions; assembles them
// into one ReportContent JSON (lib.ts); draws a PDF from it (pdf.ts); stores the
// PDF privately at seo-reports/<client_id>/<yyyy-mm>.pdf; upserts seo_reports;
// then emails it (Resend) to the client's active users.
//
// EMAIL IS BEST-EFFORT AND IDEMPOTENT. With no RESEND_API_KEY the report is still
// generated and stored, email_status = 'skipped_no_sender'. A send failure is
// recorded and retried on the next tick (0057's is_due). Resend's Idempotency-Key
// stops a retry double-sending.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET; optional RESEND_API_KEY, SEO_REPORT_FROM
//      ("LumiLink <reports@yourdomain>"), SITE_URL (for the link in the email).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { renderReportPdf } from "./pdf.ts";
import {
  heroSentence,
  searchStateMessage,
  searchSummary,
  type DayTotal,
  type KeywordCountRow,
  type SearchState,
} from "../seo-search-console/insights.ts";
import { addMonths } from "../seo-search-console/lib.ts";
import {
  dayAfter,
  describeRadius,
  keywordRanks,
  periodFromDate,
  previousMonth,
  profileMetrics,
  queuedItems,
  shippedItems,
  summarise,
  trendData,
  type ActionRow,
  type GridData,
  type GeoRadiusRow,
  type LocationReport,
  type LocationSearch,
  type Period,
  type RankRow,
  type ReportContent,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SEO_REPORT_FROM = Deno.env.get("SEO_REPORT_FROM");
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const BUCKET = "seo-reports";
const BASE_INTERVAL_MINUTES = 27 * 24 * 60; // see 0057: 27, not 30, so February can't slip a March report
const RETRY_INTERVAL_MINUTES = 60;
const MAX_BACKOFF_MINUTES = 24 * 60;
const RANK_LOOKBACK_DAYS = 45; // enough to find the check before the period began (checks are weekly)

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** PostgREST caps a response (1000 rows by default): page through until short. */
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const size = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < size) return out;
  }
}

async function settle(clientId: string, success: boolean, error: string | null) {
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: clientId,
    p_job_type: "seo_report",
    p_success: success,
    p_error: error,
    p_base_interval_minutes: success ? BASE_INTERVAL_MINUTES : RETRY_INTERVAL_MINUTES,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: null,
  });
  if (jobError) console.error(`seo-report ${clientId}: complete_job_attempt failed: ${jobError.message}`);
}

type LocationRow = {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  search_console_site_url: string | null;
};

/**
 * Search Console traffic for one property for the report month (module 21).
 * Read once per property per run; locations sharing a site share the result.
 */
async function propertySearch(
  clientId: string,
  siteUrl: string,
  period: Period,
  centsPerClick: number,
  sharedWith: number,
): Promise<LocationSearch> {
  const { data: prop, error: pErr } = await supabase
    .from("seo_search_properties")
    .select("status, data_through")
    .eq("client_id", clientId)
    .eq("site_url", siteUrl)
    .maybeSingle();
  if (pErr) throw new Error(`loading Search Console state failed: ${pErr.message}`);
  const state = ((prop?.status as SearchState | undefined) ?? "pending");
  const dataThrough = (prop?.data_through as string | null) ?? null;
  if (state !== "ok" || !dataThrough) {
    return { state: state === "ok" ? "pending" : state, site_url: siteUrl, message: searchStateMessage(state === "ok" ? "pending" : state, siteUrl, dataThrough) };
  }

  // 16 months back covers the year-over-year comparison and the rolling year.
  const from = addMonths(period.start, -15);
  const days = await fetchAll<DayTotal>((a, b) =>
    supabase
      .from("seo_search_daily")
      .select("date, clicks, impressions, position")
      .eq("client_id", clientId)
      .eq("site_url", siteUrl)
      .eq("device", "all")
      .gte("date", from)
      .lte("date", period.end)
      .order("date", { ascending: true })
      .range(a, b),
  );
  const { data: kwRows, error: kErr } = await supabase
    .from("seo_search_keyword_counts")
    .select("month, total, page_one, top_three, is_complete")
    .eq("client_id", clientId)
    .eq("site_url", siteUrl)
    .gte("month", from)
    .lte("month", period.start);
  if (kErr) throw new Error(`loading keyword counts failed: ${kErr.message}`);
  const { data: pages, error: pgErr } = await supabase
    .from("seo_search_monthly_pages")
    .select("page, clicks, impressions, position")
    .eq("client_id", clientId)
    .eq("site_url", siteUrl)
    .eq("month", period.start)
    .order("clicks", { ascending: false })
    .order("impressions", { ascending: false })
    .order("page")
    .limit(10);
  if (pgErr) throw new Error(`loading top pages failed: ${pgErr.message}`);

  const summary = searchSummary({
    siteUrl,
    days: days.map((d) => ({ ...d, position: d.position === null ? null : Number(d.position) })),
    keywordRows: ((kwRows ?? []) as KeywordCountRow[]),
    topPages: ((pages ?? []) as { page: string; clicks: number; impressions: number; position: number | string | null }[]).map((p) => ({
      key: p.page,
      clicks: p.clicks,
      impressions: p.impressions,
      position: p.position === null ? null : Number(p.position),
    })),
    dataThrough,
    month: period.start,
    centsPerClick,
  });
  if (!summary) {
    return { state: "no_data", site_url: siteUrl, message: `Search Console has no data for ${period.label} yet. ${searchStateMessage("ok", siteUrl, dataThrough)}` };
  }
  return { state: "ok", summary, shared_with: sharedWith, hero: heroSentence(summary, "yoy") };
}

async function locationReport(
  clientId: string,
  loc: LocationRow,
  period: Period,
  search: LocationSearch,
): Promise<LocationReport> {
  const lookbackFrom = new Date(`${period.start}T00:00:00Z`);
  lookbackFrom.setUTCDate(lookbackFrom.getUTCDate() - RANK_LOOKBACK_DAYS);
  const from = lookbackFrom.toISOString().slice(0, 10);
  const until = dayAfter(period.end);

  const { data: kwRows, error: kwErr } = await supabase
    .from("seo_keywords")
    .select("id, keyword, is_geo_grid_enabled")
    .eq("location_id", loc.id)
    .eq("is_active", true); // 0060: only keywords the client still tracks
  if (kwErr) throw new Error(`loading keywords failed: ${kwErr.message}`);
  const keywords = (kwRows ?? []) as { id: string; keyword: string; is_geo_grid_enabled: boolean }[];

  const rankRows = await fetchAll<RankRow>((a, b) =>
    supabase
      .from("seo_rankings")
      .select("keyword_id, rank_type, position, check_date")
      .eq("location_id", loc.id)
      .in("rank_type", ["organic", "local_pack"])
      .gte("check_date", from)
      .lte("check_date", period.end)
      .order("check_date", { ascending: true })
      .order("id", { ascending: true })
      .range(a, b),
  );
  const ranks = keywordRanks(keywords, rankRows, period);

  // Charts: up to 13 weeks of the location's trend, and the latest map-grid
  // sweep for its first geo-grid keyword (alphabetically, so it's stable month to month).
  const trendFrom = new Date(`${period.end}T00:00:00Z`);
  trendFrom.setUTCDate(trendFrom.getUTCDate() - 91);
  const { data: trendRows, error: trendErr } = await supabase
    .from("seo_rank_trend")
    .select("rank_type, check_date, avg_position")
    .eq("location_id", loc.id)
    .gte("check_date", trendFrom.toISOString().slice(0, 10))
    .lte("check_date", period.end)
    .order("check_date", { ascending: true });
  if (trendErr) throw new Error(`loading rank trend failed: ${trendErr.message}`);

  let grid: GridData | null = null;
  const geoKw = keywords.filter((k) => k.is_geo_grid_enabled).sort((a, b) => a.keyword.localeCompare(b.keyword))[0];
  if (geoKw) {
    const { data: latest } = await supabase
      .from("seo_rankings")
      .select("check_date")
      .eq("keyword_id", geoKw.id)
      .eq("rank_type", "geo_grid")
      .lte("check_date", period.end)
      .order("check_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest?.check_date) {
      const { data: cells, error: cellErr } = await supabase
        .from("seo_rankings")
        .select("grid_row, grid_col, position")
        .eq("keyword_id", geoKw.id)
        .eq("rank_type", "geo_grid")
        .eq("check_date", latest.check_date);
      if (cellErr) throw new Error(`loading map grid failed: ${cellErr.message}`);
      grid = {
        keyword: geoKw.keyword,
        check_date: latest.check_date as string,
        cells: (cells ?? []).map((c) => ({ row: c.grid_row as number, col: c.grid_col as number, position: c.position as number | null })),
      };
    }
  }

  const { data: radiusRow, error: radiusErr } = await supabase
    .from("seo_geo_radius")
    .select("keywords_checked, last_check_date, winnable_radius_km, grid_spacing_km")
    .eq("location_id", loc.id)
    .maybeSingle();
  if (radiusErr) throw new Error(`loading geo radius failed: ${radiusErr.message}`);

  const { data: metricRows, error: metricErr } = await supabase
    .from("seo_metrics_daily")
    .select("metrics")
    .eq("location_id", loc.id)
    .gte("metric_date", period.start)
    .lte("metric_date", period.end);
  if (metricErr) throw new Error(`loading profile metrics failed: ${metricErr.message}`);

  const { data: backlink, error: blErr } = await supabase
    .from("seo_backlink_snapshots")
    .select("snapshot_date, referring_domains_count, total_backlinks, gained_count, lost_count")
    .eq("location_id", loc.id)
    .lte("snapshot_date", period.end)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (blErr) throw new Error(`loading backlinks failed: ${blErr.message}`);

  const actionCols =
    "id, action_type, target_field, target_url, status, apply_mode, publish_result, proposed_value, published_at, created_at";
  const { data: shippedRows, error: shipErr } = await supabase
    .from("seo_actions")
    .select(actionCols)
    .eq("location_id", loc.id)
    .eq("status", "published")
    .gte("published_at", period.start)
    .lt("published_at", until);
  if (shipErr) throw new Error(`loading shipped work failed: ${shipErr.message}`);
  const { data: queuedRows, error: queueErr } = await supabase
    .from("seo_actions")
    .select(actionCols)
    .eq("location_id", loc.id)
    .in("status", ["pending_approval", "manual_required"]);
  if (queueErr) throw new Error(`loading queued work failed: ${queueErr.message}`);

  const { data: conn } = await supabase
    .from("seo_site_connections")
    .select("status")
    .eq("location_id", loc.id)
    .maybeSingle();

  return {
    id: loc.id,
    name: loc.name,
    search,
    rankings: {
      keywords: ranks,
      organic: summarise(ranks.map((k) => k.organic)),
      local_pack: summarise(ranks.map((k) => k.local_pack)),
    },
    trend: trendData((trendRows ?? []) as { rank_type: string; check_date: string; avg_position: number | null }[]),
    grid,
    radius: describeRadius(loc, keywords.filter((k) => k.is_geo_grid_enabled).length, (radiusRow as GeoRadiusRow | null) ?? null),
    profile_metrics: profileMetrics((metricRows ?? []) as { metrics: Record<string, unknown> }[]),
    backlinks: backlink
      ? {
          snapshot_date: backlink.snapshot_date as string,
          referring_domains: backlink.referring_domains_count as number | null,
          total: backlink.total_backlinks as number | null,
          gained: backlink.gained_count as number | null,
          lost: backlink.lost_count as number | null,
        }
      : null,
    site_connection: conn ? { status: conn.status as string } : null,
    shipped: shippedItems((shippedRows ?? []) as ActionRow[], period),
    queued: queuedItems((queuedRows ?? []) as ActionRow[]),
  };
}

async function aiVisibility(clientId: string, period: Period): Promise<ReportContent["ai_visibility"]> {
  const { count: queries, error: qErr } = await supabase
    .from("seo_ai_queries")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .eq("is_active", true);
  if (qErr) throw new Error(`loading AI queries failed: ${qErr.message}`);
  if (!queries) return null;

  const { data, error } = await supabase
    .from("seo_ai_mentions")
    .select("cited_count")
    .eq("client_id", clientId)
    .gte("check_date", period.start)
    .lte("check_date", period.end)
    .limit(5000);
  if (error) throw new Error(`loading AI mentions failed: ${error.message}`);
  const rows = (data ?? []) as { cited_count: number }[];
  return { queries, checks: rows.length, cited: rows.filter((r) => r.cited_count > 0).length };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function sendEmail(
  clientId: string,
  content: ReportContent,
  pdf: Uint8Array,
): Promise<{ status: "sent" | "skipped_no_sender" | "skipped_no_recipient" | "failed"; error: string | null }> {
  if (!RESEND_API_KEY || !SEO_REPORT_FROM) return { status: "skipped_no_sender", error: null };

  const { data: users, error: uErr } = await supabase
    .from("users")
    .select("email")
    .eq("client_id", clientId)
    .eq("is_active", true);
  if (uErr) return { status: "failed", error: `loading recipients failed: ${uErr.message}` };
  const to = [...new Set((users ?? []).map((u) => String(u.email ?? "").trim()).filter((e) => e.includes("@")))];
  if (to.length === 0) return { status: "skipped_no_recipient", error: null };

  let bin = "";
  for (let i = 0; i < pdf.length; i += 0x8000) bin += String.fromCharCode(...pdf.subarray(i, i + 0x8000));
  const link = SITE_URL ? `<p><a href="${escapeHtml(SITE_URL)}/seo/reports">Open it in your dashboard</a></p>` : "";
  const label = escapeHtml(content.period.label);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
      // A retry after a network blip must not send the same report twice.
      "Idempotency-Key": `seo-report-${clientId}-${content.period.start}`,
    },
    body: JSON.stringify({
      from: SEO_REPORT_FROM,
      to,
      subject: `Your ${content.period.label} SEO report`,
      html: `<p>Your ${label} SEO report is attached.</p>${link}<p>Nothing on your website or Google profile changes without your approval.</p>`,
      attachments: [{ filename: `seo-report-${content.period.start.slice(0, 7)}.pdf`, content: btoa(bin) }],
    }),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    return { status: "failed", error: `Resend ${res.status}: ${text}` };
  }
  return { status: "sent", error: null };
}

async function runClient(clientId: string, period: Period): Promise<Record<string, unknown>> {
  const { data: client, error: cErr } = await supabase.from("clients").select("name").eq("id", clientId).maybeSingle();
  if (cErr) throw new Error(`loading client failed: ${cErr.message}`);
  if (!client) throw new Error("client not found");

  const { data: locRows, error: lErr } = await supabase
    .from("seo_locations")
    .select("id, name, lat, lng, search_console_site_url")
    .eq("client_id", clientId)
    .eq("is_active", true)
    .order("name", { ascending: true });
  if (lErr) throw new Error(`loading locations failed: ${lErr.message}`);
  const locations = (locRows ?? []) as LocationRow[];
  if (locations.length === 0) throw new Error("client has no active locations");

  const { count: earlier } = await supabase
    .from("seo_reports")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .neq("period_start", period.start);

  const content: ReportContent = {
    version: 1,
    client_name: client.name as string,
    period,
    generated_at: new Date().toISOString(),
    is_first_report: (earlier ?? 0) === 0,
    ai_visibility: await aiVisibility(clientId, period),
    locations: [],
  };
  const { data: settings } = await supabase
    .from("seo_client_settings")
    .select("value_per_click_cents")
    .eq("client_id", clientId)
    .maybeSingle();
  const centsPerClick = (settings?.value_per_click_cents as number | undefined) ?? 200;
  const siteOf = (l: LocationRow) => (l.search_console_site_url ?? "").trim();
  const searchBySite = new Map<string, LocationSearch>();
  for (const loc of locations) {
    const site = siteOf(loc);
    let search: LocationSearch;
    if (!site) {
      search = { state: "not_set", site_url: null, message: searchStateMessage("not_set", null, null) };
    } else {
      if (!searchBySite.has(site)) {
        const sharing = locations.filter((l) => siteOf(l) === site).length - 1;
        searchBySite.set(site, await propertySearch(clientId, site, period, centsPerClick, sharing));
      }
      search = searchBySite.get(site)!;
    }
    content.locations.push(await locationReport(clientId, loc, period, search));
  }

  const pdf = await renderReportPdf(content);
  const path = `${clientId}/${period.start.slice(0, 7)}.pdf`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, pdf, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (upErr) throw new Error(`storing the PDF failed (does the private bucket ${BUCKET} exist?): ${upErr.message}`);

  // Keep the email state of an existing row: regenerating a month must not
  // re-send a report that already went out.
  const { data: existing } = await supabase
    .from("seo_reports")
    .select("email_status")
    .eq("client_id", clientId)
    .eq("period_start", period.start)
    .maybeSingle();
  const alreadySent = existing?.email_status === "sent";

  const { error: rowErr } = await supabase.from("seo_reports").upsert(
    {
      client_id: clientId,
      period_start: period.start,
      period_end: period.end,
      content,
      pdf_path: path,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "client_id,period_start" },
  );
  if (rowErr) throw new Error(`writing seo_reports failed: ${rowErr.message}`);

  let email: { status: string; error: string | null } = { status: "sent", error: null };
  if (!alreadySent) {
    email = await sendEmail(clientId, content, pdf);
    const { error: eErr } = await supabase
      .from("seo_reports")
      .update({
        email_status: email.status,
        email_error: email.error,
        emailed_at: email.status === "sent" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("client_id", clientId)
      .eq("period_start", period.start);
    if (eErr) console.error(`seo-report ${clientId}: recording email status failed: ${eErr.message}`);
  }

  return { period: period.label, locations: locations.length, email: email.status, email_error: email.error };
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

  let period: Period;
  if (body.period_start === undefined) {
    period = previousMonth(new Date());
  } else {
    const p = periodFromDate(String(body.period_start));
    if (!p) return json({ error: "period_start must be a date like 2026-08-01" }, 400);
    period = p;
  }

  try {
    const result = await runClient(clientId, period);
    // A failed send is worth retrying; the report itself is already stored.
    const failed = result.email === "failed";
    await settle(clientId, !failed, failed ? String(result.email_error) : null);
    console.log(`seo-report ${clientId}: ${JSON.stringify(result)}`);
    return json({ ok: !failed, ...result }, failed ? 502 : 200);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "report generation failed";
    console.error(`seo-report ${clientId} failed: ${reason}`);
    await settle(clientId, false, reason);
    return json({ ok: false, error: reason }, 500);
  }
});
