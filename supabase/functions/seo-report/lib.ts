// Pure helpers for seo-report (module 13). No network, no Deno APIs, no database:
// the function fetches rows and hands them here, so all of this is unit-tested
// with scripts/test-seo-report.ts.

// -----------------------------------------------------------------------------
// Period
// -----------------------------------------------------------------------------

export type Period = { start: string; end: string; label: string };

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The calendar month (UTC) before `now`: the month a report on the 1st covers. */
export function previousMonth(now: Date): Period {
  return monthPeriod(now.getUTCFullYear(), now.getUTCMonth() - 1);
}

/** The month containing an ISO date ("2026-08-14"). Null if it isn't one. */
export function periodFromDate(iso: string): Period | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return monthPeriod(Number(m[1]), month - 1);
}

function monthPeriod(year: number, monthIndex: number): Period {
  // Date.UTC normalises a negative month into the previous year.
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth();
  return {
    start: `${y}-${pad(m + 1)}-01`,
    end: `${y}-${pad(m + 1)}-${pad(last.getUTCDate())}`,
    label: `${MONTHS[m]} ${y}`,
  };
}

/** The day after `end`, as ISO: the exclusive upper bound for timestamp filters. */
export function dayAfter(end: string): string {
  const d = new Date(`${end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// Rankings
// -----------------------------------------------------------------------------

export type RankRow = {
  keyword_id: string;
  rank_type: "organic" | "local_pack" | "geo_grid";
  position: number | null;
  check_date: string;
};

export type KeywordRank = {
  keyword: string;
  organic: { now: number | null; before: number | null; checked: boolean };
  local_pack: { now: number | null; before: number | null; checked: boolean };
};

/**
 * Per keyword: where it stood at the latest check inside the period ("now") and
 * at the latest check before the period began ("before"). `checked` says whether
 * there was a check at all: position null with checked true means "looked, and
 * not found", which is different from never looked.
 */
export function keywordRanks(
  keywords: { id: string; keyword: string }[],
  rows: RankRow[],
  period: Period,
): KeywordRank[] {
  const pick = (id: string, type: "organic" | "local_pack") => {
    let now: RankRow | null = null;
    let before: RankRow | null = null;
    for (const r of rows) {
      if (r.keyword_id !== id || r.rank_type !== type) continue;
      if (r.check_date >= period.start && r.check_date <= period.end) {
        if (!now || r.check_date > now.check_date) now = r;
      } else if (r.check_date < period.start) {
        if (!before || r.check_date > before.check_date) before = r;
      }
    }
    return { now: now?.position ?? null, before: before?.position ?? null, checked: now !== null };
  };
  return keywords
    .map((k) => ({ keyword: k.keyword, organic: pick(k.id, "organic"), local_pack: pick(k.id, "local_pack") }))
    .sort((a, b) => a.keyword.localeCompare(b.keyword));
}

export type RankSummary = { checked: number; ranked: number; top3: number; top10: number; avg_position: number | null };

export function summarise(positions: { now: number | null; checked: boolean }[]): RankSummary {
  const checked = positions.filter((p) => p.checked);
  const found = checked.filter((p) => p.now !== null).map((p) => p.now as number);
  return {
    checked: checked.length,
    ranked: found.length,
    top3: found.filter((p) => p <= 3).length,
    top10: found.filter((p) => p <= 10).length,
    avg_position: found.length ? Math.round((found.reduce((a, b) => a + b, 0) / found.length) * 10) / 10 : null,
  };
}

// -----------------------------------------------------------------------------
// Realistic radius
// -----------------------------------------------------------------------------

export type GeoRadiusRow = {
  keywords_checked: number;
  last_check_date: string;
  winnable_radius_km: number | null;
  grid_spacing_km: number;
};

export type Radius = {
  state: "measured" | "no_coordinates" | "no_geo_keywords" | "not_swept_yet";
  /** Only set when state is 'measured'. null = not winning even at the address. */
  km: number | null;
  keywords_checked: number;
  last_check_date: string | null;
  /** Ready to print, so the portal and the PDF word it identically. */
  statement: string;
};

/**
 * What the first report says about how far each location can realistically win.
 * Where there is nothing to derive it from, it says so plainly rather than
 * inventing a number: a radius needs coordinates, a geo-grid keyword and at
 * least one completed sweep.
 */
export function describeRadius(
  location: { lat: number | null; lng: number | null },
  geoKeywordCount: number,
  row: GeoRadiusRow | null,
): Radius {
  const none = { km: null, keywords_checked: 0, last_check_date: null };
  if (location.lat === null || location.lng === null) {
    return {
      state: "no_coordinates", ...none,
      statement:
        "We can't yet say how far this location can realistically win: it has no map coordinates on file, so the map-grid check hasn't run for it.",
    };
  }
  if (geoKeywordCount === 0) {
    return {
      state: "no_geo_keywords", ...none,
      statement:
        "We can't yet say how far this location can realistically win: none of its keywords is set up for the map-grid check.",
    };
  }
  if (!row) {
    return {
      state: "not_swept_yet", ...none,
      statement:
        "We can't yet say how far this location can realistically win: the map-grid check has not completed a sweep yet. It will be in next month's report.",
    };
  }
  const base = { state: "measured" as const, km: row.winnable_radius_km, keywords_checked: row.keywords_checked, last_check_date: row.last_check_date };
  const basis = `Based on the latest map-grid check of ${row.keywords_checked} keyword${row.keywords_checked === 1 ? "" : "s"} (${row.last_check_date}), counting a spot as won when you appear in the top 3 map results there.`;
  const km = row.winnable_radius_km;
  if (km === null) {
    return { ...base, statement: `Right now this location isn't reliably in the top 3 map results even at its own address. ${basis}` };
  }
  if (km === 0) {
    return { ...base, statement: `Right now this location wins at its own address but not beyond it. ${basis}` };
  }
  const whole = km >= row.grid_spacing_km * 2;
  return {
    ...base,
    statement: `Realistically, this location can win the top 3 map results within about ${km} km of it${whole ? ", across the whole area we check" : ""}. ${basis}`,
  };
}

// -----------------------------------------------------------------------------
// Work shipped and queued
// -----------------------------------------------------------------------------

export type ActionRow = {
  id: string;
  action_type: string;
  target_field: string | null;
  target_url: string | null;
  status: string;
  apply_mode: string | null;
  publish_result: { verified?: boolean } | null;
  proposed_value: { title?: string } | null;
  published_at: string | null;
  created_at: string;
};

const FIELD_LABELS: Record<string, string> = {
  title_tag: "Page title",
  meta_description: "Meta description",
  h1: "Main heading (H1)",
  local_business_schema: "LocalBusiness structured data",
  article: "Blog article",
};

export function fieldLabel(field: string | null): string {
  if (!field) return "Change";
  return FIELD_LABELS[field] ?? field.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export type ShippedItem = {
  label: string;
  detail: string | null;
  url: string | null;
  published_at: string;
  /** true only when LumiLink applied it and confirmed it landed. A change the
   * client applied by hand is a claim until the next site check, and is
   * reported as one. */
  verified: boolean;
};

export type QueuedItem = { label: string; detail: string | null; needs: "approval" | "you_to_apply" };

/** Only http(s) links are ever carried into a report. */
export function safeUrl(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

export function shippedItems(rows: ActionRow[], period: Period): ShippedItem[] {
  const until = dayAfter(period.end);
  return rows
    .filter((a) => a.status === "published" && a.published_at && a.published_at >= period.start && a.published_at < until)
    .sort((a, b) => (a.published_at as string).localeCompare(b.published_at as string))
    .map((a) => ({
      label: fieldLabel(a.target_field),
      detail: a.action_type === "content_publish" ? a.proposed_value?.title ?? null : null,
      url: safeUrl(a.target_url),
      published_at: a.published_at as string,
      verified: a.apply_mode === "api" && a.publish_result?.verified === true,
    }));
}

export function queuedItems(rows: ActionRow[]): QueuedItem[] {
  return rows
    .filter((a) => a.status === "pending_approval" || a.status === "manual_required")
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((a) => ({
      label: fieldLabel(a.target_field),
      detail: a.action_type === "content_publish" ? a.proposed_value?.title ?? null : safeUrl(a.target_url),
      needs: a.status === "pending_approval" ? "approval" : "you_to_apply",
    }));
}

// -----------------------------------------------------------------------------
// Report content
// -----------------------------------------------------------------------------

export type ProfileMetrics =
  | { available: false; reason: string }
  | { available: true; days: number; totals: Record<string, number> };

export type TrendPoint = { x: string; y: number | null };

/** The last checks up to the end of the month, for the trend chart. */
export type TrendData = { organic: TrendPoint[]; local_pack: TrendPoint[] };

/** The latest map-grid sweep up to the end of the month, for one geo-grid keyword. */
export type GridData = {
  keyword: string;
  check_date: string;
  cells: { row: number; col: number; position: number | null }[];
};

export type LocationReport = {
  id: string;
  name: string;
  rankings: { keywords: KeywordRank[]; organic: RankSummary; local_pack: RankSummary };
  /** Optional: reports made before charts existed don't have these. */
  trend?: TrendData;
  grid?: GridData | null;
  radius: Radius;
  profile_metrics: ProfileMetrics;
  backlinks: null | { snapshot_date: string; referring_domains: number | null; total: number | null; gained: number | null; lost: number | null };
  site_connection: null | { status: string };
  shipped: ShippedItem[];
  queued: QueuedItem[];
};

export type ReportContent = {
  version: 1;
  client_name: string;
  period: Period;
  generated_at: string;
  is_first_report: boolean;
  ai_visibility: null | { queries: number; checks: number; cited: number };
  locations: LocationReport[];
};

/** Sum a month of daily GBP metric rows. No rows means "not connected yet", never zeros. */
export function profileMetrics(rows: { metrics: Record<string, unknown> }[]): ProfileMetrics {
  if (rows.length === 0) {
    return { available: false, reason: "Google Business Profile isn't connected yet, so views, calls and direction requests aren't available." };
  }
  const totals: Record<string, number> = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.metrics ?? {})) {
      if (typeof v === "number" && Number.isFinite(v)) totals[k] = (totals[k] ?? 0) + v;
    }
  }
  return { available: true, days: rows.length, totals };
}

export const METRIC_LABELS: Record<string, string> = {
  views_maps: "Views on Google Maps",
  views_search: "Views on Google Search",
  calls: "Calls",
  direction_requests: "Direction requests",
  website_clicks: "Website clicks",
};

export function signed(n: number | null): string {
  if (n === null) return "–";
  return n > 0 ? `+${n}` : String(n);
}

/** "3 → 2" style movement for a keyword's position; lower is better. */
export function movement(now: number | null, before: number | null): string {
  if (now === null && before === null) return "";
  if (before === null) return "new";
  if (now === null) return "dropped out";
  if (now === before) return "no change";
  return now < before ? `up ${before - now}` : `down ${now - before}`;
}

export function positionText(p: { now: number | null; checked: boolean }): string {
  if (!p.checked) return "not checked";
  return p.now === null ? "not found" : `#${p.now}`;
}

/** seo_rank_trend rows to chart points, oldest first. avg_position may arrive as a numeric string. */
export function trendData(rows: { rank_type: string; check_date: string; avg_position: number | string | null }[]): TrendData {
  const pick = (type: string): TrendPoint[] =>
    rows
      .filter((r) => r.rank_type === type)
      .sort((a, b) => a.check_date.localeCompare(b.check_date))
      .map((r) => ({ x: r.check_date, y: r.avg_position === null ? null : Number(r.avg_position) }));
  return { organic: pick("organic"), local_pack: pick("local_pack") };
}
