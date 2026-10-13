// =============================================================================
// test-outbound-source.ts — unit tests for the outbound-source pure helpers
// (docs/OUTBOUND-PLAN.md, Phase 1 step 2).
//
//   npx tsx scripts/test-outbound-source.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  AudienceError,
  buildListingsRequest,
  cursorKey,
  pageLimit,
  parseListing,
  readPage,
} from "../supabase/functions/outbound-source/lib.ts";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, got?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${got === undefined ? "" : `  (got: ${JSON.stringify(got)})`}`);
  }
}

function throwsAudience(label: string, fn: () => unknown) {
  try {
    fn();
    ok(label, false, "no error");
  } catch (e) {
    ok(label, e instanceof AudienceError, e instanceof Error ? e.message : e);
  }
}

console.log("pageLimit");
ok("50 a day buys 200", pageLimit(50) === 200, pageLimit(50));
ok("small targets still buy 100", pageLimit(5) === 100, pageLimit(5));
ok("capped at the API's 1,000", pageLimit(900) === 1000, pageLimit(900));
ok("nonsense target falls back to 100", pageLimit(Number.NaN) === 100, pageLimit(Number.NaN));

console.log("buildListingsRequest");
{
  const body = buildListingsRequest(
    { categories: [" cannabis_store "], location_coordinate: "42.3314, -83.0458, 50", min_rating: 3.5, min_reviews: 10 },
    200,
  );
  ok("categories are trimmed", JSON.stringify(body.categories) === '["cannabis_store"]', body.categories);
  ok("coordinate spaces are removed", body.location_coordinate === "42.3314,-83.0458,50", body.location_coordinate);
  ok(
    "rating and review filters are joined with and",
    JSON.stringify(body.filters) ===
      JSON.stringify([["rating.value", ">=", 3.5], "and", ["rating.votes_count", ">=", 10]]),
    body.filters,
  );
  ok("most-reviewed first", body.order_by[0] === "rating.votes_count,desc", body.order_by);
  ok("limit is passed through", body.limit === 200, body.limit);
  ok("no offset_token on a fresh request", !("offset_token" in body));
}
{
  const body = buildListingsRequest({ categories: ["hvac_contractor"], filters: [["address_info.region", "=", "MI"]] }, 100);
  ok("raw filters pass through", JSON.stringify(body.filters) === '[["address_info.region","=","MI"]]', body.filters);
  ok("no coordinate when none given", body.location_coordinate === undefined);
}
throwsAudience("empty audience is rejected (would page every listing)", () => buildListingsRequest({}, 100));
throwsAudience("non-object audience is rejected", () => buildListingsRequest([], 100));
throwsAudience("more than 10 categories is rejected", () =>
  buildListingsRequest({ categories: Array.from({ length: 11 }, (_, i) => `c${i}`) }, 100),
);
throwsAudience("bad coordinate is rejected", () => buildListingsRequest({ location_coordinate: "Detroit" }, 100));
throwsAudience("rating above 5 is rejected", () => buildListingsRequest({ categories: ["x"], min_rating: 6 }, 100));
throwsAudience("fractional review count is rejected", () =>
  buildListingsRequest({ categories: ["x"], min_reviews: 2.5 }, 100),
);
throwsAudience("malformed raw filter is rejected", () =>
  buildListingsRequest({ categories: ["x"], filters: ["rating.value > 3"] }, 100),
);
throwsAudience("more than 8 conditions is rejected", () =>
  buildListingsRequest(
    { categories: ["x"], min_rating: 3, filters: Array.from({ length: 8 }, () => ["a", "=", 1]) },
    100,
  ),
);

console.log("cursorKey");
{
  const a = buildListingsRequest({ categories: ["cannabis_store"] }, 200);
  const b = buildListingsRequest({ categories: ["cannabis_store"] }, 200);
  const c = buildListingsRequest({ categories: ["cannabis_store"], min_rating: 4 }, 200);
  const d = buildListingsRequest({ categories: ["cannabis_store"] }, 400);
  ok("same audience, same key", cursorKey(a) === cursorKey(b));
  ok("offset_token doesn't change the key", cursorKey({ ...a, offset_token: "t1" }) === cursorKey(a));
  ok("an audience edit changes the key", cursorKey(a) !== cursorKey(c));
  ok("a different page size changes the key", cursorKey(a) !== cursorKey(d));
}

console.log("parseListing");
const listing = {
  type: "business_listing",
  title: "Green Leaf Provisioning",
  category: "Cannabis store",
  cid: "1234567890",
  place_id: "ChIJabc",
  address: "1 Main St, Detroit, MI 48201",
  address_info: { city: "Detroit", region: "MI", zip: "48201", country_code: "US" },
  phone: "+13135550100",
  url: "https://greenleaf.example.com/",
  domain: "greenleaf.example.com",
  rating: { rating_type: "Max5", value: 4.6, votes_count: 812, rating_max: 5 },
  work_time: { work_hours: { current_status: "open" } },
  popular_times: { big: true },
  people_also_search: [{ cid: "x" }],
};
{
  const r = parseListing(listing);
  ok("a full listing parses", "row" in r);
  if ("row" in r) {
    ok("cid is the source_ref", r.row.source_ref === "1234567890", r.row.source_ref);
    ok("address parts are mapped", r.row.city === "Detroit" && r.row.region === "MI" && r.row.postal_code === "48201");
    ok("website comes from url", r.row.website_url === "https://greenleaf.example.com/", r.row.website_url);
    ok("5-point rating is kept", r.row.rating === 4.6 && r.row.review_count === 812, [r.row.rating, r.row.review_count]);
    ok("bulky fields are dropped from raw", !("popular_times" in r.row.raw) && !("people_also_search" in r.row.raw));
    ok("the rest of raw is kept", r.row.raw.cid === "1234567890");
  }
}
{
  const r = parseListing({ ...listing, cid: undefined });
  ok("falls back to place_id", "row" in r && r.row.source_ref === "ChIJabc");
}
{
  const r = parseListing({ ...listing, url: null });
  ok("falls back to domain for the website", "row" in r && r.row.website_url === "https://greenleaf.example.com");
}
{
  const r = parseListing({ ...listing, rating: { rating_type: "Percents", value: 92, votes_count: 40, rating_max: 100 } });
  ok("a non-5-point rating is dropped, votes kept", "row" in r && r.row.rating === null && r.row.review_count === 40);
}
ok("no id is skipped", JSON.stringify(parseListing({ ...listing, cid: null, place_id: "" })) === '{"skip":"no_id"}');
ok("no name is skipped", JSON.stringify(parseListing({ ...listing, title: "  " })) === '{"skip":"no_name"}');
ok(
  "closed for good is skipped",
  JSON.stringify(parseListing({ ...listing, work_time: { work_hours: { current_status: "closed_forever" } } })) ===
    '{"skip":"closed"}',
);
ok(
  "no website is skipped by default",
  JSON.stringify(parseListing({ ...listing, url: null, domain: null })) === '{"skip":"no_website"}',
);
ok("no website is kept when not required", "row" in parseListing({ ...listing, url: null, domain: null }, false));
ok("non-object is skipped", "skip" in parseListing(null));

console.log("readPage");
{
  const full = readPage([{ total_count: 5000, offset_token: "tok", items: new Array(200).fill({}) }], 200);
  ok("a full page with a token continues", !full.exhausted && full.nextToken === "tok" && full.total === 5000);
  const short = readPage([{ total_count: 150, offset_token: "tok", items: new Array(150).fill({}) }], 200);
  ok("a short page is the last one", short.exhausted);
  const noToken = readPage([{ total_count: 200, items: new Array(200).fill({}) }], 200);
  ok("a page without a token is the last one", noToken.exhausted && noToken.nextToken === null);
  const empty = readPage(null, 200);
  ok("no result reads as an empty, finished page", empty.items.length === 0 && empty.exhausted);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
