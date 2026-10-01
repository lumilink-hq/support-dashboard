// Stat tiles for module 21 (Search Console traffic), shared by /seo and the
// report page so the two show the same numbers the same way. Server components.
//
// A tile prints its number, what period it covers and what it is compared
// against as text; the colour of the change pill and the sparkline only repeat
// that, so nothing depends on seeing colour.

import { Sparkline } from "@/components/seo/charts";
import type { Compare, Delta, Tile, TileKind } from "@/supabase/functions/seo-search-console/insights";

const KIND_BORDER: Record<TileKind, string> = {
  traffic: "border-l-blue-600",
  keywords: "border-l-amber-500",
  value: "border-l-emerald-600",
};

const KIND_SPARK: Record<TileKind, string> = {
  traffic: "#2563eb",
  keywords: "#d97706",
  value: "#059669",
};

export function DeltaPill({ d, compare }: { d: Delta | null; compare: Compare }) {
  if (!d) {
    return <span className="text-xs text-gray-500">No {compare === "yoy" ? "year-earlier" : "month-earlier"} data to compare</span>;
  }
  const up = d.change > 0;
  const flat = Math.abs(d.change) < 0.05;
  const text = `${up ? "+" : ""}${d.change.toFixed(1)}${d.unit === "pp" ? " pts" : "%"}`;
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
      <span
        className={`rounded-full px-2 py-0.5 font-semibold ${
          flat ? "bg-gray-100 text-gray-700" : up ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}
      >
        <span aria-hidden>{flat ? "" : up ? "▲ " : "▼ "}</span>
        {text}
      </span>
      <span>
        vs {d.against} ({d.before})
      </span>
    </span>
  );
}

export function StatTile({ tile, compare, big = false }: { tile: Tile; compare: Compare; big?: boolean }) {
  return (
    <div className={`flex flex-col rounded-lg border border-l-4 border-gray-200 bg-white p-4 ${KIND_BORDER[tile.kind]}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        {tile.label} · {tile.period}
      </p>
      <p className={`mt-1 font-semibold tabular-nums text-gray-900 ${big ? "text-3xl" : "text-2xl"}`}>{tile.value}</p>
      {tile.noCompare ? null : (
        <div className="mt-1">
          <DeltaPill d={tile[compare]} compare={compare} />
        </div>
      )}
      {tile.spark.length >= 2 ? (
        <div className="mt-auto pt-2">
          <Sparkline values={tile.spark} color={KIND_SPARK[tile.kind]} />
        </div>
      ) : null}
      {tile.note ? <p className="mt-1 text-xs text-gray-500">{tile.note}</p> : null}
    </div>
  );
}

export function TileGrid({ tiles, compare }: { tiles: Tile[]; compare: Compare }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {tiles.map((t) => (
        <StatTile key={t.key} tile={t} compare={compare} />
      ))}
    </div>
  );
}

/** A small uppercase label above a section headline, like "RETURN ON INVESTMENT". */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-600">
      {children}
    </span>
  );
}

/** A "story" section: eyebrow, a headline that states the finding, a short paragraph, then the card. */
export function Story({
  eyebrow,
  headline,
  children,
  lead,
  source,
  id,
}: {
  eyebrow: string;
  headline: string;
  lead?: React.ReactNode;
  children?: React.ReactNode;
  source?: string;
  id?: string;
}) {
  return (
    <section id={id} className="space-y-2">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="text-lg font-semibold text-gray-900">{headline}</h2>
      {lead ? <p className="max-w-3xl text-sm text-gray-700">{lead}</p> : null}
      {children ? <div className="pt-1">{children}</div> : null}
      {source ? <p className="text-xs text-gray-500">{source}</p> : null}
    </section>
  );
}
