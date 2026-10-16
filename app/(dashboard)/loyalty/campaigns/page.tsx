import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaffPage } from "../access";
import { money, num } from "../format";
import { saveCampaign, setCampaignActive } from "./actions";
import { BadgeTable, ChallengeForm, ChallengeList, type Badge, type Challenge } from "./challenges";

// Campaign console (Phase 1b module 14, 0215): create, schedule, edit and
// pause bonus campaigns (0214), see their results, and the points liability
// + expiry forecast. Staff + MFA only, like every /loyalty page; every change
// is in the access log. Challenges and the badge list (0216, module 13) are in
// ./challenges.tsx.

type Campaign = {
  id: string;
  key: string;
  name: string;
  kind: "multiplier" | "flat";
  multiplier: number | null;
  flat_points: number | null;
  min_scope_cents: number;
  starts_at: string;
  ends_at: string;
  starts_local: string;
  ends_local: string;
  collection_gid: string | null;
  product_tag: string | null;
  announce: boolean;
  announced_at: string | null;
  is_active: boolean;
  status: "upcoming" | "running" | "ended" | "paused";
  scope: { resolved_at: string | null; error: string | null; products: number } | null;
  events: { sent: number; pending: number; skipped: number };
  results: { orders: number; members: number; bonus_points: number; revenue_cents: number };
  window: {
    lift: { per_member_cents: number; low_cents: number; high_cents: number; significant: boolean } | null;
    aa_check: boolean;
    basis: string;
  } | null;
  created_by: string;
};
type Console = { timezone: string; live: boolean; campaigns: Campaign[] };
type Forecast = {
  cents_per_point: number | null;
  outstanding: { points: number; members: number; cents: number | null };
  unused_codes: { codes: number; cents: number };
  expiry_rule: string | null;
  expiring: { month: string; points: number; members: number; cents: number | null }[];
};
type Program = { id: string; name: string; shop_domain: string };

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900";
const STATUS: Record<Campaign["status"], string> = {
  running: "bg-green-50 text-green-700",
  upcoming: "bg-blue-50 text-blue-700",
  paused: "bg-amber-50 text-amber-800",
  ended: "bg-gray-100 text-gray-600",
};

function localLabel(local: string): string {
  return new Date(`${local}:00Z`).toLocaleString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function bonusLabel(c: Pick<Campaign, "kind" | "multiplier" | "flat_points" | "min_scope_cents">): string {
  return c.kind === "multiplier"
    ? `${Number(c.multiplier)}x points`
    : `+${num(c.flat_points)} points${c.min_scope_cents > 1 ? ` on ${money(c.min_scope_cents)}+` : ""}`;
}

function scopeLabel(c: Campaign): string {
  if (c.product_tag) return `products tagged “${c.product_tag}”`;
  if (c.collection_gid) return `collection ${c.collection_gid.split("/").pop()}`;
  return "whole order";
}

function monthLabel(ym: string): string {
  return new Date(`${ym}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function CampaignForm({ programId, c }: { programId: string; c?: Campaign }) {
  // Same rule as loyalty_staff_campaign_save: once the start has passed, the bonus is locked.
  const started = c ? new Date(c.starts_at) <= new Date() : false;
  const scope = c?.product_tag ? "tag" : c?.collection_gid ? "collection" : "none";
  return (
    <form action={saveCampaign} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="program_id" value={programId} />
      {c ? <input type="hidden" name="campaign_id" value={c.id} /> : null}
      <label className="text-sm sm:col-span-2">
        <span className="text-gray-700">Name (customers see it)</span>
        <input name="name" defaultValue={c?.name ?? ""} maxLength={80} required className={inputCls} placeholder="Double points on new arrivals" />
      </label>

      {started && c ? (
        <>
          {/* Locked once started (0215): sent back unchanged. */}
          <input type="hidden" name="kind" value={c.kind} />
          <input type="hidden" name="multiplier" value={c.multiplier ?? ""} />
          <input type="hidden" name="flat_points" value={c.flat_points ?? ""} />
          <input type="hidden" name="min_scope" value={(c.min_scope_cents / 100).toFixed(2)} />
          <input type="hidden" name="scope" value={scope} />
          <input type="hidden" name="scope_value" value={c.product_tag ?? c.collection_gid ?? ""} />
          <input type="hidden" name="starts_local" value={c.starts_local} />
          <p className="text-sm text-gray-600 sm:col-span-2">
            {bonusLabel(c)} on {scopeLabel(c)}, started {localLabel(c.starts_local)}. Started campaigns can only change their
            name, end and announcement.
          </p>
        </>
      ) : (
        <>
          <label className="text-sm">
            <span className="text-gray-700">Bonus</span>
            <select name="kind" defaultValue={c?.kind ?? "multiplier"} className={inputCls}>
              <option value="multiplier">Points multiplier</option>
              <option value="flat">Flat points per order</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="text-gray-700">Multiplier</span>
              <input name="multiplier" type="number" step="0.1" min="1.1" max="10" defaultValue={c?.multiplier ?? 2} className={inputCls} />
            </label>
            <label className="text-sm">
              <span className="text-gray-700">Flat points</span>
              <input name="flat_points" type="number" step="1" min="1" defaultValue={c?.flat_points ?? ""} className={inputCls} />
            </label>
          </div>
          <label className="text-sm">
            <span className="text-gray-700">Applies to</span>
            <select name="scope" defaultValue={scope} className={inputCls}>
              <option value="none">The whole order</option>
              <option value="tag">Products with a tag</option>
              <option value="collection">A collection (ID from its admin URL)</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="text-gray-700">Tag or collection ID</span>
            <input name="scope_value" defaultValue={c?.product_tag ?? c?.collection_gid?.split("/").pop() ?? ""} className={inputCls} />
          </label>
          <label className="text-sm">
            <span className="text-gray-700">Flat bonus: minimum spend in scope ($)</span>
            <input name="min_scope" type="number" step="0.01" min="0.01" defaultValue={c && c.min_scope_cents > 1 ? (c.min_scope_cents / 100).toFixed(2) : ""} className={inputCls} />
          </label>
          <label className="text-sm">
            <span className="text-gray-700">Starts (store time)</span>
            <input name="starts_local" type="datetime-local" defaultValue={c?.starts_local ?? ""} required className={inputCls} />
          </label>
        </>
      )}
      <label className="text-sm">
        <span className="text-gray-700">Ends (store time)</span>
        <input name="ends_local" type="datetime-local" defaultValue={c?.ends_local ?? ""} required className={inputCls} />
      </label>
      <label className="flex items-center gap-2 text-sm text-gray-700 sm:col-span-2">
        <input type="checkbox" name="announce" defaultChecked={c?.announce ?? true} />
        Send the &ldquo;LL: Bonus Campaign&rdquo; Klaviyo event to treatment members when it starts
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800">
          {c ? "Save" : "Create campaign"}
        </button>
        <Link href={`/loyalty/campaigns?program=${programId}`} className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">
          Cancel
        </Link>
      </div>
      {!started ? (
        <p className="text-xs text-gray-500 sm:col-span-2">
          Tag and collection campaigns need their products looked up in Shopify first (within a minute): create them at least an
          hour before they start. Orders before the lookup get no bonus.
        </p>
      ) : null}
    </form>
  );
}

export default async function LoyaltyCampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ program?: string; edit?: string; new?: string; editch?: string; newch?: string; saved?: string; error?: string }>;
}) {
  const { program: programParam, edit, new: isNew, editch, newch, saved, error: errorParam } = await searchParams;
  await requireStaffPage(`/loyalty/campaigns${programParam ? `?program=${encodeURIComponent(programParam)}` : ""}`);
  const supabase = await createClient();

  const { data: programData } = await supabase.rpc("loyalty_staff_programs");
  const programs = (programData ?? []) as Program[];
  const program = programs.find((p) => p.id === programParam) ?? (programs.length === 1 ? programs[0] : undefined);
  if (!program) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-lg font-semibold text-gray-900">Campaigns</h1>
        <ul className="mt-4 space-y-2 text-sm">
          {programs.map((p) => (
            <li key={p.id}>
              <Link href={`/loyalty/campaigns?program=${p.id}`} className="font-medium text-gray-900 hover:underline">
                {p.name}
              </Link>{" "}
              <span className="text-gray-500">{p.shop_domain}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const [con, fc, chl] = await Promise.all([
    supabase.rpc("loyalty_staff_campaigns", { p_program: program.id }),
    supabase.rpc("loyalty_staff_forecast", { p_program: program.id }),
    supabase.rpc("loyalty_staff_challenges", { p_program: program.id }),
  ]);
  const error = errorParam ?? con.error?.message ?? fc.error?.message ?? chl.error?.message ?? null;
  const c = con.data as Console | null;
  const f = fc.data as Forecast | null;
  const ch = chl.data as { challenges: Challenge[]; badges: Badge[] } | null;
  const editing = c?.campaigns.find((x) => x.id === edit);
  const editingCh = ch?.challenges.find((x) => x.id === editch);
  const formOpen = Boolean(isNew || editing || newch || editingCh);

  return (
    <div className="max-w-5xl">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">{program.name} campaigns</h1>
          <p className="mt-1 text-sm text-gray-500">
            Bonus points for a time window. Treatment members only; the holdout never gets them.{" "}
            <Link href={`/loyalty/insights?program=${program.id}`} className="text-gray-700 underline">
              Insights
            </Link>{" "}
            ·{" "}
            <Link href={`/loyalty?program=${program.id}`} className="text-gray-700 underline">
              Members
            </Link>
          </p>
        </div>
        {!formOpen ? (
          <div className="flex gap-2">
            <Link
              href={`/loyalty/campaigns?program=${program.id}&new=1`}
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              New campaign
            </Link>
            <Link
              href={`/loyalty/campaigns?program=${program.id}&newch=1`}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
            >
              New challenge
            </Link>
          </div>
        ) : null}
      </div>

      {saved ? <div className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">{saved}</div> : null}
      {error ? <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}
      {c && !c.live ? (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Phase 1b isn&rsquo;t live for this program yet (no <code>treatment_since</code>): campaigns award nothing and send
          nothing until it is.
        </div>
      ) : null}

      {isNew || editing ? (
        <section className="mt-5 rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-900">{editing ? `Edit ${editing.name}` : "New campaign"}</h2>
          <CampaignForm programId={program.id} c={editing} />
        </section>
      ) : null}
      {newch || editingCh ? (
        <section className="mt-5 rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-900">{editingCh ? `Edit ${editingCh.name}` : "New challenge"}</h2>
          <ChallengeForm programId={program.id} c={editingCh} />
        </section>
      ) : null}

      <h2 className="mt-6 text-sm font-semibold text-gray-900">Bonus campaigns</h2>
      <section className="mt-3 space-y-3">
        {(c?.campaigns ?? []).map((x) => (
          <article key={x.id} id={`c-${x.id}`} className="rounded-lg border border-gray-200 bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-gray-900">{x.name}</h2>
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS[x.status]}`}>{x.status}</span>
                </div>
                <p className="mt-0.5 text-sm text-gray-600">
                  {bonusLabel(x)} on {scopeLabel(x)} · {localLabel(x.starts_local)} to {localLabel(x.ends_local)}
                </p>
                {x.scope ? (
                  <p className={`mt-0.5 text-xs ${x.scope.error ? "text-red-700" : "text-gray-500"}`}>
                    {x.scope.error
                      ? `Product lookup failed: ${x.scope.error}`
                      : x.scope.resolved_at
                        ? `${num(x.scope.products)} products in scope`
                        : "Looking up products in Shopify…"}
                  </p>
                ) : null}
              </div>
              <div className="flex gap-2">
                {x.status !== "ended" ? (
                  <Link
                    href={`/loyalty/campaigns?program=${program.id}&edit=${x.id}`}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                  >
                    Edit
                  </Link>
                ) : null}
                {x.status !== "ended" ? (
                  <form action={setCampaignActive}>
                    <input type="hidden" name="program_id" value={program.id} />
                    <input type="hidden" name="campaign_id" value={x.id} />
                    <input type="hidden" name="active" value={x.is_active ? "0" : "1"} />
                    <button type="submit" className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
                      {x.is_active ? "Pause" : "Resume"}
                    </button>
                  </form>
                ) : null}
              </div>
            </div>

            {x.status !== "upcoming" ? (
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-gray-500">Orders with the bonus</dt>
                  <dd className="tabular-nums text-gray-900">{num(x.results.orders)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Their revenue</dt>
                  <dd className="tabular-nums text-gray-900">{money(x.results.revenue_cents)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Bonus points</dt>
                  <dd className="tabular-nums text-gray-900">
                    {num(x.results.bonus_points)}
                    {f?.cents_per_point ? <span className="text-gray-500"> ({money(Math.round(x.results.bonus_points * f.cents_per_point))})</span> : null}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Members</dt>
                  <dd className="tabular-nums text-gray-900">{num(x.results.members)}</dd>
                </div>
              </dl>
            ) : null}
            {x.window?.lift ? (
              <p className="mt-3 text-xs text-gray-500">
                {x.window.aa_check ? "A/A check over the window" : "Treatment vs holdout over the window (all Phase 1b features)"}:{" "}
                {money(x.window.lift.per_member_cents)} per member ({money(x.window.lift.low_cents)} to {money(x.window.lift.high_cents)}
                {x.window.lift.significant ? "" : ", not significant"}).
              </p>
            ) : null}
            {x.announce ? (
              <p className="mt-1 text-xs text-gray-500">
                Announcement: {x.announced_at ? `${num(x.events.sent)} sent, ${num(x.events.pending)} waiting, ${num(x.events.skipped)} skipped` : "sends when it starts"}
              </p>
            ) : null}
          </article>
        ))}
        {c && c.campaigns.length === 0 ? <p className="text-sm text-gray-500">No campaigns yet.</p> : null}
      </section>

      {ch ? (
        <>
          <h2 className="mt-6 text-sm font-semibold text-gray-900">Challenges</h2>
          <p className="mt-0.5 text-xs text-gray-500">A goal within a window; points once when a treatment member reaches it.</p>
          <div className="mt-3">
            <ChallengeList programId={program.id} challenges={ch.challenges} />
          </div>

          <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-900">Badges</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              One-time awards, treatment members only. Set by LumiLink in the database (loyalty_badges); milestones show Joy&rsquo;s
              existing order awards.
            </p>
            <BadgeTable badges={ch.badges} />
          </section>
        </>
      ) : null}

      {f ? (
        <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-900">Liability and expiry</h2>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-gray-500">Points outstanding</dt>
              <dd className="tabular-nums text-gray-900">
                {num(f.outstanding.points)} {f.outstanding.cents !== null ? <span className="text-gray-500">({money(f.outstanding.cents)})</span> : null}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Members with points</dt>
              <dd className="tabular-nums text-gray-900">{num(f.outstanding.members)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Unused reward codes</dt>
              <dd className="tabular-nums text-gray-900">
                {num(f.unused_codes.codes)} <span className="text-gray-500">({money(f.unused_codes.cents)})</span>
              </dd>
            </div>
          </dl>
          {f.expiry_rule ? (
            <>
              <p className="mt-4 text-xs text-gray-500">
                Points expire after {f.expiry_rule} without activity. Expected to expire if those members do nothing:
              </p>
              <table className="mt-2 w-full text-left text-sm">
                <thead className="text-xs text-gray-500">
                  <tr>
                    <th className="py-1 font-medium">Month</th>
                    <th className="py-1 text-right font-medium">Members</th>
                    <th className="py-1 text-right font-medium">Points</th>
                    <th className="py-1 text-right font-medium">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 tabular-nums">
                  {f.expiring.map((m) => (
                    <tr key={m.month}>
                      <td className="py-1 text-gray-700">{monthLabel(m.month)}</td>
                      <td className="py-1 text-right">{num(m.members)}</td>
                      <td className="py-1 text-right">{num(m.points)}</td>
                      <td className="py-1 text-right">{m.cents === null ? "—" : money(m.cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="mt-4 text-xs text-gray-500">Points don&rsquo;t expire in this program.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
