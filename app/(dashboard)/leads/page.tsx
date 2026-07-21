import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ChannelBadge } from "@/components/status-badge";
import { timeAgo } from "@/lib/format";
import type { ConversationRow } from "@/lib/types";

export default async function LeadsPage() {
  const supabase = await createClient();

  // Calls the agent couldn't book but captured for follow-up.
  const { data, error } = await supabase
    .from("conversations")
    .select(
      "id, channel, customer_name, customer_identifier, subject, status, flagged, flag_reason, order_number, booking_outcome, last_message_at, created_at",
    )
    .eq("booking_outcome", "lead_only")
    .order("last_message_at", { ascending: false, nullsFirst: false });

  const leads = (data ?? []) as ConversationRow[];

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Leads</h1>
        <span className="text-sm text-gray-500">
          {leads.length} to follow up
        </span>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Callers the agent couldn&apos;t book but captured — a team member should
        follow up.
      </p>

      {error ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Couldn&apos;t load leads: {error.message}
        </div>
      ) : leads.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-400">
          No open leads — every captured call was booked.
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-200 bg-white">
          {leads.map((c) => (
            <li key={c.id}>
              <Link
                href={`/conversations/${c.id}`}
                className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <ChannelBadge channel={c.channel} />
                    <span className="truncate text-sm font-medium text-gray-900">
                      {c.customer_name || c.customer_identifier || "Unknown caller"}
                    </span>
                  </div>
                  {c.customer_identifier && c.customer_name ? (
                    <div className="truncate text-sm text-gray-500">
                      {c.customer_identifier}
                    </div>
                  ) : null}
                </div>
                <div className="w-24 shrink-0 text-right text-xs text-gray-400">
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
