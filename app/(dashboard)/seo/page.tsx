import Link from "next/link";
import { BarChart, Donut, HBars, HeatGrid, Legend, LineChart, MonthTrend, SERIES_COLORS } from "@/components/seo/charts";
import { CtrUpside } from "@/components/seo/ctr-upside";
import { SeoLocked } from "@/components/seo/locked";
import { Story, TileGrid } from "@/components/seo/search-tiles";
import { getSeoAccess } from "@/lib/seo-access";
import { formatDateTime } from "@/lib/format";
import {
  aiSummary,
  articleResults,
  compareToCompetitors,
  contentByMonth,
  daysAgo,
  KEYWORD_MAX,
  keywordStatsLine,
  latestPerKeyword,
  MAX_COMPETITORS_PER_LOCATION,
  MAX_GEO_GRID_KEYWORDS_PER_LOCATION,
  MAX_KEYWORDS_PER_LOCATION,
  parseCompare,
  parseTab,
  SEO_TAB_LABELS,
  SEO_TABS,
  splitSuggestions,
  trendPoints,
  type ClientRank,
  type Competitor,
  type CompetitorRank,
  type KeywordStats,
  type KeywordSuggestion,
  type Mention,
  type PageMonth,
  type SeoTab,
  type TrendRow,
} from "@/lib/seo-portal";
import { createClient } from "@/lib/supabase/server";
import { MAX_QUERIES_PER_CLIENT } from "@/supabase/functions/seo-ai-visibility/lib";
import {
  addMonths,
  dayLabel,
  fmtInt,
  fmtMoney,
  heroSentence,
  markers as toMarkers,
  monthLabel,
  normalisePageUrl,
  perClickLabel,
  searchStateMessage,
  searchSummary,
  type Compare,
  type DayTotal,
  type KeywordCountRow,
  type SearchState,
  type SearchSummary,
} from "@/supabase/functions/seo-search-console/insights";
import { competitorGapScore, type CompetitorGapRow } from "@/supabase/functions/seo-content/lib";
import {
  describeRadius,
  fieldLabel,
  METRIC_LABELS,
  profileMetrics,
  safeUrl,
  whyItMatters,
  type GeoRadiusRow,
} from "@/supabase/functions/seo-report/lib";
import {
  addAiQuery,
  addCompetitor,
  addKeyword,
  dismissCompetitorGap,
  dismissKeywordSuggestion,
  removeAiQuery,
  removeCompetitor,
  removeKeyword,
  setKeywordGeoGrid,
} from "./actions";

type Loc = { id: string; name: string; lat: number | null; lng: number | null; search_console_site_url: string | null };
type Keyword = { id: string; keyword: string; is_geo_grid_enabled: boolean };
type Shipped = {
  id: string;
  action_type: string;
  target_field: string | null;
  target_url: string | null;
  apply_mode: string | null;
  publish_result: { verified?: boolean } | null;
  proposed_value: { title?: string } | null;
  published_at: string;
};
type BacklinkRow = { snapshot_date: string; referring_domains_count: number | null; total_backlinks: number | null; gained_count: number | null; lost_count: number | null };
type MetricRow = { metric_date: string; metrics: Record<string, unknown> };
type AiQuery = { id: string; query: string };
type CompetitorGap = CompetitorGapRow & { cpc: number | string | null; competitor_positions: string[] };
type TopRow = { page?: string; query?: string; clicks: number; impressions: number; position: number | string | null };

function Card({ title, id, children, note }: { title: string; id?: string; children: React.ReactNode; note?: string }) {
  return (
    <section id={id} className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      {note ? <p className="mt-0.5 text-xs text-gray-500">{note}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-500">{children}</p>;
}

/** Top pages or queries: the first 20, the rest (up to 100) behind "Show all". */
function TopTable({ rows, keyLabel, caption }: { rows: TopRow[]; keyLabel: string; caption: string }) {
  const line = (r: TopRow) => {
    const key = r.page ?? r.query ?? "";
    return (
      <tr key={key}>
        <td className="max-w-[18rem] break-words py-1.5 pr-3 text-gray-900 sm:max-w-md">{key}</td>
        <td className="pr-3 text-right tabular-nums">{fmtInt(r.clicks)}</td>
        <td className="pr-3 text-right tabular-nums">{fmtInt(r.impressions)}</td>
        <td className="text-right tabular-nums">{r.position === null ? "–" : Number(r.position).toFixed(1)}</td>
      </tr>
    );
  };
  const head = (
    <thead className="text-xs text-gray-500">
      <tr>
        <th className="py-1 pr-3 font-medium">{keyLabel}</th>
        <th className="pr-3 text-right font-medium">Clicks</th>
        <th className="pr-3 text-right font-medium">Impressions</th>
        <th className="text-right font-medium">Avg. position</th>
      </tr>
    </thead>
  );
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          {head}
          <tbody className="divide-y divide-gray-100">{rows.slice(0, 20).map(line)}</tbody>
        </table>
      </div>
      {rows.length > 20 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-blue-700 underline">Show all {rows.length}</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-sm">
              {head}
              <tbody className="divide-y divide-gray-100">{rows.slice(20).map(line)}</tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function GapLine({ gap, locationId, atCap }: { gap: CompetitorGap; locationId: string; atCap: boolean }) {
  const stats = keywordStatsLine(gap);
  const isTopic = competitorGapScore(gap) > 0;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="min-w-0 break-words">
        <span className="text-gray-800">{gap.keyword}</span>
        {isTopic ? <span className="ml-2 rounded-full bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">Article topic</span> : null}
        <span className="block text-xs text-gray-500">{[gap.competitor_positions.join(", "), stats].filter(Boolean).join(" · ")}</span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <form action={addKeyword}>
          <input type="hidden" name="location" value={locationId} />
          <input type="hidden" name="keyword" value={gap.keyword} />
          <button
            type="submit"
            disabled={atCap}
            aria-label={`Track ${gap.keyword}`}
            className="rounded-md border border-gray-900 px-2 py-0.5 text-xs text-gray-900 hover:bg-gray-900 hover:text-white disabled:cursor-not-allowed disabled:border-gray-300 disabled:text-gray-400 disabled:hover:bg-transparent"
          >
            Track
          </button>
        </form>
        <form action={dismissCompetitorGap}>
          <input type="hidden" name="keyword" value={gap.keyword} />
          <input type="hidden" name="location" value={locationId} />
          <button type="submit" aria-label={`Dismiss ${gap.keyword}`} className="text-xs text-gray-500 underline hover:text-gray-900">
            Dismiss
          </button>
        </form>
      </span>
    </li>
  );
}

function SuggestionList({
  heading,
  lead,
  rows,
  locationId,
  atCap,
}: {
  heading: string;
  lead: string;
  rows: KeywordSuggestion[];
  locationId: string;
  atCap: boolean;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-900">{heading}</h3>
      <p className="text-xs text-gray-500">{lead}</p>
      <ul className="mt-1 divide-y divide-gray-100 text-sm">
        {rows.map((r) => {
          const stats = keywordStatsLine(r);
          const evidence =
            r.source === "search_console" && r.gsc_impressions !== null && r.gsc_position !== null
              ? `Seen ${fmtInt(r.gsc_impressions)} times at position ${Number(r.gsc_position).toFixed(1)}${r.gsc_month ? ` in ${monthLabel(r.gsc_month)}` : ""}`
              : null;
          return (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0 break-words">
                <span className="text-gray-800">{r.keyword}</span>
                {evidence || stats ? (
                  <span className="block text-xs text-gray-500">{[evidence, stats].filter(Boolean).join(" · ")}</span>
                ) : null}
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <form action={addKeyword}>
                  <input type="hidden" name="location" value={locationId} />
                  <input type="hidden" name="keyword" value={r.keyword} />
                  <button
                    type="submit"
                    disabled={atCap}
                    aria-label={`Track ${r.keyword}`}
                    className="rounded-md border border-gray-900 px-2 py-0.5 text-xs text-gray-900 hover:bg-gray-900 hover:text-white disabled:cursor-not-allowed disabled:border-gray-300 disabled:text-gray-400 disabled:hover:bg-transparent"
                  >
                    Track
                  </button>
                </form>
                <form action={dismissKeywordSuggestion}>
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="location" value={locationId} />
                  <button type="submit" aria-label={`Dismiss ${r.keyword}`} className="text-xs text-gray-500 underline hover:text-gray-900">
                    Dismiss
                  </button>
                </form>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default async function SeoPortalPage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string; keyword?: string; error?: string; tab?: string; compare?: string }>;
}) {
  const access = await getSeoAccess();
  if (!access.allowed) return <SeoLocked state={access.state} />;

  const { location: locParam, keyword: kwParam, error: actionError, tab: tabParam, compare: compareParam } = await searchParams;
  const tab: SeoTab = parseTab(tabParam);
  const compare: Compare = parseCompare(compareParam);
  const supabase = await createClient();

  const { data: locData } = await supabase
    .from("seo_locations")
    .select("id, name, lat, lng, search_console_site_url")
    .eq("is_active", true)
    .order("name", { ascending: true });
  const locations = (locData ?? []) as Loc[];

  if (locations.length === 0) {
    return (
      <div>
        <h1 className="text-lg font-semibold text-gray-900">SEO</h1>
        <div className="mt-6">
          <Empty>No locations are set up yet, so there is nothing to report on.</Empty>
        </div>
      </div>
    );
  }

  const loc = locations.find((l) => l.id === locParam) ?? locations[0];
  const site = (loc.search_console_site_url ?? "").trim() || null;
  const sharedWith = site ? locations.filter((l) => (l.search_console_site_url ?? "").trim() === site).length - 1 : 0;
  const since90 = daysAgo(90);
  const since200 = daysAgo(200);
  const since16m = addMonths(daysAgo(0), -16);

  const [
    kwRes, trendRes, radiusRes, connRes, compRes, backlinkRes, metricRes, shippedRes, queryRes, mentionRes, pendingRes,
    propRes, dailyRes, kwCountRes, settingsRes, milestoneRes, entRes, googleRes, publishedRes, metricLatestRes,
    kwStatsRes, suggestionRes, gapRes,
  ] = await Promise.all([
    supabase.from("seo_keywords").select("id, keyword, is_geo_grid_enabled").eq("location_id", loc.id).eq("is_active", true).order("keyword"),
    supabase.from("seo_rank_trend").select("rank_type, check_date, avg_position").eq("location_id", loc.id).gte("check_date", since200).order("check_date"),
    supabase.from("seo_geo_radius").select("keywords_checked, last_check_date, winnable_radius_km, grid_spacing_km").eq("location_id", loc.id).maybeSingle(),
    supabase.from("seo_site_connections").select("status, shop_domain, last_error").eq("location_id", loc.id).maybeSingle(),
    supabase.from("seo_competitors").select("id, domain, label").eq("location_id", loc.id).eq("is_active", true).order("domain"),
    supabase.from("seo_backlink_snapshots").select("snapshot_date, referring_domains_count, total_backlinks, gained_count, lost_count").eq("location_id", loc.id).order("snapshot_date", { ascending: false }).limit(12),
    supabase.from("seo_metrics_daily").select("metric_date, metrics").eq("location_id", loc.id).gte("metric_date", daysAgo(60)).order("metric_date"),
    supabase.from("seo_actions").select("id, action_type, target_field, target_url, apply_mode, publish_result, proposed_value, published_at").eq("location_id", loc.id).eq("status", "published").gte("published_at", since90).order("published_at", { ascending: false }).limit(25),
    supabase.from("seo_ai_queries").select("id, query").eq("is_active", true).order("created_at"),
    supabase.from("seo_ai_mentions").select("query_id, platform, cited_count, check_date").gte("check_date", daysAgo(30)).limit(2000),
    supabase.from("seo_actions").select("id", { count: "exact", head: true }).eq("location_id", loc.id).in("status", ["pending_approval", "manual_required"]),
    // Module 21: Search Console traffic for this location's website.
    site
      ? supabase.from("seo_search_properties").select("status, data_through, last_synced_at").eq("site_url", site).maybeSingle()
      : Promise.resolve({ data: null }),
    site
      ? supabase.from("seo_search_daily").select("date, clicks, impressions, position").eq("site_url", site).eq("device", "all").gte("date", since16m).order("date").limit(1000)
      : Promise.resolve({ data: [] }),
    site
      ? supabase.from("seo_search_keyword_counts").select("month, total, page_one, top_three, is_complete").eq("site_url", site).gte("month", since16m).order("month")
      : Promise.resolve({ data: [] }),
    supabase.from("seo_client_settings").select("value_per_click_cents").maybeSingle(),
    supabase.from("seo_milestones").select("occurred_on, label").order("occurred_on"),
    supabase.from("entitlements").select("started_at").eq("feature", "seo").order("started_at").limit(1).maybeSingle(),
    supabase.from("google_oauth_connections").select("connected_at, status").maybeSingle(),
    supabase.from("seo_actions").select("action_type, target_url, apply_mode, publish_result, proposed_value, published_at").eq("location_id", loc.id).eq("status", "published").gte("published_at", since16m).order("published_at").limit(1000),
    supabase.from("seo_metrics_daily").select("metric_date").eq("location_id", loc.id).order("metric_date", { ascending: false }).limit(1).maybeSingle(),
    // Module 22: volume and difficulty per phrase (per client, so every
    // location's keywords are in here), and the open suggestions.
    supabase.from("seo_keyword_metrics").select("keyword, search_volume, cpc, keyword_difficulty").limit(5000),
    supabase
      .from("seo_keyword_suggestions")
      .select("id, keyword, source, search_volume, cpc, keyword_difficulty, gsc_impressions, gsc_clicks, gsc_position, gsc_month")
      .eq("status", "open")
      .limit(200),
    // Module 23: searches this location's competitors rank for that it doesn't.
    supabase
      .from("seo_competitor_gaps")
      .select("location_id, keyword, competitors_ranking, best_competitor_position, competitor_positions, search_volume, cpc, keyword_difficulty, main_intent")
      .eq("location_id", loc.id)
      .order("search_volume", { ascending: false, nullsFirst: false })
      .limit(100),
  ]);

  const keywords = (kwRes.data ?? []) as Keyword[];
  const kwStats = new Map(((kwStatsRes.data ?? []) as KeywordStats[]).map((m) => [m.keyword, m]));
  const suggestions = splitSuggestions((suggestionRes.data ?? []) as KeywordSuggestion[], new Set(keywords.map((k) => k.keyword)));
  const atKeywordCap = keywords.length >= MAX_KEYWORDS_PER_LOCATION;
  const gaps = (gapRes.data ?? []) as CompetitorGap[];
  const trend = (trendRes.data ?? []) as TrendRow[];
  const backlinks = ((backlinkRes.data ?? []) as BacklinkRow[]).slice().reverse();
  const metrics = (metricRes.data ?? []) as MetricRow[];
  const shipped = (shippedRes.data ?? []) as Shipped[];
  const aiQueries = (queryRes.data ?? []) as AiQuery[];
  const mentions = (mentionRes.data ?? []) as Mention[];
  const competitors = (compRes.data ?? []) as Competitor[];
  const conn = connRes.data as { status: string; shop_domain: string; last_error: string | null } | null;
  const queued = pendingRes.count ?? 0;
  const centsPerClick = (settingsRes.data?.value_per_click_cents as number | undefined) ?? 200;
  const published = (publishedRes.data ?? []) as (Shipped & { published_at: string })[];

  // ---------------------------------------------------------------------------
  // Search Console summary (module 21)
  // ---------------------------------------------------------------------------
  const prop = propRes.data as { status: SearchState; data_through: string | null; last_synced_at: string | null } | null;
  const searchState: SearchState = !site ? "not_set" : prop?.status ?? "pending";
  const dataThrough = prop?.data_through ?? null;
  const days = ((dailyRes.data ?? []) as { date: string; clicks: number; impressions: number; position: number | string | null }[]).map(
    (d): DayTotal => ({ date: d.date, clicks: d.clicks, impressions: d.impressions, position: d.position === null ? null : Number(d.position) }),
  );
  let summary: SearchSummary | null =
    site && dataThrough && days.length > 0
      ? searchSummary({ siteUrl: site, days, keywordRows: (kwCountRes.data ?? []) as KeywordCountRow[], topPages: [], dataThrough, centsPerClick })
      : null;

  let topPages: TopRow[] = [];
  let topQueries: TopRow[] = [];
  if (summary && site) {
    const [pRes, qRes] = await Promise.all([
      supabase.from("seo_search_monthly_pages").select("page, clicks, impressions, position").eq("site_url", site).eq("month", summary.period.month).order("clicks", { ascending: false }).order("impressions", { ascending: false }).order("page").limit(100),
      supabase.from("seo_search_monthly_queries").select("query, clicks, impressions, position").eq("site_url", site).eq("month", summary.period.month).order("clicks", { ascending: false }).order("impressions", { ascending: false }).order("query").limit(100),
    ]);
    topPages = (pRes.data ?? []) as TopRow[];
    topQueries = (qRes.data ?? []) as TopRow[];
    summary = { ...summary, top_pages: topPages.slice(0, 10).map((r) => ({ key: r.page!, clicks: r.clicks, impressions: r.impressions, position: r.position === null ? null : Number(r.position) })) };
  }
  const hero = summary ? heroSentence(summary, compare) : null;

  // Chart markers from things we already know, plus operator-entered milestones.
  const firstLive = published.find((a) => a.apply_mode === "api" && a.publish_result?.verified === true);
  const firstArticle = published.find((a) => a.action_type === "content_publish");
  const events = [
    ...(entRes.data?.started_at ? [{ date: String(entRes.data.started_at).slice(0, 10), label: "LumiLink SEO starts" }] : []),
    ...(googleRes.data?.connected_at ? [{ date: String(googleRes.data.connected_at).slice(0, 10), label: "Google connected" }] : []),
    ...(firstLive ? [{ date: firstLive.published_at.slice(0, 10), label: "First change live" }] : []),
    ...(firstArticle ? [{ date: firstArticle.published_at.slice(0, 10), label: "First article" }] : []),
    ...((milestoneRes.data ?? []) as { occurred_on: string; label: string }[]).map((m) => ({ date: m.occurred_on, label: m.label })),
  ];
  const chartMonths = summary?.months ?? [];
  const chartMarkers = toMarkers(events, chartMonths.map((m) => m.month));

  // Content output against results.
  const last12 = Array.from({ length: 12 }, (_, i) => addMonths(daysAgo(0), i - 11));
  const output = contentByMonth(published.map((a) => ({ action_type: a.action_type, target_url: a.target_url, published_at: a.published_at })), last12);
  const articles = published
    .filter((a) => a.action_type === "content_publish" && safeUrl(a.target_url))
    .reverse()
    .slice(0, 50)
    .map((a) => ({ title: a.proposed_value?.title ?? "Article", url: a.target_url as string, normalised: normalisePageUrl(a.target_url as string), published_at: a.published_at }));
  let articlePages: PageMonth[] = [];
  if (site && articles.length > 0) {
    const { data } = await supabase
      .from("seo_search_monthly_pages")
      .select("page, month, clicks, impressions, position")
      .eq("site_url", site)
      .in("page", [...new Set(articles.map((a) => a.normalised))])
      .limit(2000);
    articlePages = (data ?? []) as PageMonth[];
  }
  const articleRows = articleResults(articles, articlePages);

  // ---------------------------------------------------------------------------
  // Rankings, competitors, map grid (module 10)
  // ---------------------------------------------------------------------------
  const since30 = daysAgo(30);
  const [clientRankRes, compRankRes, keywordRankRes] = await Promise.all([
    supabase.from("seo_rankings").select("keyword_id, position, check_date").eq("location_id", loc.id).eq("rank_type", "organic").gte("check_date", since30).limit(5000),
    competitors.length
      ? supabase.from("seo_competitor_rankings").select("competitor_id, keyword_id, position, check_date").eq("location_id", loc.id).eq("rank_type", "organic").gte("check_date", since30).limit(5000)
      : Promise.resolve({ data: [] as CompetitorRank[] }),
    keywords.length
      ? supabase.from("seo_rankings").select("keyword_id, position, check_date").in("keyword_id", keywords.map((k) => k.id)).eq("rank_type", "organic").gte("check_date", since200).limit(5000)
      : Promise.resolve({ data: [] as ClientRank[] }),
  ]);
  const clientRanks = (clientRankRes.data ?? []) as ClientRank[];
  const latestRank = new Map(latestPerKeyword((keywordRankRes.data ?? []) as ClientRank[]).map((r) => [r.keyword_id, r]));
  const standings = compareToCompetitors(loc.name, clientRanks, competitors, (compRankRes.data ?? []) as CompetitorRank[]);

  const geoKeywords = keywords.filter((k) => k.is_geo_grid_enabled);
  const geoKw = geoKeywords.find((k) => k.id === kwParam) ?? geoKeywords[0];
  let gridCells: { row: number; col: number; position: number | null }[] = [];
  let gridDate: string | null = null;
  if (geoKw) {
    const { data: latest } = await supabase
      .from("seo_rankings")
      .select("check_date")
      .eq("keyword_id", geoKw.id)
      .eq("rank_type", "geo_grid")
      .order("check_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest?.check_date) {
      gridDate = latest.check_date as string;
      const { data: cells } = await supabase
        .from("seo_rankings")
        .select("grid_row, grid_col, position")
        .eq("keyword_id", geoKw.id)
        .eq("rank_type", "geo_grid")
        .eq("check_date", gridDate);
      gridCells = (cells ?? []).map((c) => ({ row: c.grid_row as number, col: c.grid_col as number, position: c.position as number | null }));
    }
  }

  const radius = describeRadius(loc, geoKeywords.length, (radiusRes.data as GeoRadiusRow | null) ?? null);
  const gbp = profileMetrics(metrics);
  const ai = aiSummary(mentions);
  const latestMention = new Map<string, Mention>();
  for (const m of latestPerKeyword(mentions.map((m) => ({ ...m, keyword_id: `${m.query_id}|${m.platform}` })))) {
    latestMention.set(m.keyword_id, m);
  }

  const organicPts = trendPoints(trend, "organic");
  const packPts = trendPoints(trend, "local_pack");
  const trendSeries = [
    { name: "Website results", color: SERIES_COLORS[0], points: organicPts },
    { name: "Map pack", color: SERIES_COLORS[1], points: packPts },
  ].filter((s) => s.points.some((p) => p.y !== null));
  const lastOrganic = [...organicPts].reverse().find((p) => p.y !== null);
  const latestCheck = trend.length ? trend[trend.length - 1].check_date : null;
  const latestMentionDate = mentions.reduce<string | null>((a, m) => (!a || m.check_date > a ? m.check_date : a), null);
  const top10Now = latestPerKeyword(clientRanks).filter((r) => r.position !== null && r.position <= 10).length;

  const maxTop10 = Math.max(1, ...standings.map((s) => s.checked));

  // ---------------------------------------------------------------------------
  // Links that keep the location, tab and comparison
  // ---------------------------------------------------------------------------
  const href = (over: { tab?: SeoTab; compare?: Compare; location?: string; keyword?: string }) => {
    const qs = new URLSearchParams();
    qs.set("location", over.location ?? loc.id);
    const t = over.tab ?? tab;
    if (t !== "overview") qs.set("tab", t);
    const c = over.compare ?? compare;
    if (c !== "yoy") qs.set("compare", c);
    if (over.keyword) qs.set("keyword", over.keyword);
    return `/seo?${qs.toString()}`;
  };

  const kwTile = summary?.tiles.find((t) => t.key === "keywords");
  const latestBacklink = backlinks.length ? backlinks[backlinks.length - 1] : null;
  const badges: Partial<Record<SeoTab, string>> = {
    keywords: kwTile ? kwTile.value : keywords.length ? String(keywords.length) : undefined,
    ai: ai.checks > 0 ? String(ai.cited) : undefined,
    links: latestBacklink?.referring_domains_count != null ? fmtInt(latestBacklink.referring_domains_count) : undefined,
    work: queued > 0 ? String(queued) : undefined,
  };

  const coverage: { source: string; text: string; ok: boolean }[] = [
    { source: "Search Console", text: searchState === "ok" && dataThrough ? `through ${dayLabel(dataThrough)}` : searchStateMessage(searchState, site, dataThrough), ok: searchState === "ok" && !!dataThrough },
    { source: "Rankings", text: latestCheck ? `checked ${dayLabel(latestCheck)}` : "no checks yet", ok: !!latestCheck },
    { source: "Map grid", text: gridDate ? `checked ${dayLabel(gridDate)}` : "not run yet", ok: !!gridDate },
    { source: "Links", text: latestBacklink ? `as of ${dayLabel(latestBacklink.snapshot_date)}` : "not pulled yet", ok: !!latestBacklink },
    { source: "AI answers", text: latestMentionDate ? `checked ${dayLabel(latestMentionDate)}` : aiQueries.length ? "first check pending" : "no questions tracked", ok: !!latestMentionDate },
    { source: "Google Business Profile", text: metricLatestRes.data?.metric_date ? `through ${dayLabel(metricLatestRes.data.metric_date as string)}` : "not connected", ok: !!metricLatestRes.data?.metric_date },
  ];

  return (
    <div className="space-y-4">
      {/* Header strip: title, period, links */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-lg font-semibold text-gray-900">SEO</h1>
          {summary ? (
            <span className="rounded-full border border-gray-300 bg-white px-3 py-0.5 text-xs font-medium text-gray-700">
              {summary.period.label} · data through {dayLabel(summary.data_through)}
            </span>
          ) : null}
        </div>
        <div className="flex gap-3 text-sm">
          <Link href="/seo/reports" className="text-blue-700 underline">Monthly reports</Link>
          <Link href="/seo-approvals" className="text-blue-700 underline">
            Approvals{queued > 0 ? ` (${queued} waiting)` : ""}
          </Link>
        </div>
      </div>

      {locations.length > 1 ? (
        <nav aria-label="Location" className="flex flex-wrap gap-1">
          {locations.map((l) => (
            <Link
              key={l.id}
              href={href({ location: l.id })}
              aria-current={l.id === loc.id ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${l.id === loc.id ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"}`}
            >
              {l.name}
            </Link>
          ))}
        </nav>
      ) : (
        <p className="text-sm text-gray-500">{loc.name}</p>
      )}

      {/* Tabs. They scroll sideways at phone width rather than wrapping into a block. */}
      <nav aria-label="SEO sections" className="-mx-4 overflow-x-auto overflow-y-hidden border-b border-gray-200 px-4 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-1">
          {SEO_TABS.map((t) => (
            <li key={t}>
              <Link
                href={href({ tab: t })}
                aria-current={t === tab ? "page" : undefined}
                className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
                  t === tab ? "border-gray-900 text-gray-900" : "border-transparent text-gray-500 hover:text-gray-900"
                }`}
              >
                {SEO_TAB_LABELS[t]}
                {badges[t] ? (
                  <span className={`rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${t === tab ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600"}`}>
                    {badges[t]}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {actionError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{actionError}</div>
      ) : null}

      {conn && conn.status !== "healthy" && conn.status !== "unchecked" ? (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {conn.status === "revoked"
            ? `LumiLink's access to ${conn.shop_domain} was revoked or has expired.`
            : conn.status === "degraded"
              ? `LumiLink's access to ${conn.shop_domain} is missing some permissions.`
              : `LumiLink couldn't reach ${conn.shop_domain} on the last check.`}{" "}
          Until it is fixed, approved changes come to you as step-by-step instructions instead of publishing themselves.
        </div>
      ) : null}

      {/* ================================================================== */}
      {tab === "overview" ? (
        <div className="space-y-8">
          <section aria-label="Data coverage" className="rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-600">
            <p className="font-semibold text-gray-900">Data coverage</p>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {coverage.map((c) => (
                <li key={c.source}>
                  <span aria-hidden className={c.ok ? "text-emerald-600" : "text-gray-400"}>{c.ok ? "● " : "○ "}</span>
                  <span className="font-medium text-gray-800">{c.source}:</span> {c.text}
                </li>
              ))}
            </ul>
          </section>

          {/* Hero */}
          <section className="rounded-xl bg-gray-900 p-5 text-white sm:p-6">
            {summary && hero ? (
              <>
                <h2 className="text-2xl font-semibold leading-tight sm:text-3xl">{hero.headline}</h2>
                <p className="mt-2 max-w-3xl text-sm text-gray-300">{hero.summary}</p>
                {sharedWith > 0 ? (
                  <p className="mt-2 text-xs text-gray-400">
                    These are figures for the whole website ({summary.site_url}), which {sharedWith} other location{sharedWith === 1 ? " shares" : "s share"}.
                  </p>
                ) : null}
                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-gray-400">Compare</span>
                  {(["yoy", "mom"] as Compare[]).map((c) => (
                    <Link
                      key={c}
                      href={href({ compare: c })}
                      aria-current={c === compare ? "true" : undefined}
                      className={`rounded-full px-3 py-1 font-medium ${c === compare ? "bg-white text-gray-900" : "bg-gray-800 text-gray-200 hover:bg-gray-700"}`}
                    >
                      {c === "yoy" ? "Year over year" : "Month over month"}
                    </Link>
                  ))}
                </div>
              </>
            ) : (
              <>
                <h2 className="text-2xl font-semibold leading-tight">
                  {latestCheck ? `${top10Now} of ${keywords.length} tracked keyword${keywords.length === 1 ? "" : "s"} in Google's top 10` : `Here's where ${loc.name} stands`}
                </h2>
                <p className="mt-2 max-w-3xl text-sm text-gray-300">{searchStateMessage(searchState, site, dataThrough)}</p>
              </>
            )}
          </section>

          {summary ? (
            <>
              <TileGrid tiles={summary.tiles} compare={compare} />

              <Story
                eyebrow="Growth"
                headline="Every month, measured"
                lead={`Clicks from Google search each month, from Search Console.${summary.period.complete ? "" : ` The last point is ${summary.period.range} so far, drawn hollow; it is not a forecast.`}`}
                source={`Search Console · ${summary.site_url} · final data through ${dayLabel(summary.data_through)}. Markers give context; on their own they don't prove cause.`}
              >
                <div className="rounded-lg border border-gray-200 bg-white p-4">
                  <MonthTrend
                    label={`Monthly clicks from Google search, ${monthLabel(chartMonths[0]?.month ?? summary.period.month)} to ${summary.period.label}`}
                    points={chartMonths.map((m) => ({ month: m.month, value: m.clicks, partial: !m.complete }))}
                    markers={chartMarkers}
                  />
                </div>
              </Story>

              <Story
                eyebrow="Return on investment"
                headline={`Estimated traffic value: ${fmtMoney(summary.value.year.cents)} over the last year`}
                lead={`${fmtInt(summary.value.year.clicks)} clicks from Google search from ${dayLabel(summary.value.year.start)} to ${dayLabel(summary.value.year.end)}, counted at ${perClickLabel(centsPerClick)} a click.`}
                source="A replacement value for the traffic, not revenue or profit. Sales attribution needs Google Analytics, which isn't connected."
              >
                <div className="grid gap-4 rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 md:grid-cols-[auto_1fr] md:items-center">
                  <div>
                    <p className="text-4xl font-semibold tabular-nums text-emerald-800">{fmtMoney(summary.value.year.cents)}</p>
                    <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-emerald-800/80">Traffic value · {summary.value.year.label}</p>
                    <p className="mt-2 text-sm text-gray-700">
                      {summary.period.range}: <strong>{fmtMoney(summary.value.period.cents)}</strong>
                    </p>
                  </div>
                  <div>
                    <BarChart
                      label="Traffic value per month"
                      series={[{ name: "Traffic value", color: SERIES_COLORS[3] }]}
                      format={(n) => `$${Math.round(n).toLocaleString("en-US")}`}
                      categories={summary.value.months.map((m) => ({ label: `${monthLabel(m.month)}${m.partial ? "*" : ""}`, values: [m.cents / 100] }))}
                    />
                    {summary.value.months.some((m) => m.partial) ? <p className="text-xs text-gray-500">* so far this month</p> : null}
                  </div>
                </div>
              </Story>

              <Story
                eyebrow="Top pages"
                headline={`Where the clicks landed, ${summary.period.range}`}
                source="Search Console's top pages for the month. Address variants (www, http, tracking tags) are counted as one page."
              >
                {topPages.length === 0 ? (
                  <Empty>No page-level data for this month yet.</Empty>
                ) : (
                  <div className="rounded-lg border border-gray-200 bg-white p-4">
                    <TopTable rows={topPages} keyLabel="Page" caption={`Top pages, ${summary.period.range}`} />
                  </div>
                )}
              </Story>
            </>
          ) : (
            <Card title="Where you can win" note="How far from this location you can realistically appear in the top 3 map results.">
              <p className="text-sm text-gray-800">{radius.statement}</p>
            </Card>
          )}
        </div>
      ) : null}

      {/* ================================================================== */}
      {tab === "keywords" ? (
        <div className="space-y-4">
          {summary && summary.keyword_months.some((k) => k.is_complete) ? (
            <Story
              eyebrow="Keywords gained"
              headline={kwTile ? `${kwTile.value} searches showed your site in ${kwTile.period.replace(" · complete month", "")}` : "Searches that show your site"}
              lead="Every distinct search that showed your site in Google at least once, by its average position that month. Complete months only."
              source={`Search Console · ${summary.site_url}.`}
            >
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <BarChart
                  label="Ranking keywords per month by average position"
                  series={[
                    { name: "Top 3", color: SERIES_COLORS[3] },
                    { name: "4 to 10", color: SERIES_COLORS[1] },
                    { name: "11 or lower", color: SERIES_COLORS[2] },
                  ]}
                  format={(n) => Math.round(n).toLocaleString("en-US")}
                  categories={summary.keyword_months
                    .filter((k) => k.is_complete)
                    .slice(-12)
                    .map((k) => ({ label: monthLabel(k.month), values: [k.top_three, k.page_one - k.top_three, k.total - k.page_one] }))}
                />
                <Legend items={[{ label: "Top 3", color: SERIES_COLORS[3] }, { label: "4 to 10", color: SERIES_COLORS[1] }, { label: "11 or lower", color: SERIES_COLORS[2] }]} />
              </div>
            </Story>
          ) : null}

          <Card
            title="Keywords you track"
            id="keywords"
            note={`What you want this location to be found for. Each one is checked on Google weekly. Up to ${MAX_KEYWORDS_PER_LOCATION} per location; the map grid can be on for up to ${MAX_GEO_GRID_KEYWORDS_PER_LOCATION}.`}
          >
            {keywords.length === 0 ? (
              <Empty>No keywords yet. Add the searches you want this location to show up for.</Empty>
            ) : (
              <ul className="divide-y divide-gray-100 text-sm">
                {keywords.map((k) => {
                  const r = latestRank.get(k.id);
                  return (
                    <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="min-w-0 break-words">
                        <span className="text-gray-800">{k.keyword}</span>
                        {keywordStatsLine(kwStats.get(k.keyword)) ? (
                          <span className="block text-xs text-gray-500">{keywordStatsLine(kwStats.get(k.keyword))}</span>
                        ) : null}
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            !r ? "bg-gray-100 text-gray-500" : r.position !== null && r.position <= 10 ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {!r ? "Not checked yet" : r.position === null ? "Not ranking yet" : `#${r.position} on Google`}
                          {r && r.check_date < since30 ? ` · ${r.check_date}` : ""}
                        </span>
                        <form action={setKeywordGeoGrid}>
                          <input type="hidden" name="id" value={k.id} />
                          <input type="hidden" name="location" value={loc.id} />
                          <input type="hidden" name="on" value={k.is_geo_grid_enabled ? "false" : "true"} />
                          <button
                            type="submit"
                            aria-pressed={k.is_geo_grid_enabled}
                            className={`rounded-md border px-2 py-0.5 text-xs ${
                              k.is_geo_grid_enabled ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 text-gray-600 hover:border-gray-500"
                            }`}
                          >
                            Map grid {k.is_geo_grid_enabled ? "on" : "off"}
                          </button>
                        </form>
                        <form action={removeKeyword}>
                          <input type="hidden" name="id" value={k.id} />
                          <input type="hidden" name="location" value={loc.id} />
                          <button type="submit" className="text-xs text-gray-500 underline hover:text-gray-900">Stop tracking</button>
                        </form>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {geoKeywords.length > 0 && (loc.lat === null || loc.lng === null) ? (
              <p className="mt-2 text-xs text-amber-700">
                This location has no map coordinates yet, so the map grid won&apos;t run until it does.
              </p>
            ) : null}
            {keywords.length < MAX_KEYWORDS_PER_LOCATION ? (
              <form action={addKeyword} className="mt-3 flex flex-wrap gap-2">
                <input type="hidden" name="location" value={loc.id} />
                <label className="sr-only" htmlFor="seo-keyword">Keyword to track</label>
                <input
                  id="seo-keyword"
                  name="keyword"
                  required
                  minLength={2}
                  maxLength={KEYWORD_MAX}
                  placeholder="e.g. emergency plumber springfield"
                  className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                />
                <button type="submit" className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800">
                  Track keyword
                </button>
              </form>
            ) : (
              <p className="mt-2 text-xs text-gray-500">You&apos;re tracking the maximum of {MAX_KEYWORDS_PER_LOCATION}. Stop tracking one to add another.</p>
            )}
          </Card>

          <Card
            title="Suggested keywords"
            id="suggested-keywords"
            note="Searches worth tracking, refreshed monthly. Search volumes are US-wide monthly averages from DataForSEO."
          >
            {suggestions.searchConsole.length === 0 && suggestions.related.length === 0 ? (
              <Empty>
                {site || keywords.length
                  ? "No suggestions yet. They're worked out once a month from your tracked keywords and Search Console, and refreshed within the hour after you add a keyword."
                  : "Add a keyword or connect Search Console, and suggestions will appear here."}
              </Empty>
            ) : (
              <div className="space-y-4">
                {suggestions.searchConsole.length > 0 ? (
                  <SuggestionList
                    heading="Already showing up, just off the top"
                    lead="Searches your site already appears for at an average position of 8 to 20. A small push here moves the most traffic."
                    rows={suggestions.searchConsole.slice(0, 15)}
                    locationId={loc.id}
                    atCap={atKeywordCap}
                  />
                ) : null}
                {suggestions.related.length > 0 ? (
                  <SuggestionList
                    heading="Related searches"
                    lead="Searches related to the keywords you track, most searched first."
                    rows={suggestions.related.slice(0, 15)}
                    locationId={loc.id}
                    atCap={atKeywordCap}
                  />
                ) : null}
                {atKeywordCap ? (
                  <p className="text-xs text-gray-500">You&apos;re tracking the maximum of {MAX_KEYWORDS_PER_LOCATION}. Stop tracking one to add a suggestion.</p>
                ) : null}
              </div>
            )}
          </Card>

          {summary && topQueries.length > 0 ? (
            <Card title={`Top searches, ${summary.period.range}`} note="The searches that brought the most clicks this month, from Search Console. Anonymised searches are left out by Google.">
              <TopTable rows={topQueries} keyLabel="Search" caption={`Top searches, ${summary.period.range}`} />
            </Card>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Rankings over time" note="Average position across your tracked keywords. Lower is better.">
              {trendSeries.length === 0 ? (
                <Empty>No ranking checks yet. Rankings are checked weekly once keywords are set up.</Empty>
              ) : (
                <>
                  <LineChart
                    series={trendSeries}
                    invert
                    yLabel="Average position"
                    label={`Average position over time. ${lastOrganic ? `Website results are now at ${lastOrganic.y}.` : ""}`}
                  />
                  <Legend items={trendSeries.map((s) => ({ label: s.name, color: s.color }))} />
                  {lastOrganic ? <p className="mt-2 text-sm text-gray-700">Website results average position now: <strong>{lastOrganic.y}</strong>.</p> : null}
                </>
              )}
            </Card>

            <Card title="You vs competitors" id="competitors" note="Keywords in the top 10 on the latest check, out of the keywords you're tracked on.">
              {competitors.length === 0 ? (
                <Empty>No competitors are being tracked for this location yet.</Empty>
              ) : standings[0].checked === 0 ? (
                <Empty>No ranking checks in the last 30 days to compare.</Empty>
              ) : (
                <HBars
                  label="Keywords in the top 10, you versus each competitor"
                  max={maxTop10}
                  rows={standings.map((s, i) => ({
                    label: s.label,
                    value: s.top10,
                    color: s.isClient ? SERIES_COLORS[0] : SERIES_COLORS[(i % (SERIES_COLORS.length - 1)) + 1],
                    highlight: s.isClient,
                    note: `${s.top10} of ${s.checked}${s.avgPosition !== null ? ` · avg #${s.avgPosition}` : ""}`,
                  }))}
                />
              )}

              <ul className="mt-4 divide-y divide-gray-100 text-sm">
                {competitors.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0 break-all text-gray-800">{c.label || c.domain}</span>
                    <form action={removeCompetitor}>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="location" value={loc.id} />
                      <button type="submit" className="text-xs text-gray-500 underline hover:text-gray-900">Stop tracking</button>
                    </form>
                  </li>
                ))}
              </ul>
              {competitors.length < MAX_COMPETITORS_PER_LOCATION ? (
                <form action={addCompetitor} className="mt-3 flex flex-wrap gap-2">
                  <input type="hidden" name="location" value={loc.id} />
                  <label className="sr-only" htmlFor="competitor-domain">Competitor website</label>
                  <input
                    id="competitor-domain"
                    name="domain"
                    required
                    maxLength={253}
                    placeholder="rival.com"
                    className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                  />
                  <button type="submit" className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800">
                    Track competitor
                  </button>
                </form>
              ) : (
                <p className="mt-2 text-xs text-gray-500">You&apos;re tracking the maximum of {MAX_COMPETITORS_PER_LOCATION}. Stop tracking one to add another.</p>
              )}
            </Card>
          </div>

          <Card
            title="Competitor keyword gaps"
            id="competitor-gaps"
            note="Searches your competitors rank for in Google's top 20 that your site doesn't show up for at all. Refreshed monthly; US-wide search volumes."
          >
            {competitors.length === 0 ? (
              <Empty>Track a competitor above to see the searches they win and you don&apos;t.</Empty>
            ) : gaps.length === 0 ? (
              <Empty>No gaps found yet. They&apos;re checked once a month, and within the hour after a competitor is added.</Empty>
            ) : (
              <>
                <p className="mb-2 text-xs text-gray-500">
                  Marked <span className="rounded-full bg-blue-50 px-1.5 py-0.5 text-blue-700">Article topic</span> when a competitor is on page one and the difficulty is 50 or less: weekly articles can be written for these, and each still waits for your approval.
                </p>
                <ul className="divide-y divide-gray-100 text-sm">
                  {gaps.slice(0, 15).map((g) => (
                    <GapLine key={g.keyword} gap={g} locationId={loc.id} atCap={atKeywordCap} />
                  ))}
                </ul>
                {gaps.length > 15 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm text-blue-700 underline">Show all {gaps.length}</summary>
                    <ul className="mt-1 divide-y divide-gray-100 text-sm">
                      {gaps.slice(15).map((g) => (
                        <GapLine key={g.keyword} gap={g} locationId={loc.id} atCap={atKeywordCap} />
                      ))}
                    </ul>
                  </details>
                ) : null}
              </>
            )}
          </Card>
        </div>
      ) : null}

      {/* ================================================================== */}
      {tab === "ai" ? (
        <Card title="Appearing in AI answers" id="ai" note={`Whether AI answers cite your site for the questions you care about (last 30 days). Up to ${MAX_QUERIES_PER_CLIENT} questions are checked weekly.`}>
          <div className="grid gap-4 md:grid-cols-[auto_1fr]">
            <div className="flex flex-col items-center">
              {ai.checks === 0 ? (
                <p className="max-w-[10rem] text-center text-sm text-gray-500">
                  {aiQueries.length === 0 ? "Add a question to start tracking." : "The first check hasn't run yet."}
                </p>
              ) : (
                <>
                  <Donut value={ai.cited} total={ai.checks} label={`Your site was cited in ${ai.cited} of ${ai.checks} AI answer checks`} />
                  <p className="mt-1 text-center text-sm text-gray-700">Cited in <strong>{ai.cited}</strong> of {ai.checks} checks</p>
                  <ul className="mt-1 text-xs text-gray-500">
                    {ai.platforms.map((p) => (
                      <li key={p.platform}>{p.label}: {p.cited} of {p.checks}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            <div>
              {aiQueries.length > 0 ? (
                <ul className="divide-y divide-gray-100 text-sm">
                  {aiQueries.map((q) => {
                    const g = latestMention.get(`${q.id}|google`);
                    const c = latestMention.get(`${q.id}|chat_gpt`);
                    const badge = (m: Mention | undefined, name: string) =>
                      m ? (
                        <span className={`rounded-full px-2 py-0.5 text-xs ${m.cited_count > 0 ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                          {name}: {m.cited_count > 0 ? "cited" : "not cited"}
                        </span>
                      ) : null;
                    return (
                      <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span className="min-w-0 break-words text-gray-800">{q.query}</span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          {badge(g, "Google")}
                          {badge(c, "ChatGPT")}
                          <form action={removeAiQuery}>
                            <input type="hidden" name="id" value={q.id} />
                            <input type="hidden" name="location" value={loc.id} />
                            <button type="submit" className="text-xs text-gray-500 underline hover:text-gray-900">Stop tracking</button>
                          </form>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}

              <form action={addAiQuery} className="mt-3 flex flex-wrap gap-2">
                <input type="hidden" name="location" value={loc.id} />
                <label className="sr-only" htmlFor="ai-query">A question customers ask AI</label>
                <input
                  id="ai-query"
                  name="query"
                  required
                  minLength={2}
                  maxLength={250}
                  placeholder="e.g. Who is the best emergency plumber in Springfield?"
                  className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                />
                <button type="submit" className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800">
                  Track this question
                </button>
              </form>
            </div>
          </div>
        </Card>
      ) : null}

      {/* ================================================================== */}
      {tab === "map" ? (
        <div className="space-y-4">
          <Card title="Where you can win" note="How far from this location you can realistically appear in the top 3 map results.">
            <p className="text-sm text-gray-800">{radius.statement}</p>
          </Card>

          <Card title="Map results around your location" note={gridDate && geoKw ? `“${geoKw.keyword}”, checked ${gridDate}. Your location is the outlined centre.` : undefined}>
            {gridCells.length === 0 ? (
              <Empty>
                {geoKeywords.length === 0
                  ? "No keyword is set up for the map-grid check yet. Switch one on under Keywords."
                  : loc.lat === null || loc.lng === null
                    ? "This location has no map coordinates on file, so the map-grid check hasn't run."
                    : "The map-grid check hasn't completed a sweep yet."}
              </Empty>
            ) : (
              <>
                {geoKeywords.length > 1 ? (
                  <div className="mb-2 flex flex-wrap gap-1">
                    {geoKeywords.map((k) => (
                      <Link
                        key={k.id}
                        href={href({ keyword: k.id })}
                        className={`rounded-md px-2 py-1 text-xs font-medium ${k.id === geoKw?.id ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"}`}
                      >
                        {k.keyword}
                      </Link>
                    ))}
                  </div>
                ) : null}
                <HeatGrid cells={gridCells} label={`Map grid for ${geoKw?.keyword}: your position in the local results at each point around the location`} />
              </>
            )}
          </Card>

          <Card title="Google Business Profile" note="Views, calls and direction requests from your profile, last 60 days.">
            {!gbp.available ? (
              <Empty>
                Connect your Google Business Profile to see how many people view, call and ask for directions. {gbp.reason}
              </Empty>
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {Object.entries(METRIC_LABELS)
                    .filter(([k]) => k in gbp.totals)
                    .map(([k, label]) => (
                      <div key={k}>
                        <dt className="text-xs text-gray-500">{label}</dt>
                        <dd className="text-lg font-semibold text-gray-900">{gbp.totals[k]}</dd>
                      </div>
                    ))}
                </dl>
                <LineChart
                  label="Profile views and calls per day"
                  series={["views_maps", "views_search", "calls"]
                    .filter((k) => metrics.some((m) => typeof m.metrics[k] === "number"))
                    .map((k, i) => ({
                      name: METRIC_LABELS[k],
                      color: SERIES_COLORS[i],
                      points: metrics.map((m) => ({ x: m.metric_date, y: typeof m.metrics[k] === "number" ? (m.metrics[k] as number) : null })),
                    }))}
                />
              </>
            )}
          </Card>
        </div>
      ) : null}

      {/* ================================================================== */}
      {tab === "links" ? (
        <Card title="Links to your site" note="Sites that link to yours, and links gained and lost each month.">
          {backlinks.length === 0 ? (
            <Empty>No backlink data yet. It is pulled monthly.</Empty>
          ) : (
            <>
              <p className="text-sm text-gray-700">
                <strong>{latestBacklink?.referring_domains_count != null ? fmtInt(latestBacklink.referring_domains_count) : "–"}</strong> sites link to you
                ({latestBacklink?.total_backlinks != null ? fmtInt(latestBacklink.total_backlinks) : "–"} links in total).
              </p>
              <BarChart
                label="Backlinks gained and lost per month"
                series={[{ name: "Gained", color: SERIES_COLORS[3] }, { name: "Lost", color: SERIES_COLORS[4] }]}
                categories={backlinks.map((b) => ({
                  label: new Date(`${b.snapshot_date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
                  values: [b.gained_count ?? 0, b.lost_count ?? 0],
                }))}
              />
              <Legend items={[{ label: "Gained", color: SERIES_COLORS[3] }, { label: "Lost", color: SERIES_COLORS[4] }]} />
            </>
          )}
        </Card>
      ) : null}

      {/* ================================================================== */}
      {tab === "work" ? (
        <div className="space-y-8">
          <Card title="Work shipped" note="Changes that went live in the last 90 days, and why each kind matters.">
            {shipped.length === 0 ? (
              <Empty>Nothing has gone live yet. Drafts appear under Approvals.</Empty>
            ) : (
              <ul className="divide-y divide-gray-100 text-sm">
                {shipped.map((s) => {
                  const verified = s.apply_mode === "api" && s.publish_result?.verified === true;
                  const link = safeUrl(s.target_url);
                  const why = whyItMatters(s.target_field);
                  return (
                    <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                      <span className="min-w-0 max-w-2xl">
                        <span className="font-medium text-gray-900">{fieldLabel(s.target_field)}</span>
                        {s.action_type === "content_publish" && s.proposed_value?.title ? <span className="text-gray-700">: {s.proposed_value.title}</span> : null}
                        {why ? <span className="mt-0.5 block text-xs text-gray-500">Why it matters: {why}</span> : null}
                        {link ? (
                          <a href={link} target="_blank" rel="noopener noreferrer" className="block break-all text-xs text-blue-700 underline">{s.target_url}</a>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-2 text-xs text-gray-500">
                        <span className={`rounded-full px-2 py-0.5 ${verified ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
                          {verified ? "Confirmed live" : "Applied by you, not yet confirmed"}
                        </span>
                        {formatDateTime(s.published_at)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {queued > 0 ? (
              <p className="mt-3 text-sm text-gray-600">
                {queued} more {queued === 1 ? "change is" : "changes are"} queued. <Link href="/seo-approvals" className="text-blue-700 underline">Review them</Link>.
              </p>
            ) : null}
          </Card>

          <Story
            eyebrow="What's driving it"
            headline={`${output.reduce((s, m) => s + m.articles, 0)} articles and ${output.reduce((s, m) => s + m.changes, 0)} page changes in the last 12 months`}
            lead="What went live each month, and how each published article has done in Google search since."
            source="From LumiLink's own publishing log for this location. Article results come from Search Console's top pages each month."
          >
            <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
              <div>
                <BarChart
                  label="Articles and page changes published per month"
                  series={[{ name: "Articles", color: SERIES_COLORS[1] }, { name: "Page changes", color: SERIES_COLORS[2] }]}
                  categories={output.map((m) => ({ label: monthLabel(m.month), values: [m.articles, m.changes] }))}
                />
                <Legend items={[{ label: "Articles", color: SERIES_COLORS[1] }, { label: "Page changes", color: SERIES_COLORS[2] }]} />
              </div>
              {articleRows.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">Published articles and their search results since publishing</caption>
                    <thead className="text-xs text-gray-500">
                      <tr>
                        <th className="py-1 pr-3 font-medium">Article</th>
                        <th className="pr-3 font-medium">Published</th>
                        <th className="pr-3 text-right font-medium">Impressions</th>
                        <th className="pr-3 text-right font-medium">Clicks</th>
                        <th className="text-right font-medium">Avg. position</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {articleRows.map((a) => (
                        <tr key={a.url}>
                          <td className="max-w-xs py-1.5 pr-3">
                            <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">{a.title}</a>
                          </td>
                          <td className="whitespace-nowrap pr-3 text-gray-600">{dayLabel(a.published_at.slice(0, 10))}</td>
                          {a.impressions === null ? (
                            <td colSpan={3} className="text-right text-xs text-gray-500">{site ? "No search data yet" : "Search Console not set up"}</td>
                          ) : (
                            <>
                              <td className="pr-3 text-right tabular-nums">{fmtInt(a.impressions)}</td>
                              <td className="pr-3 text-right tabular-nums">{fmtInt(a.clicks ?? 0)}</td>
                              <td className="text-right tabular-nums">{a.position === null ? "–" : a.position.toFixed(1)}</td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          </Story>

          {summary ? (
            <Story
              eyebrow="Upside"
              headline="What a better click-through rate would be worth"
              lead={`Same impressions as ${summary.period.range}, a different share of people clicking. Better page titles and descriptions are how this moves.`}
              source="A sensitivity model, not a forecast. It holds impressions fixed and is never annualised."
            >
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <CtrUpside
                  impressions={summary.tiles.find((t) => t.key === "impressions")!.raw}
                  clicks={summary.tiles.find((t) => t.key === "clicks")!.raw}
                  centsPerClick={centsPerClick}
                  periodLabel={summary.period.range}
                />
              </div>
            </Story>
          ) : null}

          <Story eyebrow="Roadmap" headline="What this dashboard can't see yet">
            <ul className="space-y-2 text-sm text-gray-700">
              {searchState !== "ok" ? (
                <li><strong className="text-gray-900">Search Console traffic.</strong> {searchStateMessage(searchState, site, dataThrough)}</li>
              ) : null}
              {!gbp.available ? (
                <li><strong className="text-gray-900">Google Business Profile actions.</strong> Calls, direction requests and website clicks from your profile, once Google grants profile access.</li>
              ) : null}
              <li><strong className="text-gray-900">Google Analytics.</strong> Visits, engagement and sales from search traffic. Search clicks alone don&apos;t measure customers.</li>
              <li><strong className="text-gray-900">More AI platforms.</strong> AI answers are checked on Google AI Overviews and ChatGPT today; Gemini, Perplexity and others come later.</li>
            </ul>
          </Story>
        </div>
      ) : null}
    </div>
  );
}
