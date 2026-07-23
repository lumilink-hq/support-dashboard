// Business timezone used for all human-facing timestamps.
// Server components render on the server (UTC), so we must format explicitly
// in the business's timezone or wall-clock times come out 7-8h ahead.
// Override with NEXT_PUBLIC_BUSINESS_TIMEZONE if the business relocates.
const BUSINESS_TZ =
  process.env.NEXT_PUBLIC_BUSINESS_TIMEZONE || "America/Los_Angeles";

export function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { timeZone: BUSINESS_TZ });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { timeZone: BUSINESS_TZ });
}

export function formatMoney(
  total: number | string | null,
  currency: string | null,
): string {
  if (total == null) return "—";
  const n = typeof total === "string" ? Number(total) : total;
  if (Number.isNaN(n)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(n);
  } catch {
    return `${n} ${currency ?? ""}`.trim();
  }
}

export function humanize(value: string | null): string {
  if (!value) return "—";
  return value.replace(/_/g, " ");
}
