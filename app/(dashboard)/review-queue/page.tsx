import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { FlagChip } from "@/components/status-badge";
import { humanize, timeAgo } from "@/lib/format";
import { resolveItem, dismissItem, reopenItem } from "./actions";
import type { ReviewItemRow } from "@/lib/types";

const FILTERS = ["pending", "resolved", "dismissed", "all"] as const;
type Filter = (typeof FILTERS)[number];

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700",
  resolved: "bg-green-50 text-green-700",
  dismissed: "bg-gray-100 text-gray-500",
};

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const active: Filter = (FILTERS as readonly string[]).includes(status ?? "")
    ? (status as Filter)
    : "pending";

  const supabase = await createClient();

  let query = supabase
    .from("review_queue")
    .select(
      "id, reason, details, status, created_at, resolved_at, conversation_id, conversations(id, customer_name, customer_identifier, subject, order_number, status)",
    )
    // Oldest first: the most overdue item sits at the top of the queue.
    .order("created_at", { ascending: true });

  if (active !== "all") {
    query = query.eq("status", active);
  }

  const { data, error } = await query;
  const items = (data ?? []) as unknown as ReviewItemRow[];

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Review Queue</h1>
        <span className="text-sm text-gray-500">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Items the agent flagged for a human — orders older than 24h or in an
        abnormal status.
      </p>

      <div className="mt-4 flex gap-1">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={`/review-queue?status=${f}`}
            className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize ${
              active === f
                ? "bg-gray-900 text-white"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            {f}
          </Link>
        ))}
      </div>

      {error ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Couldn&apos;t load the queue: {error.message}
        </div>
      ) : items.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-400">
          Nothing {active === "all" ? "in the queue" : active}.
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((item) => {
            const conv = item.conversations;
            return (
              <li
                key={item.id}
                className="rounded-lg border border-gray-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <FlagChip reason={item.reason} />
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                      STATUS_BADGE[item.status] ?? "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {humanize(item.status)}
                  </span>
                  <span className="ml-auto text-xs text-gray-400">
                    {timeAgo(item.created_at)}
                  </span>
                </div>

                {item.details ? (
                  <p className="mt-2 text-sm text-gray-700">{item.details}</p>
                ) : null}

                {conv ? (
                  <Link
                    href={`/conversations/${conv.id}`}
                    className="mt-2 flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900"
                  >
                    <span className="truncate">
                      {conv.customer_name ||
                        conv.customer_identifier ||
                        "Unknown sender"}
                      {conv.subject ? ` · ${conv.subject}` : ""}
                    </span>
                    {conv.order_number ? (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600">
                        #{conv.order_number}
                      </span>
                    ) : null}
                    <span aria-hidden>→</span>
                  </Link>
                ) : (
                  <p className="mt-2 text-sm text-gray-400">
                    No linked conversation.
                  </p>
                )}

                <div className="mt-3 flex gap-2">
                  {item.status === "pending" ? (
                    <>
                      <form action={resolveItem}>
                        <input type="hidden" name="id" value={item.id} />
                        <button
                          type="submit"
                          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800"
                        >
                          Resolve
                        </button>
                      </form>
                      <form action={dismissItem}>
                        <input type="hidden" name="id" value={item.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
                        >
                          Dismiss
                        </button>
                      </form>
                    </>
                  ) : (
                    <form action={reopenItem}>
                      <input type="hidden" name="id" value={item.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
                      >
                        Reopen
                      </button>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
