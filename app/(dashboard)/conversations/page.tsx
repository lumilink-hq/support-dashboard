import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { StatusBadge, FlagChip } from "@/components/status-badge";
import { timeAgo } from "@/lib/format";
import type { ConversationRow } from "@/lib/types";

export default async function ConversationsPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("conversations")
    .select(
      "id, channel, customer_name, customer_identifier, subject, status, flagged, flag_reason, order_number, last_message_at, created_at",
    )
    .order("last_message_at", { ascending: false, nullsFirst: false });

  const conversations = (data ?? []) as ConversationRow[];

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Conversations</h1>
        <span className="text-sm text-gray-500">
          {conversations.length} {conversations.length === 1 ? "thread" : "threads"}
        </span>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Email threads handled by the agent, newest activity first.
      </p>

      {error ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Couldn&apos;t load conversations: {error.message}
        </div>
      ) : conversations.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-400">
          No conversations yet.
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-200 bg-white">
          {conversations.map((c) => (
            <li key={c.id}>
              <Link
                href={`/conversations/${c.id}`}
                className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-gray-900">
                      {c.customer_name || c.customer_identifier || "Unknown sender"}
                    </span>
                    {c.flagged ? <FlagChip reason={c.flag_reason} /> : null}
                  </div>
                  <div className="truncate text-sm text-gray-500">
                    {c.subject || "(no subject)"}
                  </div>
                </div>

                <div className="hidden w-24 shrink-0 text-sm text-gray-500 sm:block">
                  {c.order_number ? (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600">
                      #{c.order_number}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">no order</span>
                  )}
                </div>

                <div className="w-32 shrink-0">
                  <StatusBadge status={c.status} />
                </div>

                <div className="w-20 shrink-0 text-right text-xs text-gray-400">
                  {timeAgo(c.last_message_at ?? c.created_at)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
