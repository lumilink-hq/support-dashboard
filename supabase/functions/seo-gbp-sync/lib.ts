// Pure helpers for seo-gbp-sync (module 3). No network, no Deno APIs, no
// database: the function fetches Google's responses and hands them here, so all
// of this is unit-tested with scripts/test-seo-gbp-sync.ts. Field names follow
// Google's REST references (read 2026-10-09):
//   Account Management v1  accounts.list
//   Business Information v1 accounts.locations.list (Location)
//   Business Profile Performance v1 locations.fetchMultiDailyMetricsTimeSeries
//   Google My Business v4  accounts.locations.reviews.list

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** First run per linked profile: this many days of daily metrics (plan: six months). */
export const BACKFILL_DAYS = 183;
/** Performance data is revised for a few days; every run re-pulls this many days before the last one held. */
export const REPULL_DAYS = 10;
/** Reviews pages (50 each) per profile per run while the first pull is still paging. */
export const MAX_REVIEW_PAGES_PER_RUN = 20;
/** Pages read on a normal run before giving up on reaching already-stored reviews. */
export const MAX_INCREMENTAL_REVIEW_PAGES = 4;

/** Fields asked of the Business Information API. readMask is required. */
export const LOCATION_READ_MASK = [
  "name",
  "title",
  "storeCode",
  "phoneNumbers",
  "categories",
  "storefrontAddress",
  "websiteUri",
  "regularHours",
  "openInfo",
  "metadata",
  "profile",
  "serviceArea",
].join(",");

/**
 * The daily metrics requested, and the key each one is stored under in
 * seo_metrics_daily.metrics. BUSINESS_CONVERSATIONS and BUSINESS_FOOD_ORDERS
 * are deprecated by Google and left out.
 */
export const DAILY_METRICS: Record<string, string> = {
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: "views_maps_desktop",
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: "views_maps_mobile",
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: "views_search_desktop",
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: "views_search_mobile",
  CALL_CLICKS: "calls",
  BUSINESS_DIRECTION_REQUESTS: "direction_requests",
  WEBSITE_CLICKS: "website_clicks",
  BUSINESS_BOOKINGS: "bookings",
  BUSINESS_FOOD_MENU_CLICKS: "menu_clicks",
};

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

export type MetricsWindow = { start: string; end: string; backfill: boolean };

/**
 * Which days to ask for. Never pulled: BACKFILL_DAYS back to yesterday.
 * Otherwise the trailing REPULL_DAYS before the last day held, to yesterday.
 * Today is never asked for: it's always incomplete.
 */
export function metricsWindow(
  state: { metrics_through: string | null; metrics_backfilled_at: string | null },
  today: string,
): MetricsWindow {
  const end = addDays(today, -1);
  if (!state.metrics_backfilled_at || !state.metrics_through) {
    return { start: addDays(today, -BACKFILL_DAYS), end, backfill: true };
  }
  const start = addDays(state.metrics_through, -(REPULL_DAYS - 1));
  return { start: start < end ? start : end, end, backfill: false };
}

/** Query string for fetchMultiDailyMetricsTimeSeries (repeated dailyMetrics, dotted date fields). */
export function performanceQuery(win: { start: string; end: string }): string {
  const p = new URLSearchParams();
  for (const m of Object.keys(DAILY_METRICS)) p.append("dailyMetrics", m);
  const [sy, sm, sd] = win.start.split("-").map(Number);
  const [ey, em, ed] = win.end.split("-").map(Number);
  p.set("dailyRange.start_date.year", String(sy));
  p.set("dailyRange.start_date.month", String(sm));
  p.set("dailyRange.start_date.day", String(sd));
  p.set("dailyRange.end_date.year", String(ey));
  p.set("dailyRange.end_date.month", String(em));
  p.set("dailyRange.end_date.day", String(ed));
  return p.toString();
}

// -----------------------------------------------------------------------------
// Performance
// -----------------------------------------------------------------------------

export type MetricDay = { metric_date: string; metrics: Record<string, number> };

type GDate = { year?: number; month?: number; day?: number };

function gDate(d: GDate | undefined): string | null {
  if (!d?.year || !d.month || !d.day) return null;
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/**
 * fetchMultiDailyMetricsTimeSeries -> one row per day. Google omits `value`
 * when it is zero, so a dated value without one is 0. views_maps and
 * views_search are the desktop + mobile sums (the keys the portal and report
 * already chart). Trailing days where every metric is zero are dropped:
 * Google lists days it has no data for yet the same way it lists real zeros,
 * and the next run's re-pull fills them in once they land.
 */
export function performanceDays(payload: unknown): MetricDay[] {
  const byDate = new Map<string, Record<string, number>>();
  const outer = (payload as { multiDailyMetricTimeSeries?: unknown[] })?.multiDailyMetricTimeSeries ?? [];
  for (const group of outer as { dailyMetricTimeSeries?: unknown[] }[]) {
    for (const series of (group?.dailyMetricTimeSeries ?? []) as {
      dailyMetric?: string;
      timeSeries?: { datedValues?: { date?: GDate; value?: string }[] };
    }[]) {
      const key = series?.dailyMetric ? DAILY_METRICS[series.dailyMetric] : undefined;
      if (!key) continue;
      for (const dv of series.timeSeries?.datedValues ?? []) {
        const date = gDate(dv?.date);
        if (!date) continue;
        const n = dv.value === undefined ? 0 : Number(dv.value);
        const m = byDate.get(date) ?? {};
        m[key] = Number.isFinite(n) ? n : 0;
        byDate.set(date, m);
      }
    }
  }
  const days = [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([metric_date, m]) => {
      const metrics = { ...m };
      if ("views_maps_desktop" in m || "views_maps_mobile" in m) {
        metrics.views_maps = (m.views_maps_desktop ?? 0) + (m.views_maps_mobile ?? 0);
      }
      if ("views_search_desktop" in m || "views_search_mobile" in m) {
        metrics.views_search = (m.views_search_desktop ?? 0) + (m.views_search_mobile ?? 0);
      }
      return { metric_date, metrics };
    });
  while (days.length > 0 && Object.values(days[days.length - 1].metrics).every((v) => v === 0)) days.pop();
  return days;
}

// -----------------------------------------------------------------------------
// Accounts and locations
// -----------------------------------------------------------------------------

export type GbpAccount = { name: string; accountName: string | null; type: string | null };

export function parseAccounts(payload: unknown): GbpAccount[] {
  const list = (payload as { accounts?: unknown[] })?.accounts ?? [];
  const out: GbpAccount[] = [];
  for (const a of list as { name?: string; accountName?: string; type?: string }[]) {
    if (typeof a?.name !== "string" || !/^accounts\/[^/]+$/.test(a.name)) continue;
    out.push({ name: a.name, accountName: a.accountName ?? null, type: a.type ?? null });
  }
  return out;
}

type PostalAddress = {
  regionCode?: string;
  postalCode?: string;
  administrativeArea?: string;
  locality?: string;
  addressLines?: string[];
};

export function addressText(a: PostalAddress | undefined | null): string | null {
  if (!a) return null;
  const parts = [
    ...(a.addressLines ?? []).map((l) => l.trim()).filter(Boolean),
    a.locality?.trim(),
    [a.administrativeArea?.trim(), a.postalCode?.trim()].filter(Boolean).join(" "),
  ].filter((p) => p && p.length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** The seo_gbp_locations columns refreshed every run (state columns are the function's). */
export type GbpLocationRow = {
  location_name: string;
  account_name: string;
  title: string | null;
  store_code: string | null;
  address_text: string | null;
  postal_code: string | null;
  phone: string | null;
  website_uri: string | null;
  primary_category: string | null;
  additional_categories: string[];
  description: string | null;
  has_regular_hours: boolean;
  open_status: string | null;
  place_id: string | null;
  maps_uri: string | null;
  new_review_uri: string | null;
  has_voice_of_merchant: boolean | null;
  has_pending_edits: boolean | null;
  profile: Record<string, unknown>;
};

export function parseLocation(raw: unknown, accountName: string): GbpLocationRow | null {
  const l = raw as Record<string, any>;
  if (typeof l?.name !== "string" || !/^locations\/[^/]+$/.test(l.name)) return null;
  const cats = l.categories ?? {};
  const md = l.metadata ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  return {
    location_name: l.name,
    account_name: accountName,
    title: str(l.title),
    store_code: str(l.storeCode),
    address_text: addressText(l.storefrontAddress),
    postal_code: str(l.storefrontAddress?.postalCode),
    phone: str(l.phoneNumbers?.primaryPhone),
    website_uri: str(l.websiteUri),
    primary_category: str(cats.primaryCategory?.displayName) ?? str(cats.primaryCategory?.name),
    additional_categories: ((cats.additionalCategories ?? []) as { displayName?: string; name?: string }[])
      .map((c) => str(c?.displayName) ?? str(c?.name))
      .filter((c): c is string => !!c),
    description: str(l.profile?.description),
    has_regular_hours: Array.isArray(l.regularHours?.periods) && l.regularHours.periods.length > 0,
    open_status: str(l.openInfo?.status),
    place_id: str(md.placeId),
    maps_uri: str(md.mapsUri),
    new_review_uri: str(md.newReviewUri),
    // Google returns only true booleans; an absent hasVoiceOfMerchant means false.
    has_voice_of_merchant: "hasVoiceOfMerchant" in md ? bool(md.hasVoiceOfMerchant) : md && Object.keys(md).length > 0 ? false : null,
    has_pending_edits: "hasPendingEdits" in md ? bool(md.hasPendingEdits) : md && Object.keys(md).length > 0 ? false : null,
    profile: l as Record<string, unknown>,
  };
}

// -----------------------------------------------------------------------------
// Matching profiles to seo_locations (module 11's finish)
// -----------------------------------------------------------------------------

/** The last 10 digits: "+1 (714) 555-0100" and "714.555.0100" compare equal. */
export function normalisePhone(p: string | null | undefined): string | null {
  const d = String(p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

export function hostOf(url: string | null | undefined): string | null {
  const s = String(url ?? "").trim();
  if (!s) return null;
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function normalisePostal(p: string | null | undefined): string | null {
  const s = String(p ?? "").toUpperCase().replace(/\s+/g, "");
  if (!s) return null;
  // US ZIP+4 compares on the 5-digit ZIP.
  return /^\d{5}-?\d{4}$/.test(s) ? s.slice(0, 5) : s;
}

/** The street number and the first word after it: "1500 N. Harbor Blvd" -> "1500 harbor". */
export function streetKey(line: string | null | undefined): string | null {
  const words = String(line ?? "")
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const i = words.findIndex((w) => /^\d+[a-z]?$/.test(w));
  if (i < 0) return null;
  const skip = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west"]);
  const next = words.slice(i + 1).find((w) => !skip.has(w));
  return next ? `${words[i]} ${next}` : null;
}

export type SeoLocationForMatch = {
  id: string;
  address_line1: string | null;
  postal_code: string | null;
  phone_number: string | null;
};

export type GbpForMatch = { location_name: string; address_text: string | null; postal_code: string | null; phone: string | null };

/**
 * Pairs that are safe to link without asking. A pair matches when the postal
 * codes agree AND either the phone numbers or the street (number + name)
 * agree. Only one-to-one matches are returned: a profile matching two
 * locations, or a location matching two profiles, is left for a person.
 */
export function matchLocations(gbp: GbpForMatch[], seo: SeoLocationForMatch[]): { location_name: string; location_id: string }[] {
  const pairs: { location_name: string; location_id: string }[] = [];
  for (const g of gbp) {
    const gPostal = normalisePostal(g.postal_code);
    if (!gPostal) continue;
    const gPhone = normalisePhone(g.phone);
    const gStreet = streetKey(g.address_text);
    for (const s of seo) {
      if (normalisePostal(s.postal_code) !== gPostal) continue;
      const phone = !!gPhone && normalisePhone(s.phone_number) === gPhone;
      const street = !!gStreet && streetKey(s.address_line1) === gStreet;
      if (phone || street) pairs.push({ location_name: g.location_name, location_id: s.id });
    }
  }
  const count = (key: "location_name" | "location_id", v: string) => pairs.filter((p) => p[key] === v).length;
  return pairs.filter((p) => count("location_name", p.location_name) === 1 && count("location_id", p.location_id) === 1);
}

// -----------------------------------------------------------------------------
// Reviews
// -----------------------------------------------------------------------------

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export type ReviewRow = {
  review_id: string;
  reviewer_name: string | null;
  reviewer_is_anonymous: boolean;
  star_rating: number | null;
  comment: string | null;
  created_at_google: string | null;
  updated_at_google: string | null;
  reply_comment: string | null;
  reply_updated_at: string | null;
};

export type ReviewsPage = {
  reviews: ReviewRow[];
  averageRating: number | null;
  totalReviewCount: number | null;
  nextPageToken: string | null;
};

export function parseReviews(payload: unknown): ReviewsPage {
  const p = payload as Record<string, any>;
  const reviews: ReviewRow[] = [];
  for (const r of (p?.reviews ?? []) as Record<string, any>[]) {
    const id = typeof r?.reviewId === "string" && r.reviewId ? r.reviewId : typeof r?.name === "string" ? r.name.split("/").pop() : null;
    if (!id) continue;
    const comment = typeof r.comment === "string" && r.comment.trim() ? r.comment : null;
    reviews.push({
      review_id: id,
      reviewer_name: typeof r.reviewer?.displayName === "string" ? r.reviewer.displayName : null,
      reviewer_is_anonymous: r.reviewer?.isAnonymous === true,
      star_rating: STARS[String(r.starRating ?? "")] ?? null,
      comment,
      created_at_google: typeof r.createTime === "string" ? r.createTime : null,
      updated_at_google: typeof r.updateTime === "string" ? r.updateTime : null,
      reply_comment: typeof r.reviewReply?.comment === "string" && r.reviewReply.comment.trim() ? r.reviewReply.comment : null,
      reply_updated_at: typeof r.reviewReply?.updateTime === "string" ? r.reviewReply.updateTime : null,
    });
  }
  const avg = Number(p?.averageRating);
  const total = Number(p?.totalReviewCount);
  return {
    reviews,
    averageRating: Number.isFinite(avg) && avg > 0 ? Math.round(avg * 100) / 100 : null,
    totalReviewCount: Number.isFinite(total) ? Math.round(total) : null,
    nextPageToken: typeof p?.nextPageToken === "string" && p.nextPageToken ? p.nextPageToken : null,
  };
}

/** True when a page reaches reviews already stored (updated at or before the high-water mark). */
export function reachedKnown(page: ReviewRow[], highWater: string | null): boolean {
  if (!highWater) return false;
  const hw = Date.parse(highWater);
  return page.some((r) => r.updated_at_google !== null && Date.parse(r.updated_at_google) <= hw);
}

// -----------------------------------------------------------------------------
// Profile completeness audit (findings, module 'gbp_profile')
// -----------------------------------------------------------------------------

export type GbpFinding = {
  finding_type: string;
  severity: "critical" | "warning" | "info";
  title: string;
  details: Record<string, unknown>;
};

/** Google allows 750 characters; under this reads as thin. */
export const DESCRIPTION_MIN = 250;
/** Reviews this recent without a reply count against the profile. */
export const UNANSWERED_WINDOW_DAYS = 90;

export function auditProfile(input: {
  gbp: GbpLocationRow;
  seo: { website_url: string | null; phone_number: string | null; postal_code: string | null } | null;
  reviews: { star_rating: number | null; reply_comment: string | null; created_at_google: string | null }[] | null;
  now: Date;
}): GbpFinding[] {
  const { gbp, seo, reviews, now } = input;
  const out: GbpFinding[] = [];

  if (gbp.open_status === "CLOSED_PERMANENTLY" || gbp.open_status === "CLOSED_TEMPORARILY") {
    out.push({
      finding_type: "gbp_marked_closed",
      severity: "critical",
      title: gbp.open_status === "CLOSED_PERMANENTLY" ? "Google shows this business as permanently closed" : "Google shows this business as temporarily closed",
      details: { open_status: gbp.open_status },
    });
  }
  if (gbp.has_voice_of_merchant === false) {
    out.push({
      finding_type: "gbp_not_in_control",
      severity: "critical",
      title: "Google doesn't treat this profile as owner-managed (unverified, suspended or duplicate)",
      details: {},
    });
  }

  const desc = gbp.description ?? "";
  if (!desc) {
    out.push({ finding_type: "gbp_missing_description", severity: "warning", title: "The profile has no business description", details: { limit: 750 } });
  } else if (desc.length < DESCRIPTION_MIN) {
    out.push({
      finding_type: "gbp_short_description",
      severity: "info",
      title: `The business description is short (${desc.length} of 750 characters)`,
      details: { length: desc.length, limit: 750 },
    });
  }

  if (!gbp.has_regular_hours) {
    out.push({ finding_type: "gbp_missing_hours", severity: "warning", title: "The profile has no opening hours", details: {} });
  }
  if (!gbp.primary_category) {
    out.push({ finding_type: "gbp_missing_category", severity: "warning", title: "The profile has no primary category", details: {} });
  } else if (gbp.additional_categories.length === 0) {
    out.push({
      finding_type: "gbp_no_additional_categories",
      severity: "info",
      title: "The profile lists only one category",
      details: { primary_category: gbp.primary_category },
    });
  }

  if (!gbp.website_uri) {
    out.push({ finding_type: "gbp_missing_website", severity: "warning", title: "The profile has no website link", details: {} });
  } else if (seo?.website_url && hostOf(seo.website_url) && hostOf(gbp.website_uri) !== hostOf(seo.website_url)) {
    out.push({
      finding_type: "gbp_website_mismatch",
      severity: "warning",
      title: "The profile links to a different website than the one on file",
      details: { profile: gbp.website_uri, on_file: seo.website_url },
    });
  }

  if (!gbp.phone) {
    out.push({ finding_type: "gbp_missing_phone", severity: "warning", title: "The profile has no phone number", details: {} });
  } else if (seo?.phone_number && normalisePhone(seo.phone_number) && normalisePhone(gbp.phone) !== normalisePhone(seo.phone_number)) {
    out.push({
      finding_type: "gbp_phone_mismatch",
      severity: "warning",
      title: "The profile's phone number differs from the one on file",
      details: { profile: gbp.phone, on_file: seo.phone_number },
    });
  }

  if (seo?.postal_code && gbp.postal_code && normalisePostal(seo.postal_code) !== normalisePostal(gbp.postal_code)) {
    out.push({
      finding_type: "gbp_address_mismatch",
      severity: "warning",
      title: "The profile's postal code differs from the one on file",
      details: { profile: gbp.address_text, on_file_postal_code: seo.postal_code },
    });
  }

  if (gbp.has_pending_edits) {
    out.push({ finding_type: "gbp_pending_edits", severity: "info", title: "Google is still reviewing an edit to this profile", details: {} });
  }

  if (reviews) {
    const since = now.getTime() - UNANSWERED_WINDOW_DAYS * 86_400_000;
    const recent = reviews.filter((r) => r.created_at_google && Date.parse(r.created_at_google) >= since);
    const unanswered = recent.filter((r) => !r.reply_comment);
    const lowUnanswered = unanswered.filter((r) => r.star_rating !== null && r.star_rating <= 3);
    if (unanswered.length > 0) {
      out.push({
        finding_type: "gbp_unanswered_reviews",
        severity: lowUnanswered.length > 0 ? "warning" : "info",
        title: `${unanswered.length} review${unanswered.length === 1 ? "" : "s"} from the last ${UNANSWERED_WINDOW_DAYS} days ${unanswered.length === 1 ? "has" : "have"} no reply`,
        details: { unanswered: unanswered.length, recent: recent.length, low_star_unanswered: lowUnanswered.length },
      });
    }
  }

  return out;
}

// -----------------------------------------------------------------------------
// API errors
// -----------------------------------------------------------------------------

export type CallOutcome = "ok" | "no_access" | "retry" | "fatal";

/**
 * 403/404: the API isn't enabled for the project, or the login can't see the
 * resource. Recorded, not retried hourly. 401: token bad, retried after the
 * refresh job. 429/5xx: transient, backed off.
 */
export function classifyStatus(status: number): CallOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 403 || status === 404) return "no_access";
  if (status === 401 || status === 429 || status >= 500) return "retry";
  return "fatal";
}

/** Backoff before retry `attempt` (0-based) of a vendor call: 1 s, 2 s, 4 s. */
export function backoffMs(attempt: number): number {
  return 1000 * 2 ** attempt;
}
