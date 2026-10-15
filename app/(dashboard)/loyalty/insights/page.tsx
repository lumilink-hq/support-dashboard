import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaffPage } from "../access";
import { money, num, pct, period, PERIODS } from "../format";
import { TrendChart, type TrendPoint } from "./trend-chart";

// LL Loyalty insights (Phase 1b module 10): did loyalty change what people
// buy? Treatment vs holdout from loyalty_staff_insights (0211) plus tiers and
// redemptions from loyalty_staff_insights_detail (0213). Staff + MFA only,
// like every /loyalty page. Aggregates only.

type Group = {
  members: number;
  buyers: number;
  orders: number;
  revenue_cents: number;
  reward_cost_cents: number;
  revenue_per_member_cents: number | null;
  value_per_member_cents: number | null;
  aov_cents: number | null;
  purchase_rate: number | null;
  repeat_rate: number | null;
  avg_days_between_orders: number | null;
  points_issued: number;
  points_redeemed: number;
};
type Influenced = { orders: number; revenue_cents: number; reward_code: number; referral_coupon: number; after_email: number; tier_up: number };
type Summary = {
  timezone: string;
  holdout_percent: number;
  gross_margin_pct: number | null;
  basis: "revenue_minus_rewards" | "gross_profit_minus_rewards";
  aa_check: boolean;
  groups: { treatment?: Group; holdout?: Group };
  lift: { per_member_cents: number; low_cents: number; high_cents: number; incremental_total_cents: number; significant: boolean } | null;
  influenced: { treatment?: Influenced; holdout?: Influenced };
  referral_coupon_cost_cents: number;
  liability: { points: number; cents: number | null };
};
type Series = {
  from: string;
  treatment_value_per_member_cents: number | null;
  holdout_value_per_member_cents: number | null;
  orders: number;
  revenue_cents: number;
  liability_points: number;
}[];
type Detail = {
  tiers: { key: string; name: string; members: number; buyers: number; revenue_cents: number; points_outstanding: number }[];
  redemptions: {
    codes_created: number;
    codes_used: number;
    referral_coupons_used: number;
    points_issued: number;
    points_redeemed: number;
    redemption_rate: number | null;
  };
};
type Program = { id: string; name: string; shop_domain: string };

const PERIOD_LABEL: Record<string, string> = { "30": "Last 30 days", "90": "Last 90 days", "365": "Last 12 months" };

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-gray-900">{value}</p>
      {note ? <p className="mt-1 text-xs text-gray-500">{note}</p> : null}
    </div>
  );
}

export default async function LoyaltyInsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ program?: string; range?: string }>;
}) {
  const { program: programParam, range } = await searchParams;
  const self = `/loyalty/insights${programParam ? `?program=${encodeURIComponent(programParam)}` : ""}`;
  await requireStaffPage(self);
  const supabase = await createClient();

  const { data: programData } = await supabase.rpc("loyalty_staff_programs");
  const programs = (programData ?? []) as Program[];
  const program = programs.find((p) => p.id === programParam) ?? (programs.length === 1 ? programs[0] : undefined);
  if (!program) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-lg font-semibold text-gray-900">Loyalty insights</h1>
        <ul className="mt-4 space-y-2 text-sm">
          {programs.map((p) => (
            <li key={p.id}>
              <Link href={`/loyalty/insights?program=${p.id}`} className="font-medium text-gray-900 hover:underline">
                {p.name}
              </Link>{" "}
              <span className="text-gray-500">{p.shop_domain}</span>
            </li>
          ))}
          {programs.length === 0 ? <li className="text-gray-500">No loyalty programs yet.</li> : null}
        </ul>
      </div>
    );
  }

  const p = period(range);
  const bucket = p.key === "365" ? "month" : "week";
  const [ins, det] = await Promise.all([
    supabase.rpc("loyalty_staff_insights", { p_program: program.id, p_from: p.from, p_to: p.to, p_bucket: bucket }),
    supabase.rpc("loyalty_staff_insights_detail", { p_program: program.id, p_from: p.from, p_to: p.to }),
  ]);
  const error = ins.error?.message ?? det.error?.message ?? null;
  const s = (ins.data as { summary: Summary; series: Series } | null)?.summary;
  const series = (ins.data as { summary: Summary; series: Series } | null)?.series ?? [];
  const d = det.data as Detail | null;
  const t = s?.groups.treatment;
  const h = s?.groups.holdout;
  const profit = s?.basis === "gross_profit_minus_rewards";
  const roi = s?.lift && t && t.reward_cost_cents > 0 ? s.lift.incremental_total_cents / t.reward_cost_cents : null;
  const points: TrendPoint[] = series.map((x) => ({
    from: x.from,
    treatment: x.treatment_value_per_member_cents,
    holdout: x.holdout_value_per_member_cents,
  }));

  const rows: [string, (g: Group) => string][] = [
    ["Members", (g) => num(g.members)],
    ["Buyers", (g) => num(g.buyers)],
    ["Orders", (g) => num(g.orders)],
    ["Revenue (net of refunds)", (g) => money(g.revenue_cents)],
    ["Revenue per member", (g) => money(g.revenue_per_member_cents)],
    [profit ? "Profit after rewards per member" : "Revenue after rewards per member", (g) => money(g.value_per_member_cents)],
    ["Average order", (g) => (g.aov_cents === null ? "—" : money(g.aov_cents))],
    ["Bought at least once", (g) => pct(g.purchase_rate)],
    ["Repeat buyers (of buyers)", (g) => pct(g.repeat_rate)],
    ["Days between orders", (g) => (g.avg_days_between_orders === null ? "—" : String(g.avg_days_between_orders))],
    ["Reward cost", (g) => money(g.reward_cost_cents)],
    ["Points issued", (g) => num(g.points_issued)],
    ["Points redeemed", (g) => num(g.points_redeemed)],
  ];

  return (
    <div className="max-w-5xl">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">{program.name} insights</h1>
          <p className="mt-1 text-sm text-gray-500">
            Treatment vs a {s?.holdout_percent ?? 10}% holdout. {profit ? `Gross margin ${s?.gross_margin_pct}%.` : "No gross margin set: measured on revenue minus rewards."}{" "}
            <Link href={`/loyalty?program=${program.id}`} className="text-gray-700 underline">
              Members
            </Link>
          </p>
        </div>
        <nav className="flex gap-1 text-sm" aria-label="Period">
          {Object.keys(PERIODS).map((k) => (
            <Link
              key={k}
              href={`/loyalty/insights?program=${program.id}&range=${k}`}
              className={`rounded-md px-3 py-1.5 ${k === p.key ? "bg-gray-900 text-white" : "border border-gray-300 text-gray-700 hover:bg-gray-100"}`}
            >
              {PERIOD_LABEL[k]}
            </Link>
          ))}
        </nav>
      </div>

      {error ? <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

      {s?.aa_check ? (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>A/A check.</strong>{" "}
          {"No Phase 1b feature was live for this whole period, so both groups got the same program. The difference below should be about zero; if its range clearly excludes zero, the split isn't fair yet."}
        </div>
      ) : null}

      {s ? (
        <>
          <section className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              label={s.aa_check ? "Difference (A/A, expect ~0)" : profit ? "Extra profit after rewards" : "Extra revenue after rewards"}
              value={s.lift ? money(s.lift.incremental_total_cents) : "—"}
              note={
                s.lift
                  ? `${money(s.lift.low_cents)} to ${money(s.lift.high_cents)} per member (95%)${s.lift.significant ? "" : ", not significant"}`
                  : "Needs 2+ members in each group"
              }
            />
            <Tile
              label="Net return per $1 of rewards"
              value={roi === null || s.aa_check ? "—" : `${roi.toFixed(2)}x`}
              note={
                t
                  ? `${money(t.reward_cost_cents)} of rewards used by treatment${s.lift && !s.lift.significant && !s.aa_check ? "; lift not significant yet" : ""}`
                  : undefined
              }
            />
            <Tile label="Members" value={num((t?.members ?? 0) + (h?.members ?? 0))} note={`${num(h?.members)} in the holdout`} />
            <Tile
              label="Points liability"
              value={s.liability.cents === null ? `${num(s.liability.points)} pts` : money(s.liability.cents)}
              note={`${num(s.liability.points)} points outstanding at period end`}
            />
          </section>

          <section className="mt-5 rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-900">
              {profit ? "Profit" : "Revenue"} after rewards per member, by {bucket}
            </h2>
            <div className="mt-3">
              <TrendChart points={points} bucket={bucket} />
            </div>
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-gray-600">Table</summary>
              <table className="mt-2 w-full text-left">
                <thead className="text-xs text-gray-500">
                  <tr>
                    <th className="py-1 font-medium">From</th>
                    <th className="py-1 text-right font-medium">Treatment</th>
                    <th className="py-1 text-right font-medium">Holdout</th>
                    <th className="py-1 text-right font-medium">Orders</th>
                    <th className="py-1 text-right font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 tabular-nums">
                  {series.map((x) => (
                    <tr key={x.from}>
                      <td className="py-1 text-gray-700">{x.from}</td>
                      <td className="py-1 text-right">{money(x.treatment_value_per_member_cents)}</td>
                      <td className="py-1 text-right">{money(x.holdout_value_per_member_cents)}</td>
                      <td className="py-1 text-right">{num(x.orders)}</td>
                      <td className="py-1 text-right">{money(x.revenue_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </section>

          <section className="mt-5 rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-900">Treatment vs holdout</h2>
            <table className="mt-3 w-full text-left text-sm">
              <thead className="text-xs text-gray-500">
                <tr>
                  <th className="py-2 font-medium" />
                  <th className="py-2 text-right font-medium">Treatment</th>
                  <th className="py-2 text-right font-medium">Holdout</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 tabular-nums">
                {rows.map(([label, f]) => (
                  <tr key={label}>
                    <td className="py-2 text-gray-700">{label}</td>
                    <td className="py-2 text-right text-gray-900">{t ? f(t) : "—"}</td>
                    <td className="py-2 text-right text-gray-900">{h ? f(h) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <section className="rounded-lg border border-gray-200 bg-white p-5">
              <h2 className="text-sm font-semibold text-gray-900">Tiers</h2>
              <p className="mt-0.5 text-xs text-gray-500">By current tier; revenue in the period.</p>
              <table className="mt-3 w-full text-left text-sm">
                <thead className="text-xs text-gray-500">
                  <tr>
                    <th className="py-2 font-medium">Tier</th>
                    <th className="py-2 text-right font-medium">Members</th>
                    <th className="py-2 text-right font-medium">Buyers</th>
                    <th className="py-2 text-right font-medium">Revenue</th>
                    <th className="py-2 text-right font-medium">Points</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 tabular-nums">
                  {(d?.tiers ?? []).map((x) => (
                    <tr key={x.key}>
                      <td className="py-2 text-gray-700">{x.name}</td>
                      <td className="py-2 text-right">{num(x.members)}</td>
                      <td className="py-2 text-right">{num(x.buyers)}</td>
                      <td className="py-2 text-right">{money(x.revenue_cents)}</td>
                      <td className="py-2 text-right">{num(x.points_outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="rounded-lg border border-gray-200 bg-white p-5">
              <h2 className="text-sm font-semibold text-gray-900">Redemptions</h2>
              {d ? (
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-gray-500">Reward codes created</dt>
                  <dd className="text-right tabular-nums">{num(d.redemptions.codes_created)}</dd>
                  <dt className="text-gray-500">Reward codes used</dt>
                  <dd className="text-right tabular-nums">{num(d.redemptions.codes_used)}</dd>
                  <dt className="text-gray-500">Referral coupons used</dt>
                  <dd className="text-right tabular-nums">{num(d.redemptions.referral_coupons_used)}</dd>
                  <dt className="text-gray-500">Points issued</dt>
                  <dd className="text-right tabular-nums">{num(d.redemptions.points_issued)}</dd>
                  <dt className="text-gray-500">Points redeemed</dt>
                  <dd className="text-right tabular-nums">{num(d.redemptions.points_redeemed)}</dd>
                  <dt className="text-gray-500">Redemption rate</dt>
                  <dd className="text-right tabular-nums">{pct(d.redemptions.redemption_rate)}</dd>
                </dl>
              ) : null}
            </section>
          </div>

          <section className="mt-5 rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-900">Orders loyalty touched</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Descriptive, not proof of cause: the holdout comparison above is the causal number. An order can count under several reasons.
            </p>
            <table className="mt-3 w-full text-left text-sm">
              <thead className="text-xs text-gray-500">
                <tr>
                  <th className="py-2 font-medium" />
                  <th className="py-2 text-right font-medium">Treatment</th>
                  <th className="py-2 text-right font-medium">Holdout</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 tabular-nums">
                {(
                  [
                    ["Orders", (g: Influenced) => num(g.orders)],
                    ["Revenue", (g: Influenced) => money(g.revenue_cents)],
                    ["Used a reward code", (g: Influenced) => num(g.reward_code)],
                    ["Used a referral coupon", (g: Influenced) => num(g.referral_coupon)],
                    ["Within the window after a loyalty email", (g: Influenced) => num(g.after_email)],
                    ["Moved the member up a tier", (g: Influenced) => num(g.tier_up)],
                  ] as [string, (g: Influenced) => string][]
                ).map(([label, f]) => (
                  <tr key={label}>
                    <td className="py-2 text-gray-700">{label}</td>
                    <td className="py-2 text-right">{s.influenced.treatment ? f(s.influenced.treatment) : "0"}</td>
                    <td className="py-2 text-right">{s.influenced.holdout ? f(s.influenced.holdout) : "0"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
    </div>
  );
}
