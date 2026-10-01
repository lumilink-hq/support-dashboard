// Turning stored Search Console rows into what the portal and the monthly report
// show (module 21): the headline period, matched-period comparisons, stat tiles,
// traffic value, the headline sentence and the CTR upside model.
//
// Pure: no network, no database, no Deno APIs. The portal (Next.js) and
// seo-report (Deno) both import it, so the two can never word or count a number
// differently. Tested by scripts/test-seo-search-console.ts.
//
// RULES THIS FILE ENFORCES
//   * Comparisons are matched periods only: Sep 1-28 against Sep 1-28. A
//     comparison period with any day missing gives no comparison, never a
//     partial one.
//   * No forecasting. A month in progress is shown as "so far", never
//     extrapolated to a month-end estimate.
//   * Keyword counts compare complete months only.
//   * No search data -> the caller gets nulls, never zeros.
//   * Sentences are chosen by rules from these numbers. No model is involved
//     (rule 5), so nothing can be invented.

// No imports on purpose: the portal (Next.js) imports this file, and Next's
// TypeScript config rejects the ".ts" import paths Deno needs.

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/** First day of the month containing `iso`. */
export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** Last day of the month containing `iso`. */
export function monthEnd(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return isoDate(new Date(Date.UTC(y, m, 0)));
}

/** The month `n` months after the one containing `iso` (negative goes back), as its first day. */
export function addMonths(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + n;
  return isoDate(new Date(Date.UTC(y, m, 1)));
}

/** Every month (first day) from the month of `start` to the month of `end`, inclusive. */
export function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let m = monthStart(start); m <= end; m = addMonths(m, 1)) out.push(m);
  return out;
}

// -----------------------------------------------------------------------------
// Page URLs
// -----------------------------------------------------------------------------

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|ref|srsltid)$/i;

/**
 * One page, one row. Drops the scheme, a leading "www.", tracking parameters
 * (utm_*, gclid, ...), the fragment and a trailing slash, and lowercases the host.
 * The path keeps its case (paths are case-sensitive on most servers). Returns
 * the input trimmed if it isn't a URL at all.
 *   https://www.packsclub.com/menu/sgv/?utm_source=gmb  ->  packsclub.com/menu/sgv
 */
export function normalisePageUrl(raw: string): string {
  const s = raw.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return s;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k));
  kept.sort(([a], [b]) => a.localeCompare(b));
  const qs = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
  let path = u.pathname;
  try {
    path = decodeURI(path);
  } catch {
    // keep it encoded if it doesn't decode cleanly
  }
  path = path.replace(/\/+$/, "");
  return `${host}${path}${qs}`;
}


export type DayTotal = { date: string; clicks: number; impressions: number; position: number | null };
export type KeywordCountRow = { month: string; total: number; page_one: number; top_three: number; is_complete: boolean };
export type Compare = "yoy" | "mom";

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// -----------------------------------------------------------------------------
// Formatting (shared so the PDF and the page print the same strings)
// -----------------------------------------------------------------------------

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtMoney(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

export function fmtPct(fraction: number, places = 2): string {
  return `${(fraction * 100).toFixed(places)}%`;
}

export function monthLabel(month: string, long = false): string {
  const m = Number(month.slice(5, 7)) - 1;
  return long ? `${MONTHS_LONG[m]} ${month.slice(0, 4)}` : `${MONTHS_SHORT[m]} '${month.slice(2, 4)}`;
}

/** "Sep 1–28", or "Sep 1–28, 2025" with the year. A whole month is just "September 2026". */
export function rangeLabel(start: string, end: string, withYear = false): string {
  if (start === monthStart(start) && end === monthEnd(start)) return monthLabel(start, true);
  const m = MONTHS_SHORT[Number(start.slice(5, 7)) - 1];
  const d1 = Number(start.slice(8));
  const d2 = Number(end.slice(8));
  const days = d1 === d2 ? `${d1}` : `${d1}–${d2}`;
  return `${m} ${days}${withYear ? `, ${start.slice(0, 4)}` : ""}`;
}

/** "Sep 28, 2026". */
export function dayLabel(iso: string): string {
  return `${MONTHS_SHORT[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8))}, ${iso.slice(0, 4)}`;
}

export function perClickLabel(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function daysInclusive(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

// -----------------------------------------------------------------------------
// Periods
// -----------------------------------------------------------------------------

export type Period = {
  month: string;    // first day of the month
  start: string;
  end: string;
  complete: boolean;
  label: string;    // "September 2026"
  range: string;    // "Sep 1–28" or "September 2026"
};

/** The month `month` as far as data goes (through `dataThrough`). Null if no day of it is held. */
export function periodForMonth(month: string, dataThrough: string): Period | null {
  const start = monthStart(month);
  if (dataThrough < start) return null;
  const last = monthEnd(start);
  const end = last <= dataThrough ? last : dataThrough;
  return { month: start, start, end, complete: end === last, label: monthLabel(start, true), range: rangeLabel(start, end) };
}

/**
 * Which month the portal leads with. The month the data runs into, so far; but
 * in its first week (fewer than 7 days held), the month before, complete: a
 * 3-day "month so far" is too noisy to lead with.
 */
export function headlinePeriod(dataThrough: string): Period {
  const current = periodForMonth(dataThrough, dataThrough)!;
  if (current.complete || Number(dataThrough.slice(8)) >= 7) return current;
  return periodForMonth(addMonths(dataThrough, -1), dataThrough)!;
}

/**
 * The matched period to compare against: the same days of the previous month
 * or of the same month last year. A complete month compares with the whole
 * other month; a partial one with the same day numbers, cut at that month's end
 * (Mar 1–30 against Feb 1–28).
 */
export function comparisonRange(p: Period, compare: Compare): { start: string; end: string } {
  const m = addMonths(p.month, compare === "yoy" ? -12 : -1);
  if (p.complete) return { start: m, end: monthEnd(m) };
  const end = addDays(m, Number(p.end.slice(8)) - 1);
  return { start: m, end: end <= monthEnd(m) ? end : monthEnd(m) };
}

// -----------------------------------------------------------------------------
// Sums
// -----------------------------------------------------------------------------

export type Totals = { clicks: number; impressions: number; ctr: number | null; position: number | null; days: number; expected: number };

export function sumRange(days: DayTotal[], start: string, end: string): Totals {
  let clicks = 0, impressions = 0, posW = 0, n = 0;
  for (const d of days) {
    if (d.date < start || d.date > end) continue;
    clicks += d.clicks;
    impressions += d.impressions;
    if (d.position !== null) posW += d.position * d.impressions;
    n++;
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    position: impressions > 0 ? Math.round((posW / impressions) * 10) / 10 : null,
    days: n,
    expected: daysInclusive(start, end),
  };
}

/** Whether every day of a range is held: a comparison needs full coverage on both sides. */
export function covered(t: Totals): boolean {
  return t.days === t.expected;
}

export type MonthPoint = { month: string; clicks: number; impressions: number; days: number; complete: boolean };

/** Daily totals grouped by month, oldest first. `complete` = every day of the month is held. */
export function monthlyTotals(days: DayTotal[]): MonthPoint[] {
  const acc = new Map<string, MonthPoint>();
  for (const d of days) {
    const m = monthStart(d.date);
    const p = acc.get(m) ?? { month: m, clicks: 0, impressions: 0, days: 0, complete: false };
    p.clicks += d.clicks;
    p.impressions += d.impressions;
    p.days++;
    acc.set(m, p);
  }
  return [...acc.values()]
    .map((p) => ({ ...p, complete: p.days === daysInclusive(p.month, monthEnd(p.month)) }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

// -----------------------------------------------------------------------------
// Tiles
// -----------------------------------------------------------------------------

export type Delta = {
  /** Percent change, or percentage points for a rate (unit 'pp'). Rounded to 0.1. */
  change: number;
  unit: "pct" | "pp";
  /** The value compared against, in the tile's own format. */
  before: string;
  /** "Sep 1–28, 2025". */
  against: string;
};

export type TileKind = "traffic" | "keywords" | "value";

export type Tile = {
  key: "clicks" | "impressions" | "ctr" | "keywords" | "page_one" | "top_three" | "value_month" | "value_year";
  label: string;
  kind: TileKind;
  /** What the number covers: "Sep 1–28", "August 2026 · complete month", ... */
  period: string;
  value: string;
  raw: number;
  yoy: Delta | null;
  mom: Delta | null;
  /** Up to 12 complete months, oldest first, for the sparkline. */
  spark: number[];
  note?: string;
  /** True for a tile that is never compared (the rolling year): show no comparison line. */
  noCompare?: boolean;
};

function pctDelta(now: number, before: number, beforeText: string, against: string): Delta | null {
  if (before <= 0) return null;
  return { change: Math.round(((now - before) / before) * 1000) / 10, unit: "pct", before: beforeText, against };
}

function trafficTiles(days: DayTotal[], p: Period, months: MonthPoint[]): Tile[] {
  const now = sumRange(days, p.start, p.end);
  const cmp = (c: Compare) => {
    const r = comparisonRange(p, c);
    const t = sumRange(days, r.start, r.end);
    return { t, ok: covered(t), label: rangeLabel(r.start, r.end, true) };
  };
  const yoy = cmp("yoy");
  const mom = cmp("mom");
  const spark = months.filter((m) => m.complete && m.month <= p.month).slice(-12);
  const ctrDelta = (c: ReturnType<typeof cmp>): Delta | null =>
    c.ok && now.ctr !== null && c.t.ctr !== null
      ? { change: Math.round((now.ctr - c.t.ctr) * 1000) / 10, unit: "pp", before: fmtPct(c.t.ctr), against: c.label }
      : null;
  return [
    {
      key: "clicks", label: "Clicks", kind: "traffic", period: p.range, value: fmtInt(now.clicks), raw: now.clicks,
      yoy: yoy.ok ? pctDelta(now.clicks, yoy.t.clicks, fmtInt(yoy.t.clicks), yoy.label) : null,
      mom: mom.ok ? pctDelta(now.clicks, mom.t.clicks, fmtInt(mom.t.clicks), mom.label) : null,
      spark: spark.map((m) => m.clicks),
    },
    {
      key: "impressions", label: "Impressions", kind: "traffic", period: p.range, value: fmtInt(now.impressions), raw: now.impressions,
      yoy: yoy.ok ? pctDelta(now.impressions, yoy.t.impressions, fmtInt(yoy.t.impressions), yoy.label) : null,
      mom: mom.ok ? pctDelta(now.impressions, mom.t.impressions, fmtInt(mom.t.impressions), mom.label) : null,
      spark: spark.map((m) => m.impressions),
    },
    {
      key: "ctr", label: "Click-through rate", kind: "traffic", period: p.range,
      value: now.ctr === null ? "–" : fmtPct(now.ctr), raw: now.ctr ?? 0,
      yoy: ctrDelta(yoy), mom: ctrDelta(mom),
      spark: spark.map((m) => (m.impressions > 0 ? m.clicks / m.impressions : 0)),
    },
  ];
}

/** The latest complete keyword-count month at or before `month`. */
export function keywordMonth(rows: KeywordCountRow[], month: string): KeywordCountRow | null {
  return rows.filter((r) => r.is_complete && r.month <= month).sort((a, b) => b.month.localeCompare(a.month))[0] ?? null;
}

function keywordTiles(rows: KeywordCountRow[], month: string): Tile[] {
  const k = keywordMonth(rows, month);
  if (!k) return [];
  const find = (m: string) => rows.find((r) => r.month === m && r.is_complete) ?? null;
  const ly = find(addMonths(k.month, -12));
  const lm = find(addMonths(k.month, -1));
  const spark = rows.filter((r) => r.is_complete && r.month <= k.month).sort((a, b) => a.month.localeCompare(b.month)).slice(-12);
  const period = `${monthLabel(k.month, true)} · complete month`;
  const mk = (key: "keywords" | "page_one" | "top_three", label: string, field: "total" | "page_one" | "top_three", note: string): Tile => ({
    key, label, kind: "keywords", period, value: fmtInt(k[field]), raw: k[field],
    yoy: ly ? pctDelta(k[field], ly[field], fmtInt(ly[field]), monthLabel(ly.month, true)) : null,
    mom: lm ? pctDelta(k[field], lm[field], fmtInt(lm[field]), monthLabel(lm.month, true)) : null,
    spark: spark.map((r) => r[field]),
    note,
  });
  return [
    mk("keywords", "Ranking keywords", "total", "Searches that showed your site at least once."),
    mk("page_one", "Page-one keywords", "page_one", "Searches where your site averaged position 10 or better."),
    mk("top_three", "Top-3 keywords", "top_three", "Searches where your site averaged position 3 or better."),
  ];
}

export type TrafficValue = {
  centsPerClick: number;
  period: { cents: number; clicks: number; label: string };
  /** The 365 days to the end of the data. `since` is set when fewer days are held. */
  year: { cents: number; clicks: number; label: string; start: string; end: string; since: string | null };
  /** Per month, for the bar chart: the last 12 months, the newest possibly partial. */
  months: { month: string; cents: number; partial: boolean }[];
};

export function trafficValue(days: DayTotal[], p: Period, months: MonthPoint[], centsPerClick: number): TrafficValue {
  const now = sumRange(days, p.start, p.end);
  const yStart = addDays(p.end, -364);
  const yr = sumRange(days, yStart, p.end);
  const first = days.map((d) => d.date).filter((d) => d >= yStart && d <= p.end).sort()[0] ?? null;
  const since = covered(yr) ? null : first;
  return {
    centsPerClick,
    period: { cents: now.clicks * centsPerClick, clicks: now.clicks, label: p.range },
    year: {
      cents: yr.clicks * centsPerClick,
      clicks: yr.clicks,
      label: `${dayLabel(since ?? yStart)} – ${dayLabel(p.end)}`,
      start: since ?? yStart,
      end: p.end,
      since,
    },
    months: months
      .filter((m) => m.month <= p.month)
      .slice(-12)
      .map((m) => ({ month: m.month, cents: m.clicks * centsPerClick, partial: !m.complete })),
  };
}

function valueTiles(v: TrafficValue, days: DayTotal[], p: Period, months: MonthPoint[]): Tile[] {
  const cmp = (c: Compare): Delta | null => {
    const r = comparisonRange(p, c);
    const t = sumRange(days, r.start, r.end);
    return covered(t) ? pctDelta(v.period.cents, t.clicks * v.centsPerClick, fmtMoney(t.clicks * v.centsPerClick), rangeLabel(r.start, r.end, true)) : null;
  };
  const spark = months.filter((m) => m.complete && m.month <= p.month).slice(-12).map((m) => m.clicks * v.centsPerClick);
  return [
    {
      key: "value_month", label: "Traffic value", kind: "value", period: p.range, value: fmtMoney(v.period.cents), raw: v.period.cents,
      yoy: cmp("yoy"), mom: cmp("mom"), spark,
      note: `${fmtInt(v.period.clicks)} clicks at ${perClickLabel(v.centsPerClick)} each. A replacement value, not revenue.`,
    },
    {
      key: "value_year", label: "Traffic value · 12 months", kind: "value", period: v.year.label, value: fmtMoney(v.year.cents), raw: v.year.cents,
      yoy: null, mom: null, spark, noCompare: true,
      note: v.year.since ? `Search Console data starts ${v.year.since}, so this covers less than a year.` : `${fmtInt(v.year.clicks)} clicks over the year.`,
    },
  ];
}

// -----------------------------------------------------------------------------
// Everything for one month, as stored in a report and shown on the portal
// -----------------------------------------------------------------------------

export type TopRow = { key: string; clicks: number; impressions: number; position: number | null };

export type SearchSummary = {
  site_url: string;
  data_through: string;
  period: Period;
  tiles: Tile[];
  value: TrafficValue;
  /** 16 months of clicks / impressions, oldest first, for the trend chart. */
  months: MonthPoint[];
  keyword_months: KeywordCountRow[];
  top_pages: TopRow[];
};

export function searchSummary(input: {
  siteUrl: string;
  days: DayTotal[];
  keywordRows: KeywordCountRow[];
  topPages: TopRow[];
  dataThrough: string;
  /** The month to report on. Omit for the portal's headline month. */
  month?: string;
  centsPerClick: number;
}): SearchSummary | null {
  const p = input.month ? periodForMonth(input.month, input.dataThrough) : headlinePeriod(input.dataThrough);
  if (!p) return null;
  const months = monthlyTotals(input.days);
  const value = trafficValue(input.days, p, months, input.centsPerClick);
  return {
    site_url: input.siteUrl,
    data_through: input.dataThrough,
    period: p,
    tiles: [
      ...trafficTiles(input.days, p, months),
      ...keywordTiles(input.keywordRows, p.month),
      ...valueTiles(value, input.days, p, months),
    ],
    value,
    months: months.filter((m) => m.month <= p.month),
    keyword_months: input.keywordRows.filter((r) => r.month <= p.month).sort((a, b) => a.month.localeCompare(b.month)),
    top_pages: input.topPages,
  };
}

// -----------------------------------------------------------------------------
// When there is no summary: why, in words (portal coverage line and report)
// -----------------------------------------------------------------------------

export type SearchState = "ok" | "not_set" | "pending" | "not_connected" | "no_access" | "error";

/** What the portal and the report say instead of numbers. Never zeros. */
export function searchStateMessage(state: SearchState, siteUrl: string | null, dataThrough: string | null): string {
  const last = dataThrough ? ` The last data we hold is for ${dayLabel(dataThrough)}.` : "";
  switch (state) {
    case "not_set":
      return "Search Console traffic isn't set up for this location yet: we need to know which Search Console property is its website.";
    case "pending":
      return `Search Console is set up (${siteUrl}). The first pull runs within a day and loads the last 16 months.`;
    case "not_connected":
      return `Google isn't connected with Search Console access, so clicks and impressions aren't available.${last}`;
    case "no_access":
      return `The connected Google account can't see the Search Console property ${siteUrl}. It needs to be a verified owner or user of that property.${last}`;
    case "error":
      return `The last Search Console pull failed; it is retried automatically.${last}`;
    case "ok":
      return dataThrough ? `Search Console data through ${dayLabel(dataThrough)}.` : "Search Console is connected but has no data for this site yet.";
  }
}

// -----------------------------------------------------------------------------
// The headline sentence
// -----------------------------------------------------------------------------

const AGAINST: Record<Compare, string> = { yoy: "last year", mom: "last month" };

/**
 * One sentence that states the period's result with its number in it, and a
 * short summary under it. Picked by rules from the tiles: clicks against the
 * chosen comparison; if that comparison isn't available, the other one; if
 * neither, the plain total.
 */
export function heroSentence(s: SearchSummary, compare: Compare): { headline: string; summary: string } {
  const clicks = s.tiles.find((t) => t.key === "clicks")!;
  const impressions = s.tiles.find((t) => t.key === "impressions")!;
  const which: Compare | null = clicks[compare] ? compare : clicks[compare === "yoy" ? "mom" : "yoy"] ? (compare === "yoy" ? "mom" : "yoy") : null;
  const lead = s.period.complete ? s.period.label : `${s.period.label} so far`;

  let headline: string;
  if (!which) {
    headline = `${lead}: ${clicks.value} clicks from Google search`;
  } else {
    const d = clicks[which]!;
    const size = Math.abs(d.change);
    headline =
      size < 2
        ? `${lead}: clicks level with ${AGAINST[which]}`
        : `${lead}: clicks ${d.change > 0 ? "up" : "down"} ${size.toFixed(1)}% on ${AGAINST[which]}`;
  }

  const parts = [`${clicks.value} clicks and ${impressions.value} impressions from Google search, ${s.period.range}.`];
  if (which) parts.push(`The same days ${AGAINST[which]} (${clicks[which]!.against}): ${clicks[which]!.before} clicks.`);
  const kw = s.tiles.find((t) => t.key === "keywords");
  if (kw) {
    const kd = kw[compare] ?? kw[compare === "yoy" ? "mom" : "yoy"];
    const kWhich = kw[compare] ? compare : compare === "yoy" ? "mom" : "yoy";
    parts.push(
      `${kw.value} searches showed your site in ${kw.period.replace(" · complete month", "")}` +
        (kd ? ` (${kd.change > 0 ? "+" : ""}${kd.change.toFixed(1)}% on ${AGAINST[kWhich]}).` : "."),
    );
  }
  return { headline, summary: parts.join(" ") };
}

// -----------------------------------------------------------------------------
// CTR upside (a sensitivity model, not a forecast)
// -----------------------------------------------------------------------------

export type Upside = { currentCtr: number | null; targetClicks: number; extraClicks: number; cents: number; extraCents: number };

/** Same impressions, a different click-through rate. Never annualised. */
export function ctrUpside(impressions: number, clicks: number, targetCtr: number, centsPerClick: number): Upside {
  const targetClicks = Math.round(impressions * targetCtr);
  const extra = Math.max(0, targetClicks - clicks);
  return {
    currentCtr: impressions > 0 ? clicks / impressions : null,
    targetClicks,
    extraClicks: extra,
    cents: targetClicks * centsPerClick,
    extraCents: extra * centsPerClick,
  };
}

// -----------------------------------------------------------------------------
// Chart markers
// -----------------------------------------------------------------------------

export type Marker = { month: string; label: string };

/**
 * Events to vertical markers on a monthly chart: only those inside the chart's
 * months, one per label (the earliest), at most one per month (the first, by
 * date, keeps the month; the rest join its label).
 */
export function markers(events: { date: string; label: string }[], months: string[]): Marker[] {
  if (months.length === 0) return [];
  const first = months[0];
  const last = months[months.length - 1];
  const seen = new Set<string>();
  const byMonth = new Map<string, string[]>();
  for (const e of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    const m = monthStart(e.date);
    if (m < first || m > last || seen.has(e.label)) continue;
    seen.add(e.label);
    byMonth.set(m, [...(byMonth.get(m) ?? []), e.label]);
  }
  return [...byMonth.entries()].map(([month, labels]) => ({ month, label: labels.join(" · ") })).sort((a, b) => a.month.localeCompare(b.month));
}
