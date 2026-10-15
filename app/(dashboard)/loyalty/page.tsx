import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaffPage } from "./access";
import { num, when } from "./format";

// LL Loyalty staff admin: programs and member lookup (0206). LumiLink staff
// only (platform_staff) with MFA (0210), checked here for the 404 / MFA step
// and again inside every RPC.
// Not in the sidebar: tenants never see it exists.

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900";

type Program = {
  id: string;
  name: string;
  shop_domain: string;
  client: string;
  is_active: boolean;
  live_since: string | null;
  klaviyo_enabled_at: string | null;
  members: number;
  points_outstanding: number;
};

type Hit = {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  shopify_customer_id: number;
  tier: string;
  points: number;
  status: string;
};

type DataRequest = { shop_domain: string; outcome: string | null; received_at: string };

export default async function LoyaltyAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ program?: string; q?: string }>;
}) {
  const { program: programParam, q } = await searchParams;
  await requireStaffPage(`/loyalty${programParam ? `?program=${encodeURIComponent(programParam)}` : ""}`);
  const supabase = await createClient();
  const { data: programData, error } = await supabase.rpc("loyalty_staff_programs");
  const programs = (programData ?? []) as Program[];
  const program = programs.find((p) => p.id === programParam) ?? (programs.length === 1 ? programs[0] : undefined);

  let hits: Hit[] = [];
  let searchError: string | null = null;
  if (program && q && q.trim().length >= 2) {
    const res = await supabase.rpc("loyalty_staff_search", { p_program: program.id, p_query: q });
    hits = (res.data ?? []) as Hit[];
    searchError = res.error?.message ?? null;
  }
  const { data: requestData } = await supabase.rpc("loyalty_staff_data_requests");
  const requests = (requestData ?? []) as DataRequest[];

  return (
    <div className="max-w-4xl">
      <h1 className="text-lg font-semibold text-gray-900">Loyalty</h1>
      <p className="mt-1 text-sm text-gray-500">
        LumiLink staff only. Every search and member view is recorded in the access log.
      </p>

      {error || searchError ? (
        <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error?.message ?? searchError}</div>
      ) : null}

      <section className="mt-6 grid gap-3 sm:grid-cols-2">
        {programs.map((p) => (
          <Link
            key={p.id}
            href={`/loyalty?program=${p.id}`}
            className={`rounded-lg border bg-white p-4 hover:border-gray-400 ${p.id === program?.id ? "border-gray-900" : "border-gray-200"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-gray-900">{p.name}</span>
              <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${p.is_active ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                {p.is_active ? "Active" : "Paused"}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-gray-500">
              {p.client} · {p.shop_domain}
            </p>
            <p className="mt-2 text-sm text-gray-700">
              {num(p.members)} members · {num(p.points_outstanding)} points outstanding
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Live since {when(p.live_since)} · Klaviyo {p.klaviyo_enabled_at ? `on since ${when(p.klaviyo_enabled_at)}` : "off"}
            </p>
          </Link>
        ))}
        {programs.length === 0 && !error ? <p className="text-sm text-gray-500">No loyalty programs yet.</p> : null}
      </section>

      {program ? (
        <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold text-gray-900">Find a member in {program.name}</h2>
            <span className="flex gap-3 text-sm">
              <Link href={`/loyalty/insights?program=${program.id}`} className="text-gray-700 underline">
                Insights
              </Link>
              <Link href={`/loyalty/campaigns?program=${program.id}`} className="text-gray-700 underline">
                Campaigns
              </Link>
            </span>
          </div>
          <form method="get" action="/loyalty" className="mt-3 flex gap-2">
            <input type="hidden" name="program" value={program.id} />
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="Email, name, Shopify customer ID or referral code"
              className={inputCls}
              minLength={2}
              required
            />
            <button type="submit" className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800">
              Search
            </button>
          </form>

          {q ? (
            hits.length ? (
              <table className="mt-4 w-full text-left text-sm">
                <thead className="text-xs text-gray-500">
                  <tr>
                    <th className="py-2 font-medium">Member</th>
                    <th className="py-2 font-medium">Tier</th>
                    <th className="py-2 text-right font-medium">Points</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {hits.map((h) => (
                    <tr key={h.id}>
                      <td className="py-2">
                        <Link href={`/loyalty/members/${h.id}`} className="font-medium text-gray-900 hover:underline">
                          {[h.first_name, h.last_name].filter(Boolean).join(" ") || "(no name)"}
                        </Link>
                        <div className="text-xs text-gray-500">
                          {h.email ?? "no email"} · customer {h.shopify_customer_id}
                          {h.status !== "active" ? ` · ${h.status}` : ""}
                        </div>
                      </td>
                      <td className="py-2 text-gray-700">{h.tier}</td>
                      <td className="py-2 text-right tabular-nums text-gray-900">{num(h.points)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-4 text-sm text-gray-500">No members match &ldquo;{q}&rdquo;.</p>
            )
          ) : null}
          {hits.length === 50 ? <p className="mt-2 text-xs text-gray-400">Showing the first 50. Narrow the search to see others.</p> : null}
        </section>
      ) : programs.length > 1 ? (
        <p className="mt-4 text-sm text-gray-500">Pick a program to search its members.</p>
      ) : null}

      <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-900">Privacy data requests</h2>
        <p className="mt-0.5 text-xs text-gray-500">
          Shopify customers/data_request webhooks from the last 90 days. Reply to the store with what we hold for that
          customer (search by their customer ID above).
        </p>
        {requests.length ? (
          <ul className="mt-3 divide-y divide-gray-100 text-sm">
            {requests.map((r, i) => (
              <li key={i} className="flex justify-between gap-3 py-2">
                <span className="text-gray-700">
                  {r.shop_domain}: {r.outcome ?? "not processed"}
                </span>
                <span className="shrink-0 text-xs text-gray-400">{when(r.received_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">None.</p>
        )}
      </section>
    </div>
  );
}
