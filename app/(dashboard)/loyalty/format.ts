// Small display helpers for the LL Loyalty staff admin.

export function money(cents: number | null | undefined): string {
  const c = cents ?? 0;
  const s = (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return c < 0 ? `-$${s}` : `$${s}`;
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

/** A timestamp as a store-local date only ("Oct 20, 2026"); "—" when missing. */
export function dateOnly(iso: string | null | undefined, timeZone = "America/Los_Angeles"): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" });
}

/** A plain date (YYYY-MM-DD) as "Oct 20, 1990"; no time zone shift. */
export function day(date: string | null | undefined): string {
  if (!date) return "—";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "+12.5%" style, for rates stored as fractions (0.125). */
export function pct(rate: number | null | undefined, digits = 1): string {
  return rate === null || rate === undefined ? "—" : `${(rate * 100).toFixed(digits)}%`;
}

export const PERIODS = { "30": 30, "90": 90, "365": 365 } as const;
export type PeriodKey = keyof typeof PERIODS;

/**
 * The last N days as a [from, to) pair of store-local dates, ending today
 * (inclusive), which is what loyalty_insights takes.
 */
export function period(key: string | undefined, timeZone = "America/Los_Angeles"): { key: PeriodKey; from: string; to: string } {
  const k = (key && key in PERIODS ? key : "90") as PeriodKey;
  const today = new Date().toLocaleDateString("en-CA", { timeZone }); // YYYY-MM-DD
  const end = new Date(`${today}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - PERIODS[k]);
  return { key: k, from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
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
