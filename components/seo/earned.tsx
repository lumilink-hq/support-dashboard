// What search EARNS a client (0069): non-brand clicks and clicks per store
// page. Shared by /seo and the report page so the two show the same numbers
// the same way. Server components; the counting is in insights.ts.

import { BarChart, Legend, SERIES_COLORS, Sparkline } from "@/components/seo/charts";
import { DeltaPill, Story } from "@/components/seo/search-tiles";
import { pagePath } from "@/lib/seo-portal";
import {
  brandHeadline,
  brandLead,
  brandSource,
  fmtInt,
  monthLabel,
  STORE_LEAD,
  STORE_SOURCE,
  storeHeadline,
  type BrandSplit,
  type Compare,
  type StoreTraffic,
} from "@/supabase/functions/seo-search-console/insights";

const BRAND_GREY = "#cbd5e1";

export function BrandStory({ brand, compare }: { brand: BrandSplit; compare: Compare }) {
  return (
    <Story eyebrow="Earned by search" headline={brandHeadline(brand, compare)} lead={brandLead(brand)} source={brandSource(brand)}>
      <div className="grid gap-4 rounded-lg border border-blue-200 bg-blue-50/40 p-4 md:grid-cols-[auto_1fr] md:items-center">
        <div>
          <p className="text-4xl font-semibold tabular-nums text-blue-900">{fmtInt(brand.latest.nonBrand)}</p>
          <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-blue-900/80">Non-brand clicks · {monthLabel(brand.latest.month, true)}</p>
          <div className="mt-2">
            <DeltaPill d={brand[compare]} compare={compare} />
          </div>
          <p className="mt-2 text-sm text-gray-700">
            {brand.year.months > 1 ? `${monthLabel(brand.year.first)}–${monthLabel(brand.year.last)}` : monthLabel(brand.year.last, true)}:{" "}
            <strong>{fmtInt(brand.year.nonBrand)}</strong> of {fmtInt(brand.year.total)} clicks
          </p>
        </div>
        <div>
          <BarChart
            label="Non-brand and brand clicks per month"
            series={[
              { name: "Non-brand", color: SERIES_COLORS[1] },
              { name: "Brand", color: BRAND_GREY },
            ]}
            format={(n) => fmtInt(n)}
            categories={brand.months.map((m) => ({ label: monthLabel(m.month), values: [m.nonBrand, m.brand] }))}
          />
          <Legend items={[{ label: "Non-brand", color: SERIES_COLORS[1] }, { label: "Brand", color: BRAND_GREY }]} />
        </div>
      </div>
    </Story>
  );
}

export function StoreStory({ stores, compare }: { stores: StoreTraffic; compare: Compare }) {
  return (
    <Story eyebrow="Store pages" headline={storeHeadline(stores)} lead={STORE_LEAD} source={STORE_SOURCE}>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[560px] text-sm">
          <caption className="sr-only">Clicks from Google search per store page, {monthLabel(stores.month, true)}</caption>
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
              <th scope="col" className="px-4 py-2 font-semibold">Store</th>
              <th scope="col" className="px-4 py-2 text-right font-semibold">{monthLabel(stores.month)}</th>
              <th scope="col" className="px-4 py-2 font-semibold">Change</th>
              <th scope="col" className="px-4 py-2 text-right font-semibold">Last 12 months</th>
              <th scope="col" className="px-4 py-2 font-semibold"><span className="sr-only">Trend</span></th>
            </tr>
          </thead>
          <tbody>
            {stores.rows.map((r) => (
              <tr key={r.id} className="border-b border-gray-100 last:border-0">
                <td className="px-4 py-2">
                  <p className="font-medium text-gray-900">{r.name}</p>
                  <p className="text-xs text-gray-500">{pagePath(`https://${r.page}`)}</p>
                </td>
                <td className="px-4 py-2 text-right font-semibold tabular-nums text-gray-900">{fmtInt(r.latest)}</td>
                <td className="px-4 py-2"><DeltaPill d={r[compare]} compare={compare} /></td>
                <td className="px-4 py-2 text-right tabular-nums text-gray-700">{fmtInt(r.year)}</td>
                <td className="w-28 px-4 py-2">{r.series.length >= 2 ? <Sparkline values={r.series} color={SERIES_COLORS[1]} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Story>
  );
}
