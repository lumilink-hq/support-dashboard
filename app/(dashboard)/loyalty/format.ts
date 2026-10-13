// Small display helpers for the LL Loyalty staff admin.

export function money(cents: number | null | undefined): string {
  return `$${((cents ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function num(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

/** A timestamp in the store's time zone; "—" when missing. */
export function when(iso: string | null | undefined, timeZone = "America/Los_Angeles"): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A plain date (YYYY-MM-DD) as "Oct 20, 1990"; no time zone shift. */
export function day(date: string | null | undefined): string {
  if (!date) return "—";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export const REASON_LABEL: Record<string, string> = {
  order: "Order",
  refund: "Refund",
  action: "Bonus",
  milestone: "Milestone",
  referral: "Referral",
  redeem: "Redeemed",
  redeem_reversal: "Redeem refunded",
  expire: "Expired",
  adjust: "Staff adjustment",
  import: "Imported",
};
