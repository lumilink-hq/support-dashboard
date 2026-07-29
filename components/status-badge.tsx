import { humanize } from "@/lib/format";

const STATUS_STYLES: Record<string, string> = {
  open: "bg-blue-50 text-blue-700",
  awaiting_customer: "bg-amber-50 text-amber-700",
  flagged: "bg-red-50 text-red-700",
  resolved: "bg-green-50 text-green-700",
  closed: "bg-gray-100 text-gray-600",
};

export function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? "bg-gray-100 text-gray-600";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${cls}`}
    >
      {humanize(status)}
    </span>
  );
}

// Reasons that aren't failures. A caller asking for a human is a normal
// outcome, so it gets a neutral chip — a red ⚑ next to every callback ticket
// trains the client to ignore red.
const REASON_STYLES: Record<string, { cls: string; icon: string }> = {
  callback_request: { cls: "bg-violet-50 text-violet-700", icon: "☎" },
  caller_request: { cls: "bg-violet-50 text-violet-700", icon: "☎" },
};

export function FlagChip({ reason }: { reason: string | null }) {
  const style = reason ? REASON_STYLES[reason] : undefined;
  const cls = style?.cls ?? "bg-red-50 text-red-700";
  const icon = style?.icon ?? "⚑";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${cls}`}
    >
      <span aria-hidden>{icon}</span>
      {humanize(reason) || "flagged"}
    </span>
  );
}

// The reference the caller was read out loud. Monospace so digits are easy to
// match against what someone quotes down the phone.
export function TicketNoChip({ ticketNo }: { ticketNo: number | null }) {
  if (ticketNo == null) return null;
  return (
    <span className="inline-flex items-center rounded-full bg-gray-900 px-2 py-0.5 font-mono text-xs font-medium text-white">
      #{ticketNo}
    </span>
  );
}

const CALLBACK_STYLES: Record<string, string> = {
  scheduled: "bg-amber-50 text-amber-700",
  attempted: "bg-blue-50 text-blue-700",
  completed: "bg-green-50 text-green-700",
  failed: "bg-red-50 text-red-700",
};

export function CallbackStatusBadge({
  status,
  attempts,
}: {
  status: string;
  attempts?: number;
}) {
  // 'none' means no callback was requested — nothing to show.
  if (!status || status === "none") return null;
  const cls = CALLBACK_STYLES[status] ?? "bg-gray-100 text-gray-600";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${cls}`}
    >
      {humanize(status)}
      {attempts && attempts > 0 ? (
        <span className="font-normal opacity-70">
          ·{" "}
          {attempts === 1 ? "1 attempt" : `${attempts} attempts`}
        </span>
      ) : null}
    </span>
  );
}

export function OverdueChip() {
  return (
    <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
      Overdue
    </span>
  );
}

const PRIORITY_STYLES: Record<string, string> = {
  high: "bg-orange-50 text-orange-700",
  urgent: "bg-red-50 text-red-700",
};

export function PriorityChip({ priority }: { priority: string }) {
  // low/normal are the default state and would just add noise.
  const cls = PRIORITY_STYLES[priority];
  if (!cls) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${cls}`}
    >
      {humanize(priority)}
    </span>
  );
}

// Channel indicator for the unified inbox (email + voice share the same tables).
export function ChannelBadge({ channel }: { channel: string }) {
  const isVoice = channel === "voice";
  const cls = isVoice
    ? "bg-violet-50 text-violet-700"
    : "bg-blue-50 text-blue-700";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${cls}`}
    >
      <span aria-hidden>{isVoice ? "☎" : "✉"}</span>
      {isVoice ? "Voice" : "Email"}
    </span>
  );
}

const APPT_STATUS_STYLES: Record<string, string> = {
  booked: "bg-blue-50 text-blue-700",
  confirmed: "bg-green-50 text-green-700",
  rescheduled: "bg-amber-50 text-amber-700",
  cancelled: "bg-gray-100 text-gray-500",
  completed: "bg-green-50 text-green-700",
  no_show: "bg-red-50 text-red-700",
};

export function ApptStatusBadge({ status }: { status: string }) {
  const cls = APPT_STATUS_STYLES[status] ?? "bg-gray-100 text-gray-600";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${cls}`}
    >
      {humanize(status)}
    </span>
  );
}

export function EmergencyChip() {
  return (
    <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
      🔥 Emergency
    </span>
  );
}
