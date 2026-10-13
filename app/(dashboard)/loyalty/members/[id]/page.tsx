import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { adjustPoints, setBirthday, setTier } from "../../actions";
import { day, money, num, REASON_LABEL, when } from "../../format";

// LL Loyalty staff admin: one member (0206). Opening this page is logged
// (loyalty_staff_member writes the access log); so is every change.

const inputCls =
  "mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900";
const btnCls = "rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Detail = {
  member: {
    id: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    shopify_customer_id: number;
    status: string;
    points_balance: number;
    tier_spend_cents: number;
    paid_order_count: number;
    referral_code: string;
    birthday: string | null;
    enrolled_at: string;
    last_order_at: string | null;
    last_activity_at: string | null;
    tier_changed_at: string | null;
  };
  program: { id: string; name: string; shop_domain: string; timezone: string };
  tier: { key: string; name: string; multiplier: number };
  tiers: { key: string; name: string; min_spend_cents: number }[];
  referred_by: { id: string; email: string | null } | null;
  ledger: { id: number; points: number; spend_cents: number; reason: string; rule_key: string | null; balance_after: number; note: string | null; actor: string; occurred_at: string; source_id: string | null }[];
  tier_changes: { id: number; from_tier: string | null; to_tier: string; direction: string; reason: string; actor: string; created_at: string }[];
  orders: { order_id: number; name: string | null; eligible_cents: number; refunded_cents: number; points_earned: number; points_clawed: number; source: string; processed_at: string }[];
  codes: { code: string; reward_key: string; value_cents: number; points_spent: number; status: string; last_error: string | null; created_at: string; used_order_id: number | null }[];
  referrals: { friend_email: string; status: string; reject_reason: string | null; created_at: string; completed_at: string | null }[];
};

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-gray-900">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      {children}
    </section>
  );
}

export default async function LoyaltyMemberPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const { saved, error } = await searchParams;
  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  const { data: isStaff } = await supabase.rpc("current_user_is_staff");
  if (isStaff !== true) notFound();

  const { data, error: loadError } = await supabase.rpc("loyalty_staff_member", { p_member: id });
  if (loadError) {
    return <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{loadError.message}</div>;
  }
  if (!data) notFound();
  const d = data as Detail;
  const m = d.member;
  const tz = d.program.timezone;
  const name = [m.first_name, m.last_name].filter(Boolean).join(" ") || "(no name)";

  return (
    <div className="max-w-4xl">
      <Link href={`/loyalty?program=${d.program.id}`} className="text-xs text-gray-500 hover:underline">
        ← {d.program.name}
      </Link>
      <h1 className="mt-1 text-lg font-semibold text-gray-900">{name}</h1>
      <p className="mt-0.5 text-sm text-gray-500">
        {m.email ?? "no email"} · Shopify customer {m.shopify_customer_id} · {m.status}
      </p>

      {saved ? <div className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{saved}</div> : null}
      {error ? <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Points" value={num(m.points_balance)} />
        <Stat label="Tier" value={`${d.tier.name} (${d.tier.multiplier}x)`} />
        <Stat label="Tier spend" value={money(m.tier_spend_cents)} />
        <Stat label="Paid orders" value={num(m.paid_order_count)} />
        <Stat label="Birthday" value={day(m.birthday)} />
        <Stat label="Referral code" value={m.referral_code} />
        <Stat label="Member since" value={when(m.enrolled_at, tz)} />
        <Stat label="Last order" value={when(m.last_order_at, tz)} />
      </div>
      <p className="mt-2 text-xs text-gray-400">
        Last activity {when(m.last_activity_at, tz)} · tier changed {when(m.tier_changed_at, tz)}
        {d.referred_by ? ` · referred by ${d.referred_by.email ?? d.referred_by.id}` : ""}
      </p>

      <div className="mt-2 grid gap-0 lg:grid-cols-3 lg:gap-4">
        <Section title="Adjust points">
          <form action={adjustPoints} className="mt-3 space-y-3">
            <input type="hidden" name="member_id" value={m.id} />
            <input type="hidden" name="request_key" value={randomUUID()} />
            <label className="block text-sm text-gray-700">
              Points <span className="text-gray-400">(+ adds, - takes away)</span>
              <input name="points" type="number" step={1} required className={inputCls} />
            </label>
            <label className="block text-sm text-gray-700">
              Why
              <input name="note" required minLength={3} placeholder="e.g. Goodwill for late delivery" className={inputCls} />
            </label>
            <ConfirmSubmit message="Adjust this member's points?" className={btnCls}>
              Save
            </ConfirmSubmit>
          </form>
        </Section>

        <Section title="Change tier">
          <form action={setTier} className="mt-3 space-y-3">
            <input type="hidden" name="member_id" value={m.id} />
            <label className="block text-sm text-gray-700">
              Tier
              <select name="tier" defaultValue={d.tier.key} className={inputCls}>
                {d.tiers.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name} ({money(t.min_spend_cents)}+)
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-gray-700">
              Why
              <input name="note" required minLength={3} className={inputCls} />
            </label>
            <p className="text-xs text-gray-400">A later order moves them to their spend tier if it&rsquo;s higher.</p>
            <ConfirmSubmit message="Change this member's tier?" className={btnCls}>
              Save
            </ConfirmSubmit>
          </form>
        </Section>

        <Section title="Birthday">
          <form action={setBirthday} className="mt-3 space-y-3">
            <input type="hidden" name="member_id" value={m.id} />
            <label className="block text-sm text-gray-700">
              Date
              <input name="birthday" type="date" defaultValue={m.birthday ?? ""} className={inputCls} />
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input name="clear" type="checkbox" /> Clear (they can set it again)
            </label>
            <label className="block text-sm text-gray-700">
              Why
              <input name="note" required minLength={3} className={inputCls} />
            </label>
            <button type="submit" className={btnCls}>
              Save
            </button>
          </form>
        </Section>
      </div>

      <Section title="Points history">
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th className="py-2 pr-3 font-medium">When</th>
                <th className="py-2 pr-3 font-medium">What</th>
                <th className="py-2 pr-3 text-right font-medium">Points</th>
                <th className="py-2 pr-3 text-right font-medium">Balance</th>
                <th className="py-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {d.ledger.map((l) => (
                <tr key={l.id}>
                  <td className="whitespace-nowrap py-2 pr-3 text-gray-500">{when(l.occurred_at, tz)}</td>
                  <td className="py-2 pr-3 text-gray-700">
                    {REASON_LABEL[l.reason] ?? l.reason}
                    {l.rule_key ? <span className="text-gray-400"> · {l.rule_key}</span> : null}
                    {l.spend_cents ? <span className="text-gray-400"> · spend {money(l.spend_cents)}</span> : null}
                  </td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${l.points > 0 ? "text-green-700" : l.points < 0 ? "text-red-700" : "text-gray-400"}`}>
                    {l.points > 0 ? "+" : ""}
                    {num(l.points)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-gray-900">{num(l.balance_after)}</td>
                  <td className="py-2 text-xs text-gray-500">
                    {l.note ?? ""}
                    {l.actor !== "system" ? <span className="text-gray-400"> ({l.actor})</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.ledger.length === 100 ? <p className="mt-2 text-xs text-gray-400">Latest 100 entries.</p> : null}
        </div>
      </Section>

      <Section title="Orders">
        {d.orders.length ? (
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th className="py-2 pr-3 font-medium">Order</th>
                <th className="py-2 pr-3 font-medium">When</th>
                <th className="py-2 pr-3 text-right font-medium">Eligible</th>
                <th className="py-2 text-right font-medium">Points</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {d.orders.map((o) => (
                <tr key={o.order_id}>
                  <td className="py-2 pr-3 text-gray-700">
                    {o.name ?? o.order_id}
                    {o.source === "backfill" ? <span className="text-xs text-gray-400"> · backfill</span> : null}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-gray-500">{when(o.processed_at, tz)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-gray-700">
                    {money(o.eligible_cents)}
                    {o.refunded_cents ? <span className="text-xs text-red-700"> (−{money(o.refunded_cents)})</span> : null}
                  </td>
                  <td className="py-2 text-right tabular-nums text-gray-900">
                    {num(o.points_earned - o.points_clawed)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No orders recorded.</p>
        )}
      </Section>

      <div className="grid gap-0 lg:grid-cols-2 lg:gap-4">
        <Section title="Reward codes">
          {d.codes.length ? (
            <ul className="mt-3 divide-y divide-gray-100 text-sm">
              {d.codes.map((c) => (
                <li key={c.code} className="py-2">
                  <span className="font-mono text-gray-900">{c.code}</span>{" "}
                  <span className="text-gray-500">
                    {money(c.value_cents)} · {c.status}
                    {c.used_order_id ? ` on order ${c.used_order_id}` : ""} · {when(c.created_at, tz)}
                  </span>
                  {c.last_error && c.status !== "issued" && c.status !== "used" ? (
                    <div className="text-xs text-red-700">{c.last_error}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-gray-500">None.</p>
          )}
        </Section>

        <Section title="Referrals made">
          {d.referrals.length ? (
            <ul className="mt-3 divide-y divide-gray-100 text-sm">
              {d.referrals.map((r, i) => (
                <li key={i} className="py-2 text-gray-700">
                  {r.friend_email} · {r.status}
                  {r.reject_reason ? ` (${r.reject_reason})` : ""}
                  <span className="text-xs text-gray-400"> · {when(r.created_at, tz)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-gray-500">None.</p>
          )}
        </Section>
      </div>

      <Section title="Tier history">
        <ul className="mt-3 divide-y divide-gray-100 text-sm">
          {d.tier_changes.map((c) => (
            <li key={c.id} className="py-2 text-gray-700">
              {c.from_tier ? `${c.from_tier} → ${c.to_tier}` : `Joined at ${c.to_tier}`} · {c.reason}
              {c.actor !== "system" ? ` by ${c.actor}` : ""}
              <span className="text-xs text-gray-400"> · {when(c.created_at, tz)}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
