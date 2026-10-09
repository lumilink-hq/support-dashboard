// test-seo-gbp.ts — lib/seo-gbp.ts (what the portal says about Business Profile).
//   npx tsx scripts/test-seo-gbp.ts
import { gbpState, listingLabel, ratingLine } from "../lib/seo-gbp";

let passed = 0;
let failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label} — got ${JSON.stringify(got)}`);
  }
}

const base = { location_name: "locations/1", title: "PACKS Fullerton", address_text: "1500 N Harbor Blvd, Fullerton, CA 92835", store_code: "FUL" };
eq("label: short store code shown", listingLabel(base), "PACKS Fullerton (FUL), 1500 N Harbor Blvd, Fullerton, CA 92835");
eq("label: 20-digit machine id hidden", listingLabel({ ...base, store_code: "12019008643263360374" }), "PACKS Fullerton, 1500 N Harbor Blvd, Fullerton, CA 92835");
eq("label: no store code", listingLabel({ ...base, store_code: null }), "PACKS Fullerton, 1500 N Harbor Blvd, Fullerton, CA 92835");
eq("label: no title or address", listingLabel({ ...base, title: null, address_text: null, store_code: null }), "locations/1");

const listing = {
  location_name: "locations/1", title: "x", address_text: null, store_code: null, linked_location_id: "loc", link_source: "auto" as const,
  average_rating: "4.56", total_review_count: 312, reviews_status: "ok" as const, metrics_through: null, metrics_error: null, maps_uri: null, new_review_uri: null,
};
eq("rating: numeric string", ratingLine(listing), "4.6 from 312 reviews");
eq("rating: unavailable", ratingLine({ ...listing, reviews_status: "unavailable" }), null);
eq("state: no scope", gbpState({ hasScope: false, sync: null, listings: [], locationId: "loc" }).kind, "message");
eq("state: linked", gbpState({ hasScope: true, sync: { status: "ok", locations_count: 1, last_synced_at: null, last_error: null }, listings: [listing], locationId: "loc" }).kind, "linked");
eq("state: listed but not linked asks to pick",
  gbpState({ hasScope: true, sync: { status: "ok", locations_count: 1, last_synced_at: null, last_error: null }, listings: [{ ...listing, linked_location_id: "other" }], locationId: "loc" }),
  { kind: "message", text: "Choose which Business Profile is this location's in Settings.", action: "link" });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
