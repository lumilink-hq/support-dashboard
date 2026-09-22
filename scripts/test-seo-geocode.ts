// =============================================================================
// test-seo-geocode.ts — unit tests for the seo-geocode pure helpers.
//
//   npx tsx scripts/test-seo-geocode.ts
//
// No network, no Deno, no database.
// =============================================================================

import { censusUrl, isUsAddress, parseCensusMatch, toCensusQuery } from "../supabase/functions/seo-geocode/lib.ts";

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

console.log("\nisUsAddress");
{
  ok("null counts as domestic", isUsAddress(null) === true);
  ok("blank counts as domestic", isUsAddress("  ") === true);
  ok("US", isUsAddress("US") === true);
  ok("lowercase us", isUsAddress("us") === true);
  ok("USA", isUsAddress("USA") === true);
  ok("a real other country is out of scope", isUsAddress("CA") === false);
  ok("MX is out of scope", isUsAddress("mx") === false);
}

console.log("\ntoCensusQuery");
{
  const full = { address_line1: " 100 Main St ", city: "Springfield", region: "IL", postal_code: "62701", country_code: "US" };
  ok("builds from a complete address, trimmed", JSON.stringify(toCensusQuery(full)) === JSON.stringify({ street: "100 Main St", city: "Springfield", state: "IL", zip: "62701" }));
  ok("postal code is optional", toCensusQuery({ ...full, postal_code: null })?.zip === "");
  ok("missing street is incomplete", toCensusQuery({ ...full, address_line1: null }) === null);
  ok("missing city is incomplete", toCensusQuery({ ...full, city: "  " }) === null);
  ok("missing region is incomplete", toCensusQuery({ ...full, region: null }) === null);
}

console.log("\ncensusUrl");
{
  const url = new URL(censusUrl({ street: "100 Main St", city: "Springfield", state: "IL", zip: "62701" }));
  ok("hits the Census address endpoint", url.origin + url.pathname === "https://geocoding.geo.census.gov/geocoder/locations/address");
  ok("carries the address parts", url.searchParams.get("street") === "100 Main St" && url.searchParams.get("city") === "Springfield" && url.searchParams.get("state") === "IL" && url.searchParams.get("zip") === "62701");
  ok("pins a benchmark and asks for json", url.searchParams.get("benchmark") === "Public_AR_Current" && url.searchParams.get("format") === "json");
  const noZip = new URL(censusUrl({ street: "100 Main St", city: "Springfield", state: "IL", zip: "" }));
  ok("omits zip when there isn't one", noZip.searchParams.has("zip") === false);
}

console.log("\nparseCensusMatch");
{
  const body = { result: { addressMatches: [{ matchedAddress: "100 MAIN ST, SPRINGFIELD, IL, 62701", coordinates: { x: -89.6501481, y: 39.7817212 } }] } };
  const m = parseCensusMatch(body);
  ok("reads x as lng and y as lat", m?.lat === 39.781721 && m?.lng === -89.650148, m);
  ok("keeps the matched address", m?.matchedAddress === "100 MAIN ST, SPRINGFIELD, IL, 62701");
  ok("no matches is null, not a crash", parseCensusMatch({ result: { addressMatches: [] } }) === null);
  ok("missing result shape is null", parseCensusMatch({}) === null && parseCensusMatch(null) === null);
  ok("non-numeric coordinates are null", parseCensusMatch({ result: { addressMatches: [{ coordinates: { x: "bad", y: 1 } }] } }) === null);
  const two = parseCensusMatch({ result: { addressMatches: [{ coordinates: { x: 1, y: 2 } }, { coordinates: { x: 3, y: 4 } }] } });
  ok("picks the first match when there are several", two?.lat === 2 && two?.lng === 1, two);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
