import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaffPage } from "./access";
import { dateOnly, money, num, when } from "./format";

// LL Loyalty staff admin: programs and the members table (0206, 0219).
// LumiLink staff only (platform_staff) with MFA (0210), checked here for the
// 404 / MFA step and again inside every RPC. Each page of the table is one
// access-log row; there is no export.

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900";

type Program = {
  id: string;
  name: string;
  tiers: { key: string; name: string }[] | null;
  shop_domain: string;
  client: string;
  is_active: boolean;
  live_since: string | null;
  klaviyo_enabled_at: string | null;
  members: number;
  points_outstanding: number;
};

type Row = {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  tier: string;
  points: number;
  tier_spend_cents: number;
  orders: number;
  last_order_at: string | null;
  group: "treatment" | "holdout";
  status: string;
};

type Sort = "points" | "spend" | "last_order";
type MemberPage = { total: number; page: number; page_size: number; rows: Row[]; sort: Sort; dir: "asc" | "desc" };

type Params = {
  program?: string;
  q?: string;
  tier?: string;
  status?: string;
  group?: string;
  can_redeem?: string;
  demotes_30d?: string;
  expires_30d?: string;
  sort?: string;
  dir?: string;
  page?: string;
};

const FLAGS = [
  { key: "can_redeem", label: "Can redeem" },
  { key: "demotes_30d", label: "Demotes within 30 days" },
  { key: "expires_30d", label: "Points expire within 30 days" },
] as const;

type DataRequest = { shop_domain: string; outcome: string | null; received_at: string };

/** /loyalty?… with the current filters plus overrides (an empty value drops the key). */
function href(params: Params, over: Partial<Params>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...over })) if (v) qs.set(k, v);
  return `/loyalty?${qs.toString()}`;
}

export default async function LoyaltyAdminPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  const { program: programParam, q } = params;
  await requireStaffPage(`/loyalty${programParam ? `?program=${encodeURIComponent(programParam)}` : ""}`);
  const supabase = await createClient();
  const { data: programData, error } = await supabase.rpc("loyalty_staff_programs");
  const programs = (programData ?? []) as Program[];
  const program = programs.find((p) => p.id === programParam) ?? (programs.length === 1 ? programs[0] : undefined);

  let list: MemberPage | null = null;
  let listError: string | null = null;
  if (program) {
    const filters: Record<string, string | boolean> = {};
    if (q && q.trim().length >= 2) filters.q = q.trim();
    if (params.tier) filters.tier = params.tier;
    if (params.status) filters.status = params.status;
    if (params.group) filters.group = params.group;
    for (const f of FLAGS) if (params[f.key] === "1") filters[f.key] = true;
    const res = await supabase.rpc("loyalty_staff_members", {
      p_program: program.id,
      p_filters: filters,
      p_sort: params.sort ?? "points",
      p_dir: params.dir ?? "desc",
      p_page: Math.max(Number(params.page) || 1, 1),
    });
    list = (res.data ?? null) as MemberPage | null;
    listError = res.error?.message ?? null;
  }
  // Links from the table keep the filters but start again at page 1.
  const base: Params = { ...params, program: program?.id, page: undefined };
  const { data: requestData } = await supabase.rpc("loyalty_staff_data_requests");
  const requests = (requestData ?? []) as DataRequest[];

  return (
    <div className="max-w-6xl">
      <h1 className="text-lg font-semibold text-gray-900">Loyalty</h1>
      <p className="mt-1 text-sm text-gray-500">
        LumiLink staff only. Every page of members and every member view is recorded in the access log.
      </p>

      {error || listError ? (
        <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error?.message ?? listError}</div>
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
            <h2 className="text-sm font-semibold text-gray-900">Members of {program.name}</h2>
            <span className="flex gap-3 text-sm">
              <Link href={`/loyalty/insights?program=${program.id}`} className="text-gray-700 underline">
                Insights
              </Link>
              <Link href={`/loyalty/campaigns?program=${program.id}`} className="text-gray-700 underline">
                Campaigns
              </Link>
            </span>
          </div>

          <form method="get" action="/loyalty" className="mt-3 space-y-3">
            <input type="hidden" name="program" value={program.id} />
            {params.sort ? <input type="hidden" name="sort" value={params.sort} /> : null}
            {params.dir ? <input type="hidden" name="dir" value={params.dir} /> : null}
            <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
              <input
                name="q"
                defaultValue={q ?? ""}
                placeholder="Email, name, Shopify customer ID or referral code"
                aria-label="Search members"
                className={inputCls}
              />
              <select name="tier" defaultValue={params.tier ?? ""} aria-label="Tier" className={inputCls}>
                <option value="">All tiers</option>
                {(program.tiers ?? []).map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name}
                  </option>
                ))}
              </select>
              <select name="status" defaultValue={params.status ?? ""} aria-label="Status" className={inputCls}>
                <option value="">Any status</option>
                <option value="active">Active</option>
                <option value="excluded">Excluded</option>
              </select>
              <select name="group" defaultValue={params.group ?? ""} aria-label="Group" className={inputCls}>
                <option value="">Both groups</option>
                <option value="treatment">Treatment</option>
                <option value="holdout">Holdout</option>
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-gray-700">
              {FLAGS.map((f) => (
                <label key={f.key} className="flex items-center gap-2">
                  <input type="checkbox" name={f.key} value="1" defaultChecked={params[f.key] === "1"} />
                  {f.label}
                </label>
              ))}
              <span className="ml-auto flex gap-2">
                <Link href={`/loyalty?program=${program.id}`} className="rounded-md px-3 py-2 text-sm text-gray-600 hover:bg-gray-100">
                  Clear
                </Link>
                <button type="submit" className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800">
                  Apply
                </button>
              </span>
            </div>
          </form>

          {list ? (
            list.rows.length ? (
              <>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[860px] text-left text-sm">
                    <thead className="text-xs text-gray-500">
                      <tr>
                        <th className="py-2 pr-3 font-medium">Member</th>
                        <th className="py-2 pr-3 font-medium">Tier</th>
                        <SortHeader label="Points" sort="points" list={list} base={base} />
                        <SortHeader label="Tier spend" sort="spend" list={list} base={base} />
                        <th className="py-2 pr-3 text-right font-medium">Orders</th>
                        <SortHeader label="Last order" sort="last_order" list={list} base={base} />
                        <th className="py-2 pr-3 font-medium">Group</th>
                        <th className="py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {list.rows.map((r) => (
                        <tr key={r.id}>
                          <td className="py-2 pr-3">
                            <Link href={`/loyalty/members/${r.id}`} className="font-medium text-gray-900 hover:underline">
                              {[r.first_name, r.last_name].filter(Boolean).join(" ") || "(no name)"}
                            </Link>
                            <div className="text-xs text-gray-500">{r.email ?? "no email"}</div>
                          </td>
                          <td className="py-2 pr-3 text-gray-700">{r.tier}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-gray-900">{num(r.points)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-gray-700">{money(r.tier_spend_cents)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-gray-700">{num(r.orders)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-gray-700">{dateOnly(r.last_order_at)}</td>
                          <td className="py-2 pr-3 text-gray-700">{r.group === "holdout" ? "Holdout" : "Treatment"}</td>
                          <td className="py-2 text-gray-700">{r.status === "active" ? "Active" : "Excluded"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex items-center justify-between text-sm text-gray-500">
                  <span>
                    {num((list.page - 1) * list.page_size + 1)}–{num((list.page - 1) * list.page_size + list.rows.length)} of{" "}
                    {num(list.total)}
                  </span>
                  <span className="flex gap-2">
                    {list.page > 1 ? (
                      <Link
                        href={href(base, { page: String(list.page - 1) })}
                        className="rounded-md border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-100"
                      >
                        Previous
                      </Link>
                    ) : null}
                    {list.page * list.page_size < list.total ? (
                      <Link
                        href={href(base, { page: String(list.page + 1) })}
                        className="rounded-md border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-100"
                      >
                        Next
                      </Link>
                    ) : null}
                  </span>
                </div>
              </>
            ) : (
              <p className="mt-4 text-sm text-gray-500">No members match these filters.</p>
            )
          ) : null}
        </section>
      ) : programs.length > 1 ? (
        <p className="mt-4 text-sm text-gray-500">Pick a program to see its members.</p>
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

/** A column header that sorts by `sort`; clicking the active one flips the direction. */
function SortHeader({ label, sort, list, base }: { label: string; sort: Sort; list: MemberPage; base: Params }) {
  const active = list.sort === sort;
  const dir = active && list.dir === "desc" ? "asc" : "desc";
  return (
    <th className="py-2 pr-3 text-right font-medium" aria-sort={active ? (list.dir === "desc" ? "descending" : "ascending") : "none"}>
      <Link href={href(base, { sort, dir })} className={`hover:text-gray-900 ${active ? "text-gray-900" : ""}`}>
        {label}
        {active ? (list.dir === "desc" ? " ↓" : " ↑") : ""}
      </Link>
    </th>
  );
}
