import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { humanize, timeAgo } from "@/lib/format";
import { SeoLocked } from "@/components/seo/locked";
import { getSeoAccess } from "@/lib/seo-access";
import { approveDraft, confirmManualApply, rejectDraft, requestRollback } from "./actions";

// Each tab is one or more statuses. "In progress" groups everything the backend
// is between approval and done, so a person isn't asked to watch four states.
const FILTERS = ["pending_approval", "manual_required", "in_progress", "published", "rejected", "all"] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABELS: Record<Filter, string> = {
  pending_approval: "Waiting for you",
  manual_required: "Do by hand",
  in_progress: "In progress",
  published: "Live",
  rejected: "Rejected",
  all: "All",
};

const FILTER_STATUSES: Record<Exclude<Filter, "all">, string[]> = {
  pending_approval: ["pending_approval"],
  manual_required: ["manual_required"],
  in_progress: ["approved", "publishing", "rollback_requested", "rolling_back"],
  published: ["published"],
  rejected: ["rejected", "rolled_back"],
};

const STATUS_BADGE: Record<string, string> = {
  pending_approval: "bg-amber-50 text-amber-700",
  manual_required: "bg-amber-50 text-amber-700",
  approved: "bg-blue-50 text-blue-700",
  publishing: "bg-blue-50 text-blue-700",
  rollback_requested: "bg-blue-50 text-blue-700",
  rolling_back: "bg-blue-50 text-blue-700",
  published: "bg-green-50 text-green-700",
  rejected: "bg-gray-100 text-gray-500",
  rolled_back: "bg-gray-100 text-gray-500",
  failed: "bg-red-50 text-red-700",
};

const STATUS_LABELS: Record<string, string> = {
  manual_required: "Needs you to apply it",
  approved: "Approved, publishing soon",
  publishing: "Publishing",
  rollback_requested: "Rolling back soon",
  rolling_back: "Rolling back",
  rolled_back: "Rolled back",
};

const FIELD_LABELS: Record<string, string> = {
  title_tag: "Page title",
  meta_description: "Meta description",
  h1: "Main heading (H1)",
  local_business_schema: "LocalBusiness structured data",
  article: "Blog article",
};

// Only ever link to a web address; the URL comes from our own publish step, but
// a link is a place a bad scheme can hide, so check anyway.
function safeHref(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

type ManualInstructions = {
  why: string;
  steps: string[];
  copy: { label: string; text: string };
  extra?: { label: string; text: string }[];
};

type Block = { type: "h2" | "h3" | "p" | "li"; text: string };

type ArticleProposal = {
  kind?: string;
  title?: string;
  meta_description?: string;
  keyword?: string;
  word_count?: number;
  blocks?: Block[];
  image?: { url: string; alt: string } | null;
  image_error?: string | null;
  uniqueness?: { compared?: number; max_overlap?: number; max_similarity?: number; warn?: boolean } | null;
};

type ActionRow = {
  id: string;
  action_type: string;
  proposed_value: ArticleProposal | null;
  publish_result: { image_error?: string | null; meta_verified?: boolean } | null;
  status: string;
  target_field: string | null;
  target_url: string | null;
  diff: { field?: string; before?: string | null; after?: string } | null;
  apply_mode: string | null;
  manual_instructions: ManualInstructions | null;
  error: string | null;
  drafted_by: string | null;
  created_at: string;
  published_at: string | null;
  seo_locations: { name: string } | null;
};

type ConnectionRow = { status: string; shop_domain: string; last_error: string | null; seo_locations: { name: string } | null };

const COLUMNS =
  "id, action_type, proposed_value, publish_result, status, target_field, target_url, diff, apply_mode, manual_instructions, error, drafted_by, created_at, published_at, seo_locations(name)";

function DiffBlock({ diff, field }: { diff: ActionRow["diff"]; field: string | null }) {
  const before = diff?.before ?? null;
  const after = diff?.after ?? "";
  // Structured data is a JSON document; everything else is one line of copy.
  const mono = field === "local_business_schema";
  const box = mono
    ? "whitespace-pre-wrap break-words rounded-md p-3 font-mono text-xs"
    : "rounded-md p-3 text-sm";
  return (
    <div className="mt-3 grid gap-2 md:grid-cols-2">
      <div>
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">Now</p>
        <div className={`${box} bg-red-50 text-red-900`}>
          {before ? before : <span className="text-gray-400">Nothing on the page yet</span>}
        </div>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">Proposed</p>
        <div className={`${box} bg-green-50 text-green-900`}>{after}</div>
      </div>
    </div>
  );
}

/**
 * A drafted article, rendered from the sanitised blocks the drafting step stored
 * (text only), never from the raw HTML: nothing here can inject markup.
 */
function ArticleBlock({ a }: { a: ArticleProposal }) {
  const blocks = a.blocks ?? [];
  const u = a.uniqueness;
  return (
    <div className="mt-3 space-y-3">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_16rem]">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Headline</p>
          <p className="mt-0.5 text-base font-semibold text-gray-900">{a.title}</p>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-gray-400">Meta description</p>
          <p className="mt-0.5 text-sm text-gray-700">{a.meta_description}</p>
          <p className="mt-2 text-xs text-gray-500">
            {a.word_count ? `${a.word_count} words` : null}
            {a.keyword ? ` · targets “${a.keyword}”` : null}
          </p>
        </div>
        <div>
          {a.image ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- a remote, per-article image; next/image would need the storage host allow-listed */}
              <img src={a.image.url} alt={a.image.alt} className="w-full rounded-md border border-gray-200" loading="lazy" />
              <p className="mt-1 text-xs text-gray-500">Alt text: {a.image.alt}</p>
            </>
          ) : (
            <p className="rounded-md border border-dashed border-gray-300 p-3 text-xs text-gray-500">
              No image. {a.image_error ?? ""}
            </p>
          )}
        </div>
      </div>

      {u ? (
        <p className={`text-xs ${u.warn ? "text-amber-700" : "text-gray-500"}`}>
          Checked against {u.compared ?? 0} other article{u.compared === 1 ? "" : "s"}: {Math.round((u.max_overlap ?? 0) * 100)}% shared wording at most
          {u.warn ? " (higher than usual, worth a read)" : ""}.
        </p>
      ) : null}

      <details className="rounded-md border border-gray-200 bg-gray-50">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-gray-700">Read the full article</summary>
        <div className="space-y-2 border-t border-gray-200 px-3 py-3 text-sm text-gray-800">
          {blocks.map((b, i) =>
            b.type === "h2" ? (
              <h3 key={i} className="pt-2 text-base font-semibold text-gray-900">{b.text}</h3>
            ) : b.type === "h3" ? (
              <h4 key={i} className="pt-1 text-sm font-semibold text-gray-900">{b.text}</h4>
            ) : b.type === "li" ? (
              <p key={i} className="pl-4">• {b.text}</p>
            ) : (
              <p key={i}>{b.text}</p>
            ),
          )}
        </div>
      </details>
    </div>
  );
}

function ManualBlock({ m, id, filter }: { m: ManualInstructions; id: string; filter: Filter }) {
  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3">
      <p className="text-sm font-medium text-amber-900">Please apply this one yourself</p>
      <p className="mt-0.5 text-sm text-amber-800">{m.why}</p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-gray-800">
        {m.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-500">{m.copy.label}</p>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-gray-200 bg-white p-3 font-mono text-xs text-gray-900">
        {m.copy.text}
      </pre>
      {(m.extra ?? []).map((x) => (
        <div key={x.label}>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-500">{x.label}</p>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-gray-200 bg-white p-3 font-mono text-xs text-gray-900">
            {x.text}
          </pre>
        </div>
      ))}
      <form action={confirmManualApply} className="mt-3">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="filter" value={filter} />
        <button
          type="submit"
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800"
        >
          I&apos;ve done this
        </button>
      </form>
    </div>
  );
}

export default async function SeoApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const access = await getSeoAccess();
  if (!access.allowed) return <SeoLocked state={access.state} />;

  const { status, error: actionError } = await searchParams;
  const active: Filter = (FILTERS as readonly string[]).includes(status ?? "")
    ? (status as Filter)
    : "pending_approval";

  const supabase = await createClient();

  let q = supabase
    .from("seo_actions")
    .select(COLUMNS)
    // Oldest first: the draft that has waited longest sits at the top.
    .order("created_at", { ascending: true });
  if (active !== "all") q = q.in("status", FILTER_STATUSES[active]);
  const { data, error } = await q;
  const items = (data ?? []) as unknown as ActionRow[];

  // Tab badges: what actually needs a person.
  const countOf = async (statuses: string[]) =>
    (
      await supabase
        .from("seo_actions")
        .select("id", { count: "exact", head: true })
        .in("status", statuses)
    ).count ?? 0;
  const [waiting, byHand] = await Promise.all([
    countOf(FILTER_STATUSES.pending_approval),
    countOf(FILTER_STATUSES.manual_required),
  ]);

  // A dead connection is invisible otherwise: drafts would just keep landing in
  // "Do by hand". plan.md: "the dashboard flags it".
  const { data: badConns } = await supabase
    .from("seo_site_connections")
    .select("status, shop_domain, last_error, seo_locations(name)")
    .in("status", ["revoked", "degraded"]);
  const connectionProblems = (badConns ?? []) as unknown as ConnectionRow[];

  const badge = (f: Filter) => (f === "pending_approval" ? waiting : f === "manual_required" ? byHand : 0);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-gray-900">SEO approvals</h1>
        <span className="text-sm text-gray-500">
          {items.length} {items.length === 1 ? "draft" : "drafts"}
        </span>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Changes we drafted for your site. Nothing goes live until you approve it.
      </p>

      {connectionProblems.map((c) => (
        <div
          key={c.shop_domain}
          className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {c.status === "revoked"
            ? `LumiLink's access to ${c.shop_domain}${c.seo_locations?.name ? ` (${c.seo_locations.name})` : ""} was revoked or has expired. Until it's reconnected, approved changes come to you as step-by-step instructions instead of publishing themselves.`
            : `LumiLink's access to ${c.shop_domain}${c.seo_locations?.name ? ` (${c.seo_locations.name})` : ""} is missing some permissions, so some kinds of change will come to you as instructions instead of publishing themselves.`}
        </div>
      ))}

      <div className="mt-4 flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={`/seo-approvals?status=${f}`}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${
              active === f ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            {FILTER_LABELS[f]}
            {badge(f) > 0 ? (
              <span
                className={`rounded-full px-1.5 text-xs ${
                  active === f ? "bg-white text-gray-900" : "bg-gray-200"
                }`}
              >
                {badge(f)}
              </span>
            ) : null}
          </Link>
        ))}
      </div>

      {actionError ? (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {actionError}
        </div>
      ) : null}

      {error ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Couldn&apos;t load the drafts: {error.message}
        </div>
      ) : items.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-400">
          {active === "pending_approval"
            ? "Nothing waiting for approval."
            : `No ${active === "all" ? "" : FILTER_LABELS[active].toLowerCase() + " "}drafts.`}
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((item) => (
            <li key={item.id} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-gray-900">
                  {FIELD_LABELS[item.target_field ?? ""] ?? humanize(item.target_field)}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    STATUS_BADGE[item.status] ?? "bg-gray-100 text-gray-500"
                  }`}
                >
                  {STATUS_LABELS[item.status] ?? humanize(item.status)}
                </span>
                <span className="text-xs text-gray-400">
                  {item.seo_locations?.name ? `${item.seo_locations.name} · ` : ""}
                  drafted {timeAgo(item.created_at)}
                  {item.published_at ? ` · live ${timeAgo(item.published_at)}` : ""}
                </span>
              </div>
              {item.target_url ? (
                item.status === "published" && safeHref(item.target_url) ? (
                  <a href={safeHref(item.target_url)!} target="_blank" rel="noopener noreferrer" className="mt-1 block break-all text-xs text-blue-700 underline">
                    {item.target_url}
                  </a>
                ) : (
                  <p className="mt-1 break-all text-xs text-gray-500">{item.target_url}</p>
                )
              ) : null}

              {item.action_type === "content_publish" && item.proposed_value ? (
                <ArticleBlock a={item.proposed_value} />
              ) : (
                <DiffBlock diff={item.diff} field={item.target_field} />
              )}

              {item.publish_result?.image_error ? (
                <p className="mt-2 text-xs text-amber-700">Published without its image: {item.publish_result.image_error}</p>
              ) : null}

              {item.error ? (
                <p className="mt-2 text-sm text-red-700">{item.error}</p>
              ) : null}

              {item.status === "pending_approval" ? (
                <div className="mt-3 flex gap-2">
                  <form action={approveDraft}>
                    <input type="hidden" name="id" value={item.id} />
                    <input type="hidden" name="filter" value={active} />
                    <button
                      type="submit"
                      className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800"
                    >
                      Approve
                    </button>
                  </form>
                  <form action={rejectDraft}>
                    <input type="hidden" name="id" value={item.id} />
                    <input type="hidden" name="filter" value={active} />
                    <button
                      type="submit"
                      className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
                    >
                      Reject
                    </button>
                  </form>
                </div>
              ) : null}

              {item.status === "manual_required" && item.manual_instructions ? (
                <ManualBlock m={item.manual_instructions} id={item.id} filter={active} />
              ) : null}

              {/* Only a change LumiLink applied itself can be undone by LumiLink. */}
              {item.status === "published" && item.apply_mode === "api" ? (
                <form action={requestRollback} className="mt-3">
                  <input type="hidden" name="id" value={item.id} />
                  <input type="hidden" name="filter" value={active} />
                  <button
                    type="submit"
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
                  >
                    Roll back
                  </button>
                </form>
              ) : null}
              {item.status === "published" && item.apply_mode === "manual" ? (
                <p className="mt-2 text-xs text-gray-400">
                  You applied this one by hand, so we can&apos;t roll it back for you. We&apos;ll confirm it on the next site check.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
