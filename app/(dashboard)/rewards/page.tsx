import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { money, num, period, PERIODS } from "../loyalty/format";

// The store's loyalty results (Phase 1b module 10, 0213). Aggregates only:
// no member, email or order ever reaches this page (plan §1). Members and
// point changes are LumiLink staff's (/loyalty). Workspaces without a
// loyalty program get a 404, and the sidebar doesn't list the page for them.

type Results = {
  program: string;
  from: string;
  to: string;
  live_since: string | null;
  measuring: boolean;
  basis: "revenue_minus_rewards" | "gross_profit_minus_rewards";
  members: number;
  buyers: number;
  orders: number;
  revenue_cents: number;
  reward_cost_cents: number;
  redemptions: number;
  influenced_orders: number;
  influenced_revenue_cents: number;
  liability_cents: number | null;
  extra: { total_cents: number; low_cents: number; high_cents: number; significant: boolean; roi: number | null } | null;
};

const PERIOD_LABEL: Record<string, string> = { "30": "Last 30 days", "90": "Last 90 days", "365": "Last 12 months" };

function Card({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-gray-900">{value}</p>
      {note ? <p className="mt-1 text-xs text-gray-500">{note}</p> : null}
    </div>
  );
}

export default async function RewardsResultsPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const { range } = await searchParams;
  const p = period(range);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("loyalty_client_results", { p_from: p.from, p_to: p.to });
  if (!error && !data) notFound();
  const r = data as Results | null;
  const profit = r?.basis === "gross_profit_minus_rewards";

  return (
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">{r?.program ?? "Loyalty"} results</h1>
          <p className="mt-1 text-sm text-gray-500">What your loyalty program brought in. Run by LumiLink.</p>
        </div>
        <nav className="flex gap-1 text-sm" aria-label="Period">
          {Object.keys(PERIODS).map((k) => (
            <Link
              key={k}
              href={`/rewards?range=${k}`}
              className={`rounded-md px-3 py-1.5 ${k === p.key ? "bg-gray-900 text-white" : "border border-gray-300 text-gray-700 hover:bg-gray-100"}`}
            >
              {PERIOD_LABEL[k]}
            </Link>
          ))}
        </nav>
      </div>

      {error ? (
        <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">Results couldn&rsquo;t load. Try again in a minute.</div>
      ) : null}

      {r ? (
        <>
          <section className="mt-5 rounded-lg border border-gray-200 bg-white p-5">
            {r.measuring || !r.extra ? (
              <>
                <h2 className="text-sm font-semibold text-gray-900">Measuring</h2>
                <p className="mt-1 text-sm text-gray-600">
                  A small group of customers is set aside from the new loyalty features, so we can show what those features add
                  compared with them. The extra-revenue figure appears here once the features have been live for a full period.
                </p>
              </>
            ) : r.extra.significant ? (
              <>
                <p className="text-xs font-medium text-gray-500">
                  {profit ? "Extra profit after rewards" : "Extra revenue after rewards"}
                </p>
                <p className="mt-1 text-3xl font-semibold tabular-nums text-gray-900">{money(r.extra.total_cents)}</p>
                <p className="mt-1 text-sm text-gray-600">
                  {`Likely between ${money(r.extra.low_cents)} and ${money(r.extra.high_cents)}.`}
                  {r.extra.roi !== null ? ` That's ${r.extra.roi.toFixed(2)}x the rewards customers used.` : ""}
                </p>
                <p className="mt-2 text-xs text-gray-500">
                  Compared with a group of customers held back from the new loyalty features
                  {profit ? ", using your gross margin" : ", on revenue (no margin set)"}, after the cost of rewards.
                </p>
              </>
            ) : (
              <>
                <h2 className="text-sm font-semibold text-gray-900">Too early to tell</h2>
                <p className="mt-1 text-sm text-gray-600">
                  {`The best estimate so far is ${money(r.extra.total_cents)} ${profit ? "extra profit" : "extra revenue"} after rewards, but the likely range (${money(r.extra.low_cents)} to ${money(r.extra.high_cents)}) still includes zero. It narrows as more customers order; a longer period helps.`}
                </p>
                <p className="mt-2 text-xs text-gray-500">
                  Compared with a group of customers held back from the new loyalty features
                  {profit ? ", using your gross margin" : ", on revenue (no margin set)"}, after the cost of rewards.
                </p>
              </>
            )}
          </section>

          <section className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card label="Members" value={num(r.members)} note={`${num(r.buyers)} bought in this period`} />
            <Card label="Member revenue" value={money(r.revenue_cents)} note={`${num(r.orders)} orders, net of refunds`} />
            <Card label="Rewards used" value={num(r.redemptions)} note={`${money(r.reward_cost_cents)} in discounts, referrals included`} />
            <Card
              label="Points outstanding"
              value={r.liability_cents === null ? "—" : money(r.liability_cents)}
              note="What members' unspent points are worth"
            />
          </section>

          <p className="mt-4 text-sm text-gray-600">
            {num(r.influenced_orders)} orders ({money(r.influenced_revenue_cents)}) used a reward or referral code, came soon
            after a loyalty email, or moved a member up a tier.
          </p>
        </>
      ) : null}
    </div>
  );
}
