import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaffPage } from "../access";
import { num } from "../format";
import { saveEarnRule, saveReward, saveSettings, saveTiers } from "./actions";

// Program editor (0221): earn rate, expiry and demotion clocks, tiers, rewards
// and earning rules, which used to need SQL. Staff + MFA only like every
// /loyalty page; each save is one access-log row with before and after.
// Changes reach the storefront through the shop metafield within minutes.

type Settings = {
  id: string;
  name: string;
  shop_domain: string;
  points_per_dollar: number;
  expire_months: number | null;
  demote_months: number;
  demotion_warning_days: number;
  balance_reminder_days: number;
  near_tier_percent: number;
  gross_margin_pct: number | null;
  code_prefix: string;
};
type Tier = { key: string; name: string; rank: number; min_spend_cents: number; earn_multiplier: number; perks: string[]; members: number };
type Reward = {
  key: string;
  name: string;
  points_cost: number | null;
  value_cents: number;
  min_order_cents: number;
  max_units: number | null;
  is_active: boolean;
  codes_issued: number;
};
type Rule = { key: string; kind: "action" | "milestone" | "referral"; points: number; order_count: number | null; is_active: boolean; title: string | null };
type Config = { program: Settings; tiers: Tier[]; rewards: Reward[]; earn_rules: Rule[] };
type Program = { id: string; name: string; shop_domain: string };

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900";
const labelCls = "block text-xs font-medium text-gray-600";
const saveCls = "rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800";

const RULE_LABEL: Record<string, string> = {
  signup: "Sign up",
  newsletter: "Newsletter sign-up",
  birthday: "Birthday",
  anniversary: "Member anniversary",
  instagram_follow: "Follow on Instagram",
  referral: "Refer a friend (referrer's points)",
};

function ordinal(n: number): string {
  const v = n % 100;
  return `${n}${["th", "st", "nd", "rd"][(v - 20) % 10] ?? ["th", "st", "nd", "rd"][v] ?? "th"}`;
}

function ruleLabel(r: Rule): string {
  if (r.kind === "milestone") return `${ordinal(r.order_count ?? 0)} order milestone`;
  return r.title || RULE_LABEL[r.key] || r.key.replace(/_/g, " ");
}

function dollars(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(cents % 100 ? 2 : 0);
}

export default async function ProgramEditorPage({
  searchParams,
}: {
  searchParams: Promise<{ program?: string; saved?: string; error?: string }>;
}) {
  const { program: programParam, saved, error: actionError } = await searchParams;
  await requireStaffPage(`/loyalty/program${programParam ? `?program=${encodeURIComponent(programParam)}` : ""}`);
  const supabase = await createClient();
  const { data: programData } = await supabase.rpc("loyalty_staff_programs");
  const programs = (programData ?? []) as Program[];
  const program = programs.find((p) => p.id === programParam) ?? (programs.length === 1 ? programs[0] : undefined);

  let config: Config | null = null;
  let loadError: string | null = null;
  if (program) {
    const res = await supabase.rpc("loyalty_staff_program_config", { p_program: program.id });
    config = (res.data ?? null) as Config | null;
    loadError = res.error?.message ?? null;
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-lg font-semibold text-gray-900">Program</h1>
      <p className="mt-1 text-sm text-gray-500">
        Rewards, tiers, earning and clocks. Changes apply from the next order or job run and reach the store within a few
        minutes. Every save is recorded in the access log.
      </p>

      {programs.length > 1 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {programs.map((p) => (
            <Link
              key={p.id}
              href={`/loyalty/program?program=${p.id}`}
              className={`rounded-md border px-3 py-1.5 text-sm ${p.id === program?.id ? "border-gray-900 text-gray-900" : "border-gray-200 text-gray-600 hover:border-gray-400"}`}
            >
              {p.name} · {p.shop_domain}
            </Link>
          ))}
        </div>
      ) : null}

      {saved ? <div className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">{saved}</div> : null}
      {actionError || loadError ? (
        <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{actionError ?? loadError}</div>
      ) : null}

      {!program ? <p className="mt-4 text-sm text-gray-500">Pick a program to edit.</p> : null}

      {config ? (
        <>
          {/* ---------------- Settings ---------------- */}
          <section id="settings" className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-900">Earning and clocks</h2>
            <form action={saveSettings} className="mt-4 grid gap-4 sm:grid-cols-3">
              <input type="hidden" name="program_id" value={config.program.id} />
              <label>
                <span className={labelCls}>Points per $1 spent</span>
                <input name="points_per_dollar" type="number" step="0.01" min="0.1" max="100" required defaultValue={config.program.points_per_dollar} className={inputCls} />
              </label>
              <label>
                <span className={labelCls}>Points expire after (months without activity)</span>
                <input name="expire_months" type="number" min="1" max="60" placeholder="Never" defaultValue={config.program.expire_months ?? ""} className={inputCls} />
              </label>
              <label>
                <span className={labelCls}>Down one tier after (months without an order)</span>
                <input name="demote_months" type="number" min="1" max="36" required defaultValue={config.program.demote_months} className={inputCls} />
              </label>
              <label>
                <span className={labelCls}>Demotion warning (days before)</span>
                <input name="demotion_warning_days" type="number" min="0" max="60" required defaultValue={config.program.demotion_warning_days} className={inputCls} />
              </label>
              <label>
                <span className={labelCls}>Balance reminder (every N days)</span>
                <input name="balance_reminder_days" type="number" min="7" max="365" required defaultValue={config.program.balance_reminder_days} className={inputCls} />
              </label>
              <label>
                <span className={labelCls}>&ldquo;Near tier&rdquo; within (% of the next threshold)</span>
                <input name="near_tier_percent" type="number" min="1" max="50" required defaultValue={config.program.near_tier_percent} className={inputCls} />
              </label>
              <label>
                <span className={labelCls}>Gross margin % (for insights; empty = revenue only)</span>
                <input name="gross_margin_pct" type="number" step="0.1" min="1" max="100" placeholder="Not set" defaultValue={config.program.gross_margin_pct ?? ""} className={inputCls} />
              </label>
              <div className="flex items-end sm:col-span-2">
                <button type="submit" className={saveCls}>
                  Save settings
                </button>
              </div>
            </form>
          </section>

          {/* ---------------- Tiers ---------------- */}
          <section id="tiers" className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-900">Tiers</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Thresholds are total spend since the program started. Lowering one moves members who now qualify up straight
              away, without tier emails. Raising one never moves anyone down. Perks are the text shown on the rewards page,
              one per line; free shipping and discounts are set up separately.
            </p>
            <form action={saveTiers} className="mt-4">
              <input type="hidden" name="program_id" value={config.program.id} />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="text-xs text-gray-500">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Tier</th>
                      <th className="py-2 pr-3 font-medium">Members</th>
                      <th className="py-2 pr-3 font-medium">Spend to reach ($)</th>
                      <th className="py-2 pr-3 font-medium">Points multiplier</th>
                      <th className="py-2 font-medium">Perks (one per line)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 align-top">
                    {config.tiers.map((t, i) => (
                      <tr key={t.key}>
                        <td className="py-2 pr-3 font-medium text-gray-900">
                          <input type="hidden" name="tier_key" value={t.key} />
                          {t.name}
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-gray-700">{num(t.members)}</td>
                        <td className="py-2 pr-3">
                          <input
                            name={`min_spend_${t.key}`}
                            type="number"
                            step="0.01"
                            min="0"
                            required
                            readOnly={i === 0}
                            defaultValue={dollars(t.min_spend_cents)}
                            className={`${inputCls} ${i === 0 ? "bg-gray-50 text-gray-500" : ""}`}
                            aria-label={`${t.name} spend threshold`}
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input name={`multiplier_${t.key}`} type="number" step="0.01" min="1" max="5" required defaultValue={t.earn_multiplier} className={inputCls} aria-label={`${t.name} multiplier`} />
                        </td>
                        <td className="py-2">
                          <textarea name={`perks_${t.key}`} rows={3} defaultValue={(t.perks ?? []).join("\n")} className={inputCls} aria-label={`${t.name} perks`} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="submit" className={`mt-3 ${saveCls}`}>
                Save tiers
              </button>
            </form>
          </section>

          {/* ---------------- Rewards ---------------- */}
          <section id="rewards" className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-900">Rewards</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Dollar-off codes members buy with points. &ldquo;Max per code&rdquo; lets a member combine several into one code
              (empty = no limit). Turning a reward off hides it; codes already issued keep working.
            </p>
            <div className="mt-4 space-y-3">
              {config.rewards.map((r) => (
                <RewardForm key={r.key} programId={config.program.id} reward={r} />
              ))}
              <details className="rounded-md border border-dashed border-gray-300 p-3">
                <summary className="cursor-pointer text-sm font-medium text-gray-700">Add a reward</summary>
                <div className="mt-3">
                  <RewardForm programId={config.program.id} />
                </div>
              </details>
            </div>
          </section>

          {/* ---------------- Earning rules ---------------- */}
          <section id="earning" className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-900">Earning rules</h2>
            <p className="mt-0.5 text-xs text-gray-500">Bonus points for actions and order milestones. Order points come from the rate above.</p>
            <ul className="mt-3 divide-y divide-gray-100">
              {config.earn_rules.map((r) => (
                <li key={r.key} id={`e-${r.key}`} className="py-2">
                  <form action={saveEarnRule} className="flex flex-wrap items-center gap-3">
                    <input type="hidden" name="program_id" value={config.program.id} />
                    <input type="hidden" name="rule_key" value={r.key} />
                    <span className="min-w-[220px] flex-1 text-sm text-gray-900">{ruleLabel(r)}</span>
                    <label className="flex items-center gap-2 text-sm text-gray-600">
                      <input name="points" type="number" min="0" max="100000" required defaultValue={r.points} className={`${inputCls} w-28`} aria-label={`${ruleLabel(r)} points`} />
                      points
                    </label>
                    <label className="flex items-center gap-2 text-sm text-gray-600">
                      <input type="checkbox" name="is_active" defaultChecked={r.is_active} />
                      On
                    </label>
                    <button type="submit" className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
                      Save
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}

/** One reward's row, or the "add a reward" form when `reward` is missing. */
function RewardForm({ programId, reward }: { programId: string; reward?: Reward }) {
  const referral = reward ? reward.points_cost === null : false;
  return (
    <form action={saveReward} id={reward ? `r-${reward.key}` : undefined} className="grid gap-3 rounded-md border border-gray-200 p-3 sm:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto_auto] sm:items-end">
      <input type="hidden" name="program_id" value={programId} />
      <input type="hidden" name="reward_key" value={reward?.key ?? ""} />
      <label>
        <span className={labelCls}>Name</span>
        <input name="name" required maxLength={60} defaultValue={reward?.name ?? ""} placeholder="$10 off" className={inputCls} />
      </label>
      <label>
        <span className={labelCls}>Points cost</span>
        {referral ? (
          <input disabled value="Referral coupon" className={`${inputCls} bg-gray-50 text-gray-500`} aria-label="Points cost" />
        ) : (
          <input name="points_cost" type="number" min="1" required defaultValue={reward?.points_cost ?? ""} className={inputCls} />
        )}
      </label>
      <label>
        <span className={labelCls}>Value ($)</span>
        <input name="value" type="number" step="0.01" min="1" max="1000" required defaultValue={dollars(reward?.value_cents)} className={inputCls} />
      </label>
      <label>
        <span className={labelCls}>Min order ($)</span>
        <input name="min_order" type="number" step="0.01" min="0" defaultValue={dollars(reward?.min_order_cents ?? 0)} className={inputCls} />
      </label>
      <label>
        <span className={labelCls}>Max per code</span>
        {referral ? (
          <input disabled value="1" className={`${inputCls} bg-gray-50 text-gray-500`} aria-label="Max per code" />
        ) : (
          <input name="max_units" type="number" min="1" max="1000" placeholder="No limit" defaultValue={reward ? reward.max_units ?? "" : "1"} className={inputCls} />
        )}
      </label>
      <label className="flex items-center gap-2 pb-2 text-sm text-gray-600">
        <input type="checkbox" name="is_active" defaultChecked={reward ? reward.is_active : true} />
        On
      </label>
      <div className="flex flex-col items-start gap-1">
        <button type="submit" className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100">
          {reward ? "Save" : "Add"}
        </button>
        {reward ? <span className="text-xs text-gray-400">{num(reward.codes_issued)} codes</span> : null}
      </div>
    </form>
  );
}
