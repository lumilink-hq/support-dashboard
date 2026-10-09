// =============================================================================
// test-seo-gbp-sync.ts — unit tests for module 3's pure helpers
// (seo-gbp-sync/lib.ts).
//
//   npx tsx scripts/test-seo-gbp-sync.ts
//
// No network, no Deno, no database. Payload shapes follow Google's REST
// references; they were not captured from a live account, so the live run in
// plan.md §8 is what confirms them.
// =============================================================================

import {
  addressText,
  auditProfile,
  classifyStatus,
  DAILY_METRICS,
  hostOf,
  matchLocations,
  metricsWindow,
  normalisePhone,
  normalisePostal,
  parseAccounts,
  parseLocation,
  parseReviews,
  performanceDays,
  performanceQuery,
  reachedKnown,
  streetKey,
  type GbpLocationRow,
} from "../supabase/functions/seo-gbp-sync/lib.ts";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, got?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
  }
}

function eq(label: string, got: unknown, want: unknown) {
  ok(label, JSON.stringify(got) === JSON.stringify(want), got);
}

// -----------------------------------------------------------------------------
// Metrics window and query
// -----------------------------------------------------------------------------
eq("window: first run backfills six months to yesterday",
  metricsWindow({ metrics_through: null, metrics_backfilled_at: null }, "2026-10-09"),
  { start: "2026-04-09", end: "2026-10-08", backfill: true });
eq("window: later runs re-pull 10 days",
  metricsWindow({ metrics_through: "2026-10-05", metrics_backfilled_at: "2026-10-06T00:00:00Z" }, "2026-10-09"),
  { start: "2026-09-26", end: "2026-10-08", backfill: false });
eq("window: a through-date in the future never starts after the end",
  metricsWindow({ metrics_through: "2026-10-30", metrics_backfilled_at: "x" }, "2026-10-09").start,
  "2026-10-08");

{
  const q = new URLSearchParams(performanceQuery({ start: "2026-04-09", end: "2026-10-08" }));
  eq("query: every metric repeated", q.getAll("dailyMetrics"), Object.keys(DAILY_METRICS));
  eq("query: start date fields", [q.get("dailyRange.start_date.year"), q.get("dailyRange.start_date.month"), q.get("dailyRange.start_date.day")], ["2026", "4", "9"]);
  eq("query: end date fields", [q.get("dailyRange.end_date.year"), q.get("dailyRange.end_date.month"), q.get("dailyRange.end_date.day")], ["2026", "10", "8"]);
  ok("query: deprecated metrics not requested", !q.getAll("dailyMetrics").includes("BUSINESS_FOOD_ORDERS") && !q.getAll("dailyMetrics").includes("BUSINESS_CONVERSATIONS"));
}

// -----------------------------------------------------------------------------
// Performance days
// -----------------------------------------------------------------------------
{
  const d = (day: number, value?: string) => ({ date: { year: 2026, month: 10, day }, ...(value === undefined ? {} : { value }) });
  const payload = {
    multiDailyMetricTimeSeries: [
      {
        dailyMetricTimeSeries: [
          { dailyMetric: "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", timeSeries: { datedValues: [d(1, "10"), d(2, "4"), d(3), d(4)] } },
          { dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_MAPS", timeSeries: { datedValues: [d(1, "30"), d(2), d(3, "1"), d(4)] } },
          { dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", timeSeries: { datedValues: [d(1, "5"), d(2, "6"), d(3), d(4)] } },
          { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [d(1, "2"), d(2), d(3), d(4)] } },
          { dailyMetric: "SOMETHING_NEW", timeSeries: { datedValues: [d(1, "99")] } },
        ],
      },
    ],
  };
  const days = performanceDays(payload);
  eq("perf: trailing all-zero day dropped", days.map((x) => x.metric_date), ["2026-10-01", "2026-10-02", "2026-10-03"]);
  eq("perf: maps views summed across devices", days.map((x) => x.metrics.views_maps), [40, 4, 1]);
  eq("perf: search views from mobile only", days[0].metrics.views_search, 5);
  eq("perf: absent value is zero", days[1].metrics.calls, 0);
  eq("perf: device split kept", days[0].metrics.views_maps_mobile, 30);
  ok("perf: unknown metric ignored", !Object.values(days[0].metrics).includes(99));
  ok("perf: no desktop-search key when Google didn't return it", !("views_search_desktop" in days[0].metrics));
  eq("perf: empty payload", performanceDays({}), []);
  eq("perf: garbage payload", performanceDays(null), []);
}

// -----------------------------------------------------------------------------
// Accounts and locations
// -----------------------------------------------------------------------------
eq("accounts: parsed, bad names dropped",
  parseAccounts({ accounts: [{ name: "accounts/1", accountName: "PACKS", type: "LOCATION_GROUP" }, { name: "bogus" }, {}] }),
  [{ name: "accounts/1", accountName: "PACKS", type: "LOCATION_GROUP" }]);
eq("accounts: none", parseAccounts({}), []);

eq("address: one line", addressText({ addressLines: ["1500 N Harbor Blvd", " Suite 2 "], locality: "Fullerton", administrativeArea: "CA", postalCode: "92835" }),
  "1500 N Harbor Blvd, Suite 2, Fullerton, CA 92835");
eq("address: none", addressText(undefined), null);

const RAW_LOCATION = {
  name: "locations/111",
  title: "PACKS Fullerton",
  storeCode: "FUL",
  phoneNumbers: { primaryPhone: "(714) 555-0100" },
  categories: { primaryCategory: { name: "categories/gcid:cannabis_store", displayName: "Cannabis store" }, additionalCategories: [{ displayName: "Dispensary" }] },
  storefrontAddress: { addressLines: ["1500 N. Harbor Blvd"], locality: "Fullerton", administrativeArea: "CA", postalCode: "92835-1234" },
  websiteUri: "https://www.packsclub.com/fullerton",
  regularHours: { periods: [{ openDay: "MONDAY" }] },
  openInfo: { status: "OPEN" },
  metadata: { placeId: "ChIJ123", mapsUri: "https://maps.google.com/?cid=1", newReviewUri: "https://g.page/r/x/review", hasVoiceOfMerchant: true },
  profile: { description: "x".repeat(300) },
};

{
  const row = parseLocation(RAW_LOCATION, "accounts/1")!;
  eq("location: name and account", [row.location_name, row.account_name], ["locations/111", "accounts/1"]);
  eq("location: category display names", [row.primary_category, row.additional_categories], ["Cannabis store", ["Dispensary"]]);
  eq("location: hours", row.has_regular_hours, true);
  eq("location: place id", row.place_id, "ChIJ123");
  eq("location: voice of merchant", row.has_voice_of_merchant, true);
  eq("location: absent hasPendingEdits is false when metadata exists", row.has_pending_edits, false);
  eq("location: postal code", row.postal_code, "92835-1234");
  eq("location: bad name rejected", parseLocation({ name: "accounts/1/locations/2" }, "accounts/1"), null);
  const bare = parseLocation({ name: "locations/2" }, "accounts/1")!;
  eq("location: no metadata at all is unknown, not false", bare.has_voice_of_merchant, null);
  eq("location: absent hasVoiceOfMerchant with metadata is false", parseLocation({ name: "locations/3", metadata: { placeId: "p" } }, "a")!.has_voice_of_merchant, false);
}

// -----------------------------------------------------------------------------
// Matching
// -----------------------------------------------------------------------------
eq("phone: formats compare equal", normalisePhone("+1 (714) 555-0100"), normalisePhone("714.555.0100"));
eq("phone: too short", normalisePhone("555-0100"), null);
eq("postal: ZIP+4 to ZIP", normalisePostal("92835-1234"), "92835");
eq("postal: UK kept", normalisePostal("sw1a 1aa"), "SW1A1AA");
eq("street: number + name, direction skipped", streetKey("1500 N. Harbor Blvd"), "1500 harbor");
eq("street: from a full address line", streetKey("PACKS, 1500 Harbor Boulevard, Fullerton"), "1500 harbor");
eq("street: none", streetKey("Harbor Blvd"), null);
eq("host: www stripped", hostOf("https://www.PacksClub.com/x"), "packsclub.com");
eq("host: bare domain", hostOf("packsclub.com"), "packsclub.com");

{
  const gbp = [
    { location_name: "locations/1", address_text: "1500 N Harbor Blvd, Fullerton, CA 92835", postal_code: "92835", phone: "714-555-0100" },
    { location_name: "locations/2", address_text: "200 Main St, Anaheim, CA 92801", postal_code: "92801", phone: null },
    { location_name: "locations/3", address_text: "9 Elm St, Irvine, CA 92602", postal_code: "92602", phone: "949-555-0000" },
  ];
  const seo = [
    { id: "a", address_line1: "1500 Harbor Blvd", postal_code: "92835-0001", phone_number: null },
    { id: "b", address_line1: "200 Main Street", postal_code: "92801", phone_number: null },
    { id: "c", address_line1: null, postal_code: "92602", phone_number: "(949) 555-0000" },
    { id: "d", address_line1: "1 Other Rd", postal_code: "90210", phone_number: "714-555-0100" },
  ];
  eq("match: street, street, phone; postal must agree", matchLocations(gbp, seo), [
    { location_name: "locations/1", location_id: "a" },
    { location_name: "locations/2", location_id: "b" },
    { location_name: "locations/3", location_id: "c" },
  ]);
  const twins = [
    { id: "x", address_line1: "1500 Harbor Blvd", postal_code: "92835", phone_number: null },
    { id: "y", address_line1: "1500 Harbor Blvd", postal_code: "92835", phone_number: null },
  ];
  eq("match: ambiguous left for a person", matchLocations([gbp[0]], twins), []);
  eq("match: no postal code, no match", matchLocations([{ ...gbp[0], postal_code: null }], seo), []);
}

// -----------------------------------------------------------------------------
// Reviews
// -----------------------------------------------------------------------------
{
  const page = parseReviews({
    reviews: [
      { name: "accounts/1/locations/111/reviews/r1", reviewId: "r1", reviewer: { displayName: "Sam" }, starRating: "FIVE", comment: "Great", createTime: "2026-10-01T00:00:00Z", updateTime: "2026-10-02T00:00:00Z", reviewReply: { comment: "Thanks!", updateTime: "2026-10-03T00:00:00Z" } },
      { name: "accounts/1/locations/111/reviews/r2", reviewer: { isAnonymous: true }, starRating: "TWO", createTime: "2026-09-01T00:00:00Z", updateTime: "2026-09-01T00:00:00Z" },
      { starRating: "FIVE" },
    ],
    averageRating: 4.567,
    totalReviewCount: 321,
    nextPageToken: "tok",
  });
  eq("reviews: two parsed, one without an id dropped", page.reviews.map((r) => r.review_id), ["r1", "r2"]);
  eq("reviews: id from the name when reviewId is missing", page.reviews[1].review_id, "r2");
  eq("reviews: stars", page.reviews.map((r) => r.star_rating), [5, 2]);
  eq("reviews: reply", page.reviews[0].reply_comment, "Thanks!");
  eq("reviews: rating-only review has no comment", page.reviews[1].comment, null);
  eq("reviews: anonymous", page.reviews[1].reviewer_is_anonymous, true);
  eq("reviews: totals", [page.averageRating, page.totalReviewCount, page.nextPageToken], [4.57, 321, "tok"]);
  eq("reviews: empty", parseReviews({}), { reviews: [], averageRating: null, totalReviewCount: null, nextPageToken: null });
  ok("reachedKnown: older review on the page", reachedKnown(page.reviews, "2026-09-15T00:00:00Z"));
  ok("reachedKnown: all newer", !reachedKnown(page.reviews, "2026-08-01T00:00:00Z"));
  ok("reachedKnown: nothing stored yet", !reachedKnown(page.reviews, null));
}

// -----------------------------------------------------------------------------
// Completeness audit
// -----------------------------------------------------------------------------
{
  const good = parseLocation(RAW_LOCATION, "accounts/1")!;
  const seo = { website_url: "packsclub.com", phone_number: "714 555 0100", postal_code: "92835" };
  const now = new Date("2026-10-09T00:00:00Z");
  eq("audit: a complete, consistent profile has no findings", auditProfile({ gbp: good, seo, reviews: [], now }), []);

  const bad: GbpLocationRow = {
    ...good,
    description: null,
    has_regular_hours: false,
    additional_categories: [],
    website_uri: "https://other.com",
    phone: "(714) 555-9999",
    postal_code: "92801",
    has_voice_of_merchant: false,
    open_status: "CLOSED_TEMPORARILY",
    has_pending_edits: true,
  };
  const types = auditProfile({
    gbp: bad,
    seo,
    reviews: [
      { star_rating: 2, reply_comment: null, created_at_google: "2026-10-01T00:00:00Z" },
      { star_rating: 5, reply_comment: null, created_at_google: "2026-09-30T00:00:00Z" },
      { star_rating: 5, reply_comment: "Thanks", created_at_google: "2026-09-30T00:00:00Z" },
      { star_rating: 1, reply_comment: null, created_at_google: "2025-01-01T00:00:00Z" },
    ],
    now,
  });
  eq("audit: every problem found", types.map((f) => f.finding_type), [
    "gbp_marked_closed",
    "gbp_not_in_control",
    "gbp_missing_description",
    "gbp_missing_hours",
    "gbp_no_additional_categories",
    "gbp_website_mismatch",
    "gbp_phone_mismatch",
    "gbp_address_mismatch",
    "gbp_pending_edits",
    "gbp_unanswered_reviews",
  ]);
  const unanswered = types.find((f) => f.finding_type === "gbp_unanswered_reviews")!;
  eq("audit: only recent unanswered reviews counted", unanswered.details, { unanswered: 2, recent: 3, low_star_unanswered: 1 });
  eq("audit: a low-star unanswered review makes it a warning", unanswered.severity, "warning");
  eq("audit: closed is critical", types[0].severity, "critical");

  const short = auditProfile({ gbp: { ...good, description: "Short." }, seo: null, reviews: null, now });
  eq("audit: short description is info", short.map((f) => [f.finding_type, f.severity]), [["gbp_short_description", "info"]]);
  eq("audit: reviews unavailable -> no review finding", auditProfile({ gbp: good, seo: null, reviews: null, now }), []);
  eq("audit: unknown voice of merchant isn't reported", auditProfile({ gbp: { ...good, has_voice_of_merchant: null }, seo: null, reviews: null, now }), []);
  eq("audit: missing website/phone",
    auditProfile({ gbp: { ...good, website_uri: null, phone: null }, seo, reviews: null, now }).map((f) => f.finding_type),
    ["gbp_missing_website", "gbp_missing_phone"]);
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------
eq("status: 200", classifyStatus(200), "ok");
eq("status: 403 is no_access (API off or not a manager)", classifyStatus(403), "no_access");
eq("status: 429 retry", classifyStatus(429), "retry");
eq("status: 401 retry", classifyStatus(401), "retry");
eq("status: 400 fatal", classifyStatus(400), "fatal");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
