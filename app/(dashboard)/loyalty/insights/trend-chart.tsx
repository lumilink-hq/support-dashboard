"use client";

import { useState } from "react";

// Treatment vs holdout value per member, one point per week or month
// (loyalty_staff_insights series, 0211). Two series on one axis: categorical
// slots 1 and 2 of the reference palette (blue, orange), validated as a pair.
// Legend + direct end labels so identity is never color alone; a table of the
// same numbers sits under the chart on the page.

export type TrendPoint = { from: string; treatment: number | null; holdout: number | null };

const W = 720;
const H = 240;
const PAD = { top: 16, right: 92, bottom: 28, left: 56 };
const COLORS = { treatment: "#2a78d6", holdout: "#eb6834" } as const;
const LABELS = { treatment: "Treatment", holdout: "Holdout" } as const;

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function niceMax(v: number): number {
  if (v <= 0) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export function TrendChart({ points, bucket }: { points: TrendPoint[]; bucket: "week" | "month" }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return <p className="text-sm text-gray-500">No data in this period.</p>;

  const values = points.flatMap((p) => [p.treatment, p.holdout]).filter((v): v is number => v !== null);
  const lo = Math.min(0, ...values);
  const hi = niceMax(Math.max(0, ...values));
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length === 1 ? iw / 2 : (i * iw) / (points.length - 1));
  const y = (v: number) => PAD.top + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const ticks = [lo, lo + (hi - lo) / 2, hi];

  const path = (key: "treatment" | "holdout") =>
    points
      .map((p, i) => (p[key] === null ? null : `${x(i)},${y(p[key] as number)}`))
      .filter(Boolean)
      .map((pt, i) => `${i === 0 ? "M" : "L"}${pt}`)
      .join(" ");

  const last = points.length - 1;
  const step = Math.max(1, Math.ceil(points.length / 6));
  const h = hover === null ? null : points[hover];

  return (
    <div className="relative">
      <div className="mb-2 flex gap-4 text-xs text-gray-600">
        {(["treatment", "holdout"] as const).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded" style={{ background: COLORS[k] }} aria-hidden />
            {LABELS[k]}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Value per member over time, treatment and holdout"
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#e5e7eb" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" className="fill-gray-500" fontSize={11}>
              {dollars(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i % step === 0 || i === last ? (
            <text key={p.from} x={x(i)} y={H - 8} textAnchor="middle" className="fill-gray-500" fontSize={11}>
              {short(p.from)}
            </text>
          ) : null,
        )}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} stroke="#9ca3af" strokeWidth={1} /> : null}
        {(["treatment", "holdout"] as const).map((k) => (
          <g key={k}>
            <path d={path(k)} fill="none" stroke={COLORS[k]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {points[last][k] !== null ? (
              <text x={x(last) + 8} y={y(points[last][k] as number)} dominantBaseline="middle" className="fill-gray-700" fontSize={11}>
                {LABELS[k]}
              </text>
            ) : null}
            {hover !== null && points[hover][k] !== null ? (
              <circle cx={x(hover)} cy={y(points[hover][k] as number)} r={4} fill={COLORS[k]} stroke="#fff" strokeWidth={2} />
            ) : null}
          </g>
        ))}
        {/* Hit targets: one column per point, wider than the marks. */}
        {points.map((p, i) => (
          <rect
            key={p.from}
            x={x(i) - iw / Math.max(points.length - 1, 1) / 2}
            y={PAD.top}
            width={iw / Math.max(points.length - 1, 1)}
            height={ih}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {h ? (
        <div className="pointer-events-none absolute right-2 top-0 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs shadow-sm">
          <p className="font-medium text-gray-900">{bucket === "week" ? "Week of" : "Month from"} {short(h.from)}</p>
          <p className="text-gray-700">Treatment: {h.treatment === null ? "—" : dollars(h.treatment)}</p>
          <p className="text-gray-700">Holdout: {h.holdout === null ? "—" : dollars(h.holdout)}</p>
        </div>
      ) : null}
    </div>
  );
}
