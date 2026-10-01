"use client";

// The CTR "upside" slider on /seo (module 21). A sensitivity model: the same
// impressions at a different click-through rate. Client-side only, nothing is
// stored, and it is never annualised or presented as a forecast.

import { useState } from "react";
import { ctrUpside, fmtInt, fmtMoney, fmtPct } from "@/supabase/functions/seo-search-console/insights";

export function CtrUpside({
  impressions,
  clicks,
  centsPerClick,
  periodLabel,
}: {
  impressions: number;
  clicks: number;
  centsPerClick: number;
  periodLabel: string;
}) {
  const current = impressions > 0 ? clicks / impressions : 0;
  // Start the slider a little above today's rate, rounded to half a point.
  const [target, setTarget] = useState(() => Math.min(0.3, Math.max(0.005, Math.ceil((current + 0.01) * 200) / 200)));
  const u = ctrUpside(impressions, clicks, target, centsPerClick);

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
      <div>
        <label htmlFor="ctr-target" className="text-sm font-medium text-gray-900">
          Target click-through rate: <span className="tabular-nums">{fmtPct(target, 1)}</span>
        </label>
        <input
          id="ctr-target"
          type="range"
          min={0.005}
          max={0.3}
          step={0.005}
          value={target}
          onChange={(e) => setTarget(Number(e.target.value))}
          className="mt-2 w-full accent-gray-900"
        />
        <p className="mt-1 text-xs text-gray-500">
          Today: {fmtPct(current)} ({fmtInt(clicks)} clicks from {fmtInt(impressions)} impressions, {periodLabel}).
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-gray-500">Clicks at that rate</dt>
          <dd className="text-lg font-semibold tabular-nums text-gray-900">{fmtInt(u.targetClicks)}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Extra clicks</dt>
          <dd className="text-lg font-semibold tabular-nums text-gray-900">+{fmtInt(u.extraClicks)}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Traffic value at that rate</dt>
          <dd className="text-lg font-semibold tabular-nums text-gray-900">{fmtMoney(u.cents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Extra value</dt>
          <dd className="text-lg font-semibold tabular-nums text-emerald-700">+{fmtMoney(u.extraCents)}</dd>
        </div>
      </dl>
    </div>
  );
}
