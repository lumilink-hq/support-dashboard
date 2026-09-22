import Link from "next/link";
import { BarChart, Donut, HBars, HeatGrid, Legend, LineChart, SERIES_COLORS } from "@/components/seo/charts";
import { SeoLocked } from "@/components/seo/locked";
import { getSeoAccess } from "@/lib/seo-access";
import { formatDateTime } from "@/lib/format";
import {
  aiSummary,
  compareToCompetitors,
  daysAgo,
  latestPerKeyword,
  MAX_COMPETITORS_PER_LOCATION,
  trendPoints,
  type ClientRank,
  type Competitor,
  type CompetitorRank,
  type Mention,
  type TrendRow,
} from "@/lib/seo-portal";
import { createClient } from "@/lib/supabase/server";
import { MAX_QUERIES_PER_CLIENT } from "@/supabase/functions/seo-ai-visibility/lib";
import {
  describeRadius,
  fieldLabel,
  METRIC_LABELS,
  profileMetrics,
  safeUrl,
  type GeoRadiusRow,
} from "@/supabase/functions/seo-report/lib";
import { addAiQuery, addCompetitor, removeAiQuery, removeCompetitor } from "./actions";

type Loc = { id: string; name: string; lat: number | null; lng: number | null };
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

export default async function SeoPortalPage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string; keyword?: string; error?: string }>;
}) {
  const access = await getSeoAccess();
  if (!access.allowed) return <SeoLocked state={access.state} />;

  const { location: locParam, keyword: kwParam, error: actionError } = await searchParams;
  const supabase = await createClient();

  const { data: locData } = await supabase
    .from("seo_locations")
    .select("id, name, lat, lng")
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
  const since90 = daysAgo(90);
  const since200 = daysAgo(200);

  const [
    kwRes, trendRes, radiusRes, connRes, compRes, backlinkRes, metricRes, shippedRes, queryRes, mentionRes, pendingRes,
  ] = await Promise.all([
    supabase.from("seo_keywords").select("id, keyword, is_geo_grid_enabled").eq("location_id", loc.id).order("keyword"),
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
  ]);

  const keywords = (kwRes.data ?? []) as Keyword[];
  const trend = (trendRes.data ?? []) as TrendRow[];
  const backlinks = ((backlinkRes.data ?? []) as BacklinkRow[]).slice().reverse();
  const metrics = (metricRes.data ?? []) as MetricRow[];
  const shipped = (shippedRes.data ?? []) as Shipped[];
  const aiQueries = (queryRes.data ?? []) as AiQuery[];
  const mentions = (mentionRes.data ?? []) as Mention[];
  const competitors = (compRes.data ?? []) as Competitor[];
  const conn = connRes.data as { status: string; shop_domain: string; last_error: string | null } | null;
  const queued = pendingRes.count ?? 0;

  // Rankings and competitors read the last 30 days, then collapse to the latest check.
  const since30 = daysAgo(30);
  const [clientRankRes, compRankRes] = await Promise.all([
    supabase.from("seo_rankings").select("keyword_id, position, check_date").eq("location_id", loc.id).eq("rank_type", "organic").gte("check_date", since30).limit(5000),
    competitors.length
      ? supabase.from("seo_competitor_rankings").select("competitor_id, keyword_id, position, check_date").eq("location_id", loc.id).eq("rank_type", "organic").gte("check_date", since30).limit(5000)
      : Promise.resolve({ data: [] as CompetitorRank[] }),
  ]);
  const standings = compareToCompetitors(
    loc.name,
    (clientRankRes.data ?? []) as ClientRank[],
    competitors,
    (compRankRes.data ?? []) as CompetitorRank[],
  );

  // Geo grid: the latest sweep for the chosen geo-enabled keyword.
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

  const maxTop10 = Math.max(1, ...standings.map((s) => s.checked));
  const locHref = (id: string) => `/seo?location=${id}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-gray-900">SEO</h1>
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
              href={locHref(l.id)}
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

      <Card title="Where you can win" note="How far from this location you can realistically appear in the top 3 map results.">
        <p className="text-sm text-gray-800">{radius.statement}</p>
      </Card>

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

        <Card title="Map results around your location" note={gridDate && geoKw ? `“${geoKw.keyword}”, checked ${gridDate}. Your location is the outlined centre.` : undefined}>
          {gridCells.length === 0 ? (
            <Empty>
              {geoKeywords.length === 0
                ? "No keyword is set up for the map-grid check yet."
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
                      href={`/seo?location=${loc.id}&keyword=${k.id}`}
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

        <Card title="Links to your site" note="Sites that link to yours, and links gained and lost each month.">
          {backlinks.length === 0 ? (
            <Empty>No backlink data yet. It is pulled monthly.</Empty>
          ) : (
            <>
              <p className="text-sm text-gray-700">
                <strong>{backlinks[backlinks.length - 1].referring_domains_count ?? "–"}</strong> sites link to you
                ({backlinks[backlinks.length - 1].total_backlinks ?? "–"} links in total).
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
      </div>

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

      <Card title="Work shipped" note="Changes that went live in the last 90 days.">
        {shipped.length === 0 ? (
          <Empty>Nothing has gone live yet. Drafts appear under Approvals.</Empty>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {shipped.map((s) => {
              const verified = s.apply_mode === "api" && s.publish_result?.verified === true;
              const href = safeUrl(s.target_url);
              return (
                <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="font-medium text-gray-900">{fieldLabel(s.target_field)}</span>
                    {s.action_type === "content_publish" && s.proposed_value?.title ? <span className="text-gray-700">: {s.proposed_value.title}</span> : null}
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="block break-all text-xs text-blue-700 underline">{s.target_url}</a>
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
    </div>
  );
}
