// =============================================================================
// Pure helpers for seo-geocode — fills module 7's missing piece (plan.md: "the
// wizard does not collect latitude/longitude and geocoding isn't built, so
// there is no geo grid for a location until its lat/lng is filled in by
// hand"). No network, no Deno APIs: the function builds a request with these
// and parses the response with these, so it's unit-tested with
// scripts/test-seo-geocode.ts.
// =============================================================================

const CENSUS_BASE = "https://geocoding.geo.census.gov/geocoder/locations/address";
// The Census Geocoder's current address-range benchmark. Pinned so an address
// that matched last month matches the same way this month.
const BENCHMARK = "Public_AR_Current";

export type LocationAddress = {
  address_line1: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
};

/** The Census geocoder only covers the United States. The column is free text
 * and optional (see app/onboarding/page.tsx): blank, 'US' or 'USA' all count
 * as domestic. Anything else is out of scope, not an error. */
export function isUsAddress(countryCode: string | null): boolean {
  const c = (countryCode ?? "").trim().toUpperCase();
  return c === "" || c === "US" || c === "USA";
}

export type CensusQuery = { street: string; city: string; state: string; zip: string };

/** Street, city and state are required for a usable Census query; postal code
 * sharpens the match but its absence shouldn't block one. Null if the address
 * is too incomplete to try. */
export function toCensusQuery(loc: LocationAddress): CensusQuery | null {
  const street = (loc.address_line1 ?? "").trim();
  const city = (loc.city ?? "").trim();
  const state = (loc.region ?? "").trim();
  if (!street || !city || !state) return null;
  return { street, city, state, zip: (loc.postal_code ?? "").trim() };
}

export function censusUrl(q: CensusQuery): string {
  const params = new URLSearchParams({
    street: q.street,
    city: q.city,
    state: q.state,
    benchmark: BENCHMARK,
    format: "json",
  });
  if (q.zip) params.set("zip", q.zip);
  return `${CENSUS_BASE}?${params.toString()}`;
}

export type CensusMatch = { lat: number; lng: number; matchedAddress: string };

/** The Census response's first address match, rounded to the precision
 * seo_locations.lat/lng store (numeric(9,6)). Null if nothing matched or the
 * response isn't shaped as expected — never throws on a vendor surprise. */
export function parseCensusMatch(body: unknown): CensusMatch | null {
  const matches = (body as { result?: { addressMatches?: unknown[] } } | null)?.result?.addressMatches;
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const m = matches[0] as { coordinates?: { x?: unknown; y?: unknown }; matchedAddress?: unknown };
  const lng = m.coordinates?.x;
  const lat = m.coordinates?.y;
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    matchedAddress: typeof m.matchedAddress === "string" ? m.matchedAddress : "",
  };
}
