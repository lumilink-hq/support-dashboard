import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  FlagChip,
  TicketNoChip,
  CallbackStatusBadge,
  OverdueChip,
  PriorityChip,
} from "@/components/status-badge";
import { humanize, timeAgo, formatDateTime } from "@/lib/format";
import { resolveItem, dismissItem, reopenItem, recordCallback } from "./actions";
import type { ReviewItemRow, CallbackDueRow } from "@/lib/types";

const FILTERS = [
  "pending",
  "callbacks",
  "resolved",
  "dismissed",
  "all",
] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABELS: Record<Filter, string> = {
  pending: "Pending",
  callbacks: "Callbacks due",
  resolved: "Resolved",
  dismissed: "Dismissed",
  all: "All",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700",
  resolved: "bg-green-50 text-green-700",
  dismissed: "bg-gray-100 text-gray-500",
};

// review_queue columns, including everything 0014 added.
const REVIEW_COLUMNS =
  "id, reason, details, status, created_at, resolved_at, conversation_id, " +
  "ticket_no, priority, channel, callback_number, callback_window, " +
  "callback_due_at, callback_status, callback_attempts, last_attempt_at, " +
  "conversations(id, customer_name, customer_identifier, subject, order_number, status)";

// Strip formatting so the href is dialable; keep a leading +.
function telHref(number: string): string {
  const cleaned = number.replace(/[^\d+]/g, "");
  return `tel:${cleaned.startsWith("+") ? "+" : ""}${cleaned.replace(/\+/g, "")}`;
}

function CallbackNumberLink({ number }: { number: string | null }) {
  if (!number) {
    return (
      <span className="text-sm text-gray-400">No callback number captured</span>
    );
  }
  return (
    <a
      href={telHref(number)}
      className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-2.5 py-1 font-mono text-sm font-medium text-white hover:bg-gray-800"
    >
      <span aria-hidden>☎</span>
      {number}
    </a>
  );
}

/**
 * The three outcome buttons. `filter` rides along as a hidden field so the
 * action can redirect back to the tab the user was actually on.
 */
function CallbackActions({
  ticketId,
  filter,
}: {
  ticketId: string;
  filter: Filter;
}) {
  const buttons: Array<{ outcome: string; label: string; cls: string }> = [
    {
      outcome: "completed",
      label: "Reached them",
      cls: "bg-green-700 text-white hover:bg-green-800",
    },
    {
      outcome: "attempted",
      label: "No answer",
      cls: "border border-gray-300 text-gray-700 hover:bg-gray-100",
    },
    {
      outcome: "failed",
      label: "Can't reach",
      cls: "border border-gray-300 text-gray-700 hover:bg-gray-100",
    },
  ];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
      <span className="text-xs font-medium text-gray-500">Log callback:</span>
      {buttons.map((b) => (
        <form key={b.outcome} action={recordCallback}>
          <input type="hidden" name="id" value={ticketId} />
          <input type="hidden" name="filter" value={filter} />
          <input type="hidden" name="outcome" value={b.outcome} />
          <button
            type="submit"
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${b.cls}`}
          >
            {b.label}
          </button>
        </form>
      ))}
    </div>
  );
}

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const { status, error: actionError } = await searchParams;
  const active: Filter = (FILTERS as readonly string[]).includes(status ?? "")
    ? (status as Filter)
    : "pending";

  const supabase = await createClient();

  // The callbacks tab reads the dedicated view: it already filters to pending
  // tickets awaiting a call and computes `overdue` in SQL. It's security_invoker,
  // so RLS still applies.
  const isCallbacks = active === "callbacks";

  const { data, error } = isCallbacks
    ? await supabase
        .from("callbacks_due")
        .select("*")
        // Soonest due first — that's the work order.
        .order("callback_due_at", { ascending: true, nullsFirst: false })
    : await (async () => {
        let q = supabase
          .from("review_queue")
          .select(REVIEW_COLUMNS)
          // Oldest first: the most overdue item sits at the top of the queue.
          .order("created_at", { ascending: true });
        if (active !== "all") q = q.eq("status", active);
        return q;
      })();

  const items = (data ?? []) as unknown as ReviewItemRow[] | CallbackDueRow[];

  // Badge the tab so an overdue callback is visible from any other tab.
  const { count: callbacksCount } = await supabase
    .from("callbacks_due")
    .select("id", { count: "exact", head: true });

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Review Queue</h1>
        <span className="text-sm text-gray-500">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Items the agent flagged for a human — flagged orders, plus callbacks
        requested by phone callers.
      </p>

      <div className="mt-4 flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={`/review-queue?status=${f}`}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${
              active === f
                ? "bg-gray-900 text-white"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            {FILTER_LABELS[f]}
            {f === "callbacks" && (callbacksCount ?? 0) > 0 ? (
              <span
                className={`rounded-full px-1.5 text-xs ${
                  active === f ? "bg-white text-gray-900" : "bg-gray-200"
                }`}
              >
                {callbacksCount}
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
          Couldn&apos;t load the queue: {error.message}
        </div>
      ) : items.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-400">
          {isCallbacks
            ? "No callbacks waiting."
            : `Nothing ${active === "all" ? "in the queue" : active}.`}
        </div>
      ) : isCallbacks ? (
        <ul className="mt-6 space-y-3">
          {(items as CallbackDueRow[]).map((item) => (
            <li
              key={item.id}
              className={`rounded-lg border bg-white p-4 ${
                item.overdue ? "border-red-300" : "border-gray-200"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <TicketNoChip ticketNo={item.ticket_no} />
                <CallbackStatusBadge
                  status={item.callback_status}
                  attempts={item.callback_attempts}
                />
                <PriorityChip priority={item.priority} />
                {item.overdue ? <OverdueChip /> : null}
                <span className="ml-auto text-xs text-gray-400">
                  due {formatDateTime(item.callback_due_at)}
                </span>
              </div>

              <div className="mt-3">
                <CallbackNumberLink number={item.callback_number} />
                {item.callback_window ? (
                  <span className="ml-2 text-sm text-gray-600">
                    prefers{" "}
                    <span className="font-medium">{item.callback_window}</span>
                  </span>
                ) : null}
              </div>

              {item.details ? (
                <p className="mt-2 text-sm text-gray-700">{item.details}</p>
              ) : null}

              {item.conversation_id ? (
                <Link
                  href={`/conversations/${item.conversation_id}`}
                  className="mt-2 flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900"
                >
                  <span className="truncate">
                    {item.customer_name || "Unknown caller"}
                  </span>
                  {item.order_number ? (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600">
                      #{item.order_number}
                    </span>
                  ) : null}
                  <span aria-hidden>→</span>
                </Link>
              ) : null}

              <CallbackActions ticketId={item.id} filter={active} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mt-6 space-y-3">
          {(items as ReviewItemRow[]).map((item) => {
            const conv = item.conversations;
            const hasCallback =
              item.callback_status && item.callback_status !== "none";
            return (
              <li
                key={item.id}
                className="rounded-lg border border-gray-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <TicketNoChip ticketNo={item.ticket_no} />
                  <FlagChip reason={item.reason} />
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                      STATUS_BADGE[item.status] ?? "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {humanize(item.status)}
                  </span>
                  <CallbackStatusBadge
                    status={item.callback_status}
                    attempts={item.callback_attempts}
                  />
                  <PriorityChip priority={item.priority} />
                  <span className="ml-auto text-xs text-gray-400">
                    {timeAgo(item.created_at)}
                  </span>
                </div>

                {item.details ? (
                  <p className="mt-2 text-sm text-gray-700">{item.details}</p>
                ) : null}

                {hasCallback ? (
                  <div className="mt-3">
                    <CallbackNumberLink number={item.callback_number} />
                    {item.callback_window ? (
                      <span className="ml-2 text-sm text-gray-600">
                        prefers{" "}
                        <span className="font-medium">
                          {item.callback_window}
                        </span>
                      </span>
                    ) : null}
                  </div>
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

                {hasCallback && item.status === "pending" ? (
                  <CallbackActions ticketId={item.id} filter={active} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
