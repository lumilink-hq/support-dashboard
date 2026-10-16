import Link from "next/link";
import { money, num } from "../format";
import { saveChallenge, setChallengeActive } from "./actions";

// Challenges and badges on the campaign console (0216, Phase 1b module 13).
// Challenges are created here; badges are config (loyalty_badges, seeded per
// program) and shown read-only with how many members earned each.

export type Challenge = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: "order_count" | "spend" | "new_categories" | "tagged_product";
  target: number;
  points: number;
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
  completed: number;
  points_awarded: number;
};
export type Badge = {
  key: string;
  name: string;
  description: string;
  kind: string;
  threshold: number;
  points: number;
  is_active: boolean;
  earned: number | null;
};

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900";
const STATUS: Record<Challenge["status"], string> = {
  running: "bg-green-50 text-green-700",
  upcoming: "bg-blue-50 text-blue-700",
  paused: "bg-amber-50 text-amber-800",
  ended: "bg-gray-100 text-gray-600",
};
const KIND: Record<Challenge["kind"], string> = {
  order_count: "Orders",
  spend: "Spend",
  new_categories: "New categories",
  tagged_product: "Tagged product",
};

function localLabel(local: string): string {
  return new Date(`${local}:00Z`).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function goal(c: Pick<Challenge, "kind" | "target" | "product_tag" | "collection_gid">): string {
  switch (c.kind) {
    case "order_count":
      return `${num(c.target)} order${c.target === 1 ? "" : "s"}`;
    case "spend":
      return `spend ${money(c.target)}`;
    case "new_categories":
      return `${num(c.target)} new categor${c.target === 1 ? "y" : "ies"}`;
    default:
      return `${num(c.target)} order${c.target === 1 ? "" : "s"} with ${c.product_tag ? `tag “${c.product_tag}”` : `collection ${c.collection_gid?.split("/").pop()}`}`;
  }
}

export function ChallengeForm({ programId, c }: { programId: string; c?: Challenge }) {
  const started = c ? new Date(c.starts_at) <= new Date() : false;
  const scope = c?.collection_gid ? "collection" : "tag";
  return (
    <form action={saveChallenge} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="program_id" value={programId} />
      {c ? <input type="hidden" name="challenge_id" value={c.id} /> : null}
      <label className="text-sm">
        <span className="text-gray-700">Name (customers see it)</span>
        <input name="name" defaultValue={c?.name ?? ""} maxLength={80} required className={inputCls} placeholder="Try 2 new categories in November" />
      </label>
      <label className="text-sm">
        <span className="text-gray-700">Description (optional)</span>
        <input name="description" defaultValue={c?.description ?? ""} maxLength={200} className={inputCls} />
      </label>
      {started && c ? (
        <>
          <input type="hidden" name="kind" value={c.kind} />
          <input type="hidden" name="target" value={c.kind === "spend" ? (c.target / 100).toFixed(2) : c.target} />
          <input type="hidden" name="points" value={c.points} />
          <input type="hidden" name="scope" value={scope} />
          <input type="hidden" name="scope_value" value={c.product_tag ?? c.collection_gid?.split("/").pop() ?? ""} />
          <input type="hidden" name="starts_local" value={c.starts_local} />
          <p className="text-sm text-gray-600 sm:col-span-2">
            Goal: {goal(c)} for +{num(c.points)} points, started {localLabel(c.starts_local)}. Started challenges can only change
            their name, description, end and announcement.
          </p>
        </>
      ) : (
        <>
          <label className="text-sm">
            <span className="text-gray-700">Goal</span>
            <select name="kind" defaultValue={c?.kind ?? "order_count"} className={inputCls}>
              <option value="order_count">Number of orders</option>
              <option value="spend">Spend ($)</option>
              <option value="new_categories">Categories they haven&rsquo;t bought before</option>
              <option value="tagged_product">Orders with a tagged product or collection</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="text-gray-700">Target</span>
              <input name="target" type="number" step="any" min="0.01" required defaultValue={c ? (c.kind === "spend" ? (c.target / 100).toFixed(2) : c.target) : 2} className={inputCls} />
            </label>
            <label className="text-sm">
              <span className="text-gray-700">Points</span>
              <input name="points" type="number" step="1" min="1" max="100000" required defaultValue={c?.points ?? 200} className={inputCls} />
            </label>
          </div>
          <label className="text-sm">
            <span className="text-gray-700">Tagged-product goal: tag or collection</span>
            <select name="scope" defaultValue={scope} className={inputCls}>
              <option value="tag">Product tag</option>
              <option value="collection">Collection ID</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="text-gray-700">Tag or collection ID</span>
            <input name="scope_value" defaultValue={c?.product_tag ?? c?.collection_gid?.split("/").pop() ?? ""} className={inputCls} />
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
        Send the &ldquo;LL: Challenge Started&rdquo; Klaviyo event to treatment members when it starts
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800">
          {c ? "Save" : "Create challenge"}
        </button>
        <Link href={`/loyalty/campaigns?program=${programId}`} className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">
          Cancel
        </Link>
      </div>
    </form>
  );
}

export function ChallengeList({ programId, challenges }: { programId: string; challenges: Challenge[] }) {
  if (challenges.length === 0) return <p className="text-sm text-gray-500">No challenges yet.</p>;
  return (
    <div className="space-y-3">
      {challenges.map((x) => (
        <article key={x.id} id={`ch-${x.id}`} className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-900">{x.name}</h3>
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS[x.status]}`}>{x.status}</span>
                <span className="text-xs text-gray-500">{KIND[x.kind]}</span>
              </div>
              <p className="mt-0.5 text-sm text-gray-600">
                {goal(x)} for +{num(x.points)} points · {localLabel(x.starts_local)} to {localLabel(x.ends_local)}
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
              {x.status !== "upcoming" ? (
                <p className="mt-2 text-sm text-gray-700">
                  {num(x.completed)} completed · {num(x.points_awarded)} points awarded
                </p>
              ) : null}
            </div>
            {x.status !== "ended" ? (
              <div className="flex gap-2">
                <Link
                  href={`/loyalty/campaigns?program=${programId}&editch=${x.id}`}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                >
                  Edit
                </Link>
                <form action={setChallengeActive}>
                  <input type="hidden" name="program_id" value={programId} />
                  <input type="hidden" name="challenge_id" value={x.id} />
                  <input type="hidden" name="active" value={x.is_active ? "0" : "1"} />
                  <button type="submit" className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
                    {x.is_active ? "Pause" : "Resume"}
                  </button>
                </form>
              </div>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

export function BadgeTable({ badges }: { badges: Badge[] }) {
  return (
    <table className="mt-3 w-full text-left text-sm">
      <thead className="text-xs text-gray-500">
        <tr>
          <th className="py-1 font-medium">Badge</th>
          <th className="py-1 font-medium">Earned when</th>
          <th className="py-1 text-right font-medium">Points</th>
          <th className="py-1 text-right font-medium">Members</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {badges.map((b) => (
          <tr key={b.key} className={b.is_active ? "" : "text-gray-400"}>
            <td className="py-1.5 text-gray-900">{b.name}</td>
            <td className="py-1.5 text-gray-600">{b.description}</td>
            <td className="py-1.5 text-right tabular-nums">{b.points ? `+${num(b.points)}` : "—"}</td>
            <td className="py-1.5 text-right tabular-nums">{b.earned === null ? "milestone" : num(b.earned)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
