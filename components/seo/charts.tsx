// Hand-rolled SVG charts for the SEO portal (module 10). Server components, no
// dependency: the same numbers also feed the PDF report as text, and a chart
// library would add a client bundle for five simple shapes.
//
// Every chart is role="img" with an aria-label, and callers print the headline
// number as text next to it, so nothing depends on colour or on seeing the SVG.
// Colours come with a shape or a label (direct labels, markers) for the same reason.

import type { ReactNode } from "react";

export const SERIES_COLORS = ["#111827", "#2563eb", "#d97706", "#059669", "#db2777"];

const AXIS = "#9ca3af";
const GRID = "#e5e7eb";
const TEXT = "#6b7280";

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

// -----------------------------------------------------------------------------
// 1. Line chart: values over time. `invert` puts a low number at the top, for
//    rank positions where 1 is best.
// -----------------------------------------------------------------------------
export type LineSeries = { name: string; color: string; points: { x: string; y: number | null }[] };

export function LineChart({
  series,
  invert = false,
  label,
  yLabel,
}: {
  series: LineSeries[];
  invert?: boolean;
  label: string;
  yLabel?: string;
}) {
  const W = 640, H = 220, L = 40, R = 16, T = 12, B = 28;
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort();
  const ys = series.flatMap((s) => s.points.map((p) => p.y)).filter((y): y is number => y !== null);
  if (xs.length === 0 || ys.length === 0) return null;

  const lo = Math.min(...ys, invert ? 1 : 0);
  const hi = Math.max(...ys, lo + 1);
  const px = (x: string) => L + (xs.length === 1 ? (W - L - R) / 2 : (xs.indexOf(x) / (xs.length - 1)) * (W - L - R));
  const py = (y: number) => {
    const t = (y - lo) / (hi - lo);
    return T + (invert ? t : 1 - t) * (H - T - B);
  };
  const ticks = [lo, lo + (hi - lo) / 2, hi].map((t) => Math.round(t * 10) / 10);
  const labelAt = xs.length <= 6 ? xs : [xs[0], xs[Math.floor(xs.length / 2)], xs[xs.length - 1]];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="w-full">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={py(t)} y2={py(t)} stroke={GRID} />
          <text x={L - 6} y={py(t) + 4} textAnchor="end" fontSize="11" fill={TEXT}>{t}</text>
        </g>
      ))}
      {yLabel ? <text x={L} y={T - 2} fontSize="10" fill={TEXT}>{yLabel}</text> : null}
      <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke={AXIS} />
      {labelAt.map((x) => (
        <text key={x} x={px(x)} y={H - 8} textAnchor="middle" fontSize="11" fill={TEXT}>{shortDate(x)}</text>
      ))}
      {series.map((s, si) => {
        const pts = s.points.filter((p): p is { x: string; y: number } => p.y !== null);
        return (
          <g key={s.name}>
            <polyline
              fill="none"
              stroke={s.color}
              strokeWidth="2"
              strokeDasharray={si === 0 ? undefined : "5 3"}
              points={pts.map((p) => `${px(p.x)},${py(p.y)}`).join(" ")}
            />
            {pts.map((p) => (
              <circle key={p.x} cx={px(p.x)} cy={py(p.y)} r="3" fill={s.color}>
                <title>{`${s.name}, ${shortDate(p.x)}: ${p.y}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

// -----------------------------------------------------------------------------
// 2. Grouped bar chart: a few numbers per category.
// -----------------------------------------------------------------------------
export function BarChart({
  categories,
  series,
  label,
  format = (n) => String(Math.round(n)),
}: {
  categories: { label: string; values: number[] }[];
  series: { name: string; color: string }[];
  label: string;
  format?: (n: number) => string;
}) {
  const W = 640, H = 200, L = 52, R = 8, T = 10, B = 28;
  const max = Math.max(1, ...categories.flatMap((c) => c.values));
  if (categories.length === 0) return null;
  const band = (W - L - R) / categories.length;
  const bar = Math.min(28, (band * 0.8) / series.length);
  const py = (v: number) => T + (1 - v / max) * (H - T - B);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="w-full">
      {[0, max / 2, max].map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={py(t)} y2={py(t)} stroke={GRID} />
          <text x={L - 6} y={py(t) + 4} textAnchor="end" fontSize="11" fill={TEXT}>{format(t)}</text>
        </g>
      ))}
      {categories.map((c, ci) => {
        const x0 = L + ci * band + (band - bar * series.length) / 2;
        return (
          <g key={c.label}>
            {c.values.map((v, vi) => (
              <rect key={vi} x={x0 + vi * bar} y={py(v)} width={bar - 2} height={H - B - py(v)} fill={series[vi].color} rx="2">
                <title>{`${series[vi].name}, ${c.label}: ${format(v)}`}</title>
              </rect>
            ))}
            <text x={L + ci * band + band / 2} y={H - 8} textAnchor="middle" fontSize="11" fill={TEXT}>{c.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// -----------------------------------------------------------------------------
// 3. Horizontal bars: one row per domain, for the client-vs-competitor view.
// -----------------------------------------------------------------------------
export function HBars({
  rows,
  max,
  label,
}: {
  rows: { label: string; value: number; color: string; note?: string; highlight?: boolean }[];
  max: number;
  label: string;
}) {
  return (
    <ul role="img" aria-label={label} className="space-y-2">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex items-baseline justify-between text-sm">
            <span className={r.highlight ? "font-semibold text-gray-900" : "text-gray-700"}>{r.label}</span>
            <span className="text-xs text-gray-500">{r.note ?? r.value}</span>
          </div>
          <div className="mt-0.5 h-2.5 rounded-full bg-gray-100">
            <div
              className="h-2.5 rounded-full"
              style={{ width: `${Math.max(2, Math.min(100, (r.value / Math.max(max, 1)) * 100))}%`, background: r.color }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

// -----------------------------------------------------------------------------
// 4. Heat grid: the 5x5 local-pack map. Each cell prints its position, so the
//    colour is a reinforcement, not the only signal.
// -----------------------------------------------------------------------------
function cellStyle(p: number | null): { bg: string; fg: string } {
  if (p === null) return { bg: "#f3f4f6", fg: "#6b7280" };
  if (p <= 3) return { bg: "#bbf7d0", fg: "#14532d" };
  if (p <= 10) return { bg: "#fde68a", fg: "#78350f" };
  return { bg: "#fed7aa", fg: "#7c2d12" };
}

export function HeatGrid({ cells, label }: { cells: { row: number; col: number; position: number | null }[]; label: string }) {
  const at = (r: number, c: number) => cells.find((x) => x.row === r && x.col === c);
  return (
    <div>
      <div role="img" aria-label={label} className="grid w-fit grid-cols-5 gap-1">
        {[1, 2, 3, 4, 5].flatMap((r) =>
          [1, 2, 3, 4, 5].map((c) => {
            const cell = at(r, c);
            const st = cellStyle(cell?.position ?? null);
            const centre = r === 3 && c === 3;
            return (
              <div
                key={`${r}-${c}`}
                title={centre ? "Your location" : `Row ${r}, column ${c}`}
                className={`flex h-10 w-12 items-center justify-center rounded text-xs font-medium ${centre ? "ring-2 ring-gray-900" : ""}`}
                style={{ background: cell ? st.bg : "#fff", color: st.fg, border: cell ? undefined : "1px dashed #d1d5db" }}
              >
                {cell ? (cell.position === null ? "–" : cell.position) : ""}
              </div>
            );
          }),
        )}
      </div>
      <Legend
        items={[
          { label: "Top 3", color: "#bbf7d0" },
          { label: "4 to 10", color: "#fde68a" },
          { label: "11 or lower", color: "#fed7aa" },
          { label: "Not found", color: "#f3f4f6" },
        ]}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// 6. Sparkline: the shape of a tile's last 12 months. Decorative next to the
//    number it sits under, so it is hidden from screen readers.
// -----------------------------------------------------------------------------
export function Sparkline({ values, color = SERIES_COLORS[1] }: { values: number[]; color?: string }) {
  if (values.length < 2) return null;
  const W = 120, H = 28;
  const lo = Math.min(...values);
  const hi = Math.max(...values, lo + 1e-9);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 2 - ((v - lo) / (hi - lo)) * (H - 4)}`);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} aria-hidden className="h-7 w-full" preserveAspectRatio="none">
      <polyline fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" points={pts.join(" ")} />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// 7. Monthly trend: one value per month as a line, with labelled vertical
//    markers for events ("LumiLink starts"). A month still in progress is drawn
//    hollow on a dashed segment and labelled "so far", never extrapolated.
// -----------------------------------------------------------------------------
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthTick(month: string): string {
  return `${MONTHS_SHORT[Number(month.slice(5, 7)) - 1]} '${month.slice(2, 4)}`;
}

export function MonthTrend({
  points,
  markers = [],
  label,
  format = (n) => Math.round(n).toLocaleString("en-US"),
  color = SERIES_COLORS[1],
}: {
  points: { month: string; value: number; partial?: boolean }[];
  markers?: { month: string; label: string }[];
  label: string;
  format?: (n: number) => string;
  color?: string;
}) {
  if (points.length < 2) return null;
  const W = 640, H = 230, L = 52, R = 16, T = 34, B = 28;
  const max = Math.max(...points.map((p) => p.value), 1);
  const px = (i: number) => L + (i / (points.length - 1)) * (W - L - R);
  const py = (v: number) => T + (1 - v / max) * (H - T - B);
  const step = Math.max(1, Math.ceil(points.length / 8));
  const done = points.filter((p) => !p.partial);
  const last = points[points.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="w-full">
      {[0, max / 2, max].map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={py(t)} y2={py(t)} stroke={GRID} />
          <text x={L - 6} y={py(t) + 4} textAnchor="end" fontSize="11" fill={TEXT}>{format(t)}</text>
        </g>
      ))}
      <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke={AXIS} />
      {points.map((p, i) =>
        i % step === 0 || i === points.length - 1 ? (
          <text key={p.month} x={px(i)} y={H - 8} textAnchor={i === points.length - 1 ? "end" : "middle"} fontSize="11" fill={TEXT}>{monthTick(p.month)}</text>
        ) : null,
      )}
      {markers.map((m, mi) => {
        const i = points.findIndex((p) => p.month === m.month);
        if (i < 0) return null;
        const x = px(i);
        // Alternate the label rows so neighbouring markers don't overprint.
        const y = mi % 2 === 0 ? 11 : 24;
        const anchor = i > points.length * 0.7 ? "end" : "start";
        return (
          <g key={`${m.month}-${m.label}`}>
            <line x1={x} x2={x} y1={y + 3} y2={H - B} stroke="#6b7280" strokeDasharray="3 3" />
            <text x={anchor === "start" ? x + 4 : x - 4} y={y} textAnchor={anchor} fontSize="10" fill="#374151">{m.label}</text>
          </g>
        );
      })}
      <polyline fill="none" stroke={color} strokeWidth="2" points={done.map((p) => `${px(points.indexOf(p))},${py(p.value)}`).join(" ")} />
      {last.partial && done.length > 0 ? (
        <line
          x1={px(points.indexOf(done[done.length - 1]))} y1={py(done[done.length - 1].value)}
          x2={px(points.length - 1)} y2={py(last.value)}
          stroke={color} strokeWidth="2" strokeDasharray="5 4"
        />
      ) : null}
      {points.map((p, i) => (
        <circle key={p.month} cx={px(i)} cy={py(p.value)} r="3.5" fill={p.partial ? "#fff" : color} stroke={color} strokeWidth="1.5">
          <title>{`${monthTick(p.month)}${p.partial ? " (so far)" : ""}: ${format(p.value)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

// -----------------------------------------------------------------------------
// 5. Donut: a share of a whole, with the number in the middle.
// -----------------------------------------------------------------------------
export function Donut({ value, total, label, centre }: { value: number; total: number; label: string; centre?: ReactNode }) {
  const R = 42, C = 2 * Math.PI * R;
  const share = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <svg viewBox="0 0 100 100" role="img" aria-label={label} className="h-28 w-28">
      <circle cx="50" cy="50" r={R} fill="none" stroke={GRID} strokeWidth="12" />
      <circle
        cx="50" cy="50" r={R} fill="none" stroke="#059669" strokeWidth="12"
        strokeDasharray={`${share * C} ${C}`} transform="rotate(-90 50 50)"
      />
      <text x="50" y="55" textAnchor="middle" fontSize="18" fontWeight="600" fill="#111827">
        {centre ?? `${Math.round(share * 100)}%`}
      </text>
    </svg>
  );
}
