import Link from "next/link";
import { notFound } from "next/navigation";
import { HeatGrid, Legend, LineChart, SERIES_COLORS } from "@/components/seo/charts";
import { SeoLocked } from "@/components/seo/locked";
import { getSeoAccess } from "@/lib/seo-access";
import { createClient } from "@/lib/supabase/server";
import {
  METRIC_LABELS,
  movement,
  positionText,
  safeUrl,
  type LocationReport,
  type ReportContent,
} from "@/supabase/functions/seo-report/lib";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      <div className="mt-1 space-y-1 text-sm text-gray-800">{children}</div>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-gray-500">{children}</p>;
}

function LocationBlock({ loc }: { loc: LocationReport }) {
  const o = loc.rankings.organic;
  const l = loc.rankings.local_pack;
  const pm = loc.profile_metrics;
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <h2 className="text-base font-semibold text-gray-900">{loc.name}</h2>

      <Section title="Where you can win">
        <p>{loc.radius.statement}</p>
      </Section>

      <Section title="Search rankings">
        {o.checked === 0 && l.checked === 0 ? (
          <Muted>No ranking checks were recorded for this location this month.</Muted>
        ) : (
          <>
            <p>
              Website results: {o.ranked} of {o.checked} keywords found, {o.top3} in the top 3, {o.top10} in the top 10
              {o.avg_position !== null ? `, average position ${o.avg_position}` : ""}.
            </p>
            <p>
              Map pack: {l.ranked} of {l.checked} keywords found, {l.top3} in the top 3
              {l.avg_position !== null ? `, average position ${l.avg_position}` : ""}.
            </p>
          </>
        )}
        {loc.trend && (loc.trend.organic.length > 1 || loc.trend.local_pack.length > 1) ? (
          <div className="mt-3">
            <LineChart
              invert
              yLabel="Average position (lower is better)"
              label="Average position over the last 13 weeks"
              series={[
                { name: "Website results", color: SERIES_COLORS[0], points: loc.trend.organic },
                { name: "Map pack", color: SERIES_COLORS[1], points: loc.trend.local_pack },
              ].filter((x) => x.points.some((p) => p.y !== null))}
            />
            <Legend items={[{ label: "Website results", color: SERIES_COLORS[0] }, { label: "Map pack", color: SERIES_COLORS[1] }]} />
          </div>
        ) : null}
        {loc.grid && loc.grid.cells.length > 0 ? (
          <div className="mt-3">
            <p className="mb-2 text-xs text-gray-500">
              Map results for “{loc.grid.keyword}”, checked {loc.grid.check_date}. Your location is the outlined centre.
            </p>
            <HeatGrid cells={loc.grid.cells} label={`Map grid for ${loc.grid.keyword}`} />
          </div>
        ) : null}
        {loc.rankings.keywords.length > 0 ? (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-gray-500">
                <tr>
                  <th className="py-1 pr-3">Keyword</th>
                  <th className="pr-3">Website</th>
                  <th className="pr-3">Change</th>
                  <th className="pr-3">Map pack</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loc.rankings.keywords.map((k) => (
                  <tr key={k.keyword}>
                    <td className="py-1 pr-3 text-gray-900">{k.keyword}</td>
                    <td className="pr-3">{positionText(k.organic)}</td>
                    <td className="pr-3 text-gray-500">{k.organic.checked ? movement(k.organic.now, k.organic.before) : ""}</td>
                    <td className="pr-3">{positionText(k.local_pack)}</td>
                    <td className="text-gray-500">{k.local_pack.checked ? movement(k.local_pack.now, k.local_pack.before) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Section>

      <Section title="Google Business Profile">
        {pm.available ? (
          Object.entries(METRIC_LABELS)
            .filter(([k]) => k in pm.totals)
            .map(([k, label]) => (
              <p key={k}>
                {label}: {pm.totals[k]}
              </p>
            ))
        ) : (
          <Muted>{pm.reason}</Muted>
        )}
      </Section>

      {loc.backlinks ? (
        <Section title="Links to your site">
          <p>
            {loc.backlinks.referring_domains ?? "–"} sites link to you ({loc.backlinks.total ?? "–"} links in total). Last full
            month: {loc.backlinks.gained ?? "–"} gained, {loc.backlinks.lost ?? "–"} lost.
          </p>
        </Section>
      ) : null}

      <Section title="Work shipped this month">
        {loc.shipped.length === 0 ? <Muted>Nothing went live this month.</Muted> : null}
        {loc.shipped.map((s, i) => {
          const href = safeUrl(s.url);
          return (
            <p key={i}>
              {s.label}
              {s.detail ? `: ${s.detail}` : ""}{" "}
              <span className={`rounded-full px-2 py-0.5 text-xs ${s.verified ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
                {s.verified ? "Confirmed live" : "Applied by you, not yet confirmed"}
              </span>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer" className="block break-all text-xs text-blue-700 underline">
                  {s.url}
                </a>
              ) : null}
            </p>
          );
        })}
      </Section>

      <Section title="Queued for next month">
        {loc.queued.length === 0 ? <Muted>Nothing is waiting.</Muted> : null}
        {loc.queued.map((q, i) => (
          <p key={i}>
            {q.label}
            {q.detail ? `: ${q.detail}` : ""}{" "}
            <span className="text-xs text-gray-500">
              ({q.needs === "approval" ? "waiting for your approval" : "waiting for you to apply it"})
            </span>
          </p>
        ))}
      </Section>

      {loc.site_connection && loc.site_connection.status !== "healthy" ? (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Our access to your website wasn&apos;t healthy when this report was made, so approved changes were coming to you as
          instructions instead of publishing themselves.
        </p>
      ) : null}
    </section>
  );
}

export default async function SeoReportPage({ params }: PageProps<"/seo/reports/[id]">) {
  const access = await getSeoAccess();
  if (!access.allowed) return <SeoLocked state={access.state} />;

  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  const { data } = await supabase.from("seo_reports").select("id, content, pdf_path").eq("id", id).maybeSingle();
  if (!data) notFound();
  const content = data.content as ReportContent;
  const ai = content.ai_visibility;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">{content.period.label}</h1>
          <p className="text-sm text-gray-500">Monthly SEO report for {content.client_name}</p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link href="/seo/reports" className="text-blue-700 underline">All reports</Link>
          {data.pdf_path ? (
            <a href={`/seo/reports/${data.id}/pdf`} className="text-blue-700 underline">Download PDF</a>
          ) : null}
        </div>
      </div>

      {ai ? (
        <section className="rounded-lg border border-gray-200 bg-white p-5 text-sm text-gray-800">
          <h2 className="text-base font-semibold text-gray-900">Appearing in AI answers</h2>
          <p className="mt-1">
            {ai.checks === 0
              ? `You're tracking ${ai.queries} question${ai.queries === 1 ? "" : "s"}; the first check hasn't run yet.`
              : `Your site was cited in ${ai.cited} of ${ai.checks} checks this month across ${ai.queries} tracked question${ai.queries === 1 ? "" : "s"} (Google AI Overviews and ChatGPT).`}
          </p>
        </section>
      ) : null}

      {content.locations.map((loc) => (
        <LocationBlock key={loc.id} loc={loc} />
      ))}
    </div>
  );
}
