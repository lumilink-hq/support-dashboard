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

export function FlagChip({ reason }: { reason: string | null }) {
  return (
    <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
      ⚑ {humanize(reason) || "flagged"}
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
