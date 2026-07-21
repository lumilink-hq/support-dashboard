import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { StatusBadge, FlagChip, ChannelBadge } from "@/components/status-badge";
import { OrderPanel } from "@/components/order-panel";
import { formatDateTime, humanize } from "@/lib/format";
import type { ConversationRow, MessageRow, OrderRow } from "@/lib/types";

const ROLE_LABEL: Record<MessageRow["role"], string> = {
  customer: "Customer",
  agent: "Agent",
  human: "Human",
};

function MessageBubble({ message }: { message: MessageRow }) {
  const isCustomer = message.role === "customer";
  return (
    <div className={`flex ${isCustomer ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 ${
          isCustomer
            ? "bg-white text-gray-900 ring-1 ring-gray-200"
            : message.role === "human"
              ? "bg-emerald-600 text-white"
              : "bg-gray-900 text-white"
        }`}
      >
        <div
          className={`mb-0.5 flex items-center gap-2 text-xs ${
            isCustomer ? "text-gray-400" : "text-white/60"
          }`}
        >
          <span className="font-medium">{ROLE_LABEL[message.role]}</span>
          {message.model ? <span>· {message.model}</span> : null}
          <span>· {formatDateTime(message.created_at)}</span>
        </div>
        {message.body ? (
          <p className="whitespace-pre-wrap text-sm">{message.body}</p>
        ) : null}
        {message.audio_url ? (
          <audio
            controls
            preload="none"
            src={message.audio_url}
            className="mt-2 w-64 max-w-full"
          />
        ) : null}
      </div>
    </div>
  );
}

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: conv } = await supabase
    .from("conversations")
    .select(
      "id, channel, customer_name, customer_identifier, subject, status, flagged, flag_reason, order_number, last_message_at, created_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (!conv) {
    notFound();
  }
  const conversation = conv as ConversationRow;
  const isVoice = conversation.channel === "voice";

  const { data: messageData } = await supabase
    .from("messages")
    .select("id, role, body, audio_url, model, created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });
  const messages = (messageData ?? []) as MessageRow[];

  let order: OrderRow | null = null;
  if (conversation.order_number) {
    const { data: orderData } = await supabase
      .from("orders_cache")
      .select(
        "order_number, store_platform, store_status, is_abnormal, customer_name, customer_email, currency, order_total, order_placed_at, line_items, tracking_number, carrier, shipping_status, shipped_at, estimated_delivery, fetched_at",
      )
      .eq("order_number", conversation.order_number)
      .maybeSingle();
    order = (orderData as OrderRow | null) ?? null;
  }

  // Voice calls have no subject; give the thread a sensible title.
  const title =
    conversation.subject ||
    (isVoice
      ? `Call with ${conversation.customer_name || conversation.customer_identifier || "caller"}`
      : "(no subject)");

  const emptyLabel = isVoice
    ? "No transcript for this call yet."
    : "No messages in this thread.";

  return (
    <div>
      <Link
        href="/conversations"
        className="text-sm text-gray-500 hover:text-gray-900"
      >
        ← Conversations
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ChannelBadge channel={conversation.channel} />
        <h1 className="text-lg font-semibold text-gray-900">{title}</h1>
        <StatusBadge status={conversation.status} />
        {conversation.flagged ? (
          <FlagChip reason={conversation.flag_reason} />
        ) : null}
      </div>
      <p className="mt-1 text-sm text-gray-500">
        {conversation.customer_name || "Unknown"}
        {conversation.customer_identifier
          ? ` · ${conversation.customer_identifier}`
          : ""}{" "}
        · <span className="capitalize">{humanize(conversation.channel)}</span>
      </p>

      <div className="mt-6 flex flex-col gap-6 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-3">
          {messages.length === 0 ? (
            <p className="text-sm text-gray-400">{emptyLabel}</p>
          ) : (
            messages.map((m) => <MessageBubble key={m.id} message={m} />)
          )}
        </div>

        <OrderPanel order={order} orderNumber={conversation.order_number} />
      </div>
    </div>
  );
}
