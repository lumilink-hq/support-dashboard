// The location settings form on /seo?tab=settings: validation and the update
// it produces. Pure (no Next, no Supabase) so scripts/test-seo-location-form.ts
// can test it with plain tsx.
//
// WHY THIS EXISTS. Until 2026-10-09 a location could only be added or deleted
// in onboarding. Fixing a typo in the address, moving the website, or marking a
// business as online-only meant a hand-written UPDATE in the SQL editor (done
// for LumiLink's own workspace on 2026-10-08).
//
// ONLINE ONLY. The SEO engine treats a location with no street address and no
// city as a business with no premises (isOnlineOnly in seo-crawl/lib.ts):
// Organization schema instead of LocalBusiness, and articles that name no
// place. The checkbox clears the address fields to get there, so there's one
// rule in one place rather than a second flag that could disagree with it.
//
// COORDINATES. Geocoding (0058) only fills lat/lng when both are empty, so a
// changed address must clear them or the map grid stays on the old spot.
//
// Same cleanup as onboarding's addSeoLocation: a website without a scheme gets
// https://, and the country is a two-letter code ("USA" becomes "US").

import { normalizeSiteUrl } from "./url";

export type LocationRow = {
  name: string;
  website_url: string | null;
  store_page_url: string | null;
  search_console_site_url: string | null;
  phone_number: string | null;
  address_line1: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
};

export type LocationUpdate = LocationRow & { lat?: null; lng?: null };

export type FormResult = { ok: true; update: LocationUpdate; changed: (keyof LocationRow)[] } | { ok: false; error: string };

const ADDRESS_FIELDS = ["address_line1", "city", "region", "postal_code", "country_code"] as const;
const NAME_MAX = 120;

/** sc-domain:example.com, or an http(s) URL prefix property ending in "/". */
export function cleanSearchConsoleProperty(raw: string): string | null | undefined {
  const s = raw.trim();
  if (!s) return null;
  const domain = s.match(/^sc-domain:([a-z0-9.-]+\.[a-z]{2,})$/i);
  if (domain) return `sc-domain:${domain[1].toLowerCase()}`;
  if (/^https?:\/\/[^\s/]+\.[a-z]{2,}(\/[^\s]*)?$/i.test(s)) return s.endsWith("/") ? s : `${s}/`;
  return undefined; // not empty, not valid
}

/**
 * `get` reads a submitted field (FormData.get, as a string). `current` is the
 * row as stored, used to work out what changed and whether to reset the map.
 */
export function parseLocationForm(get: (key: string) => string, current: LocationRow): FormResult {
  const str = (key: string) => {
    const v = get(key).trim();
    return v || null;
  };

  const name = (str("name") ?? "").slice(0, NAME_MAX + 1);
  if (!name) return { ok: false, error: "Give the location a name." };
  if (name.length > NAME_MAX) return { ok: false, error: `Keep the name under ${NAME_MAX} characters.` };

  // An address that normalises to the stored one keeps the stored spelling, so
  // re-saving a form never "changes" https://acme.com into https://acme.com/.
  const same = (fresh: string | null, stored: string | null) =>
    fresh && stored && normalizeSiteUrl(stored) === fresh ? stored : fresh;

  const rawWebsite = str("website_url");
  const website = rawWebsite ? normalizeSiteUrl(rawWebsite) : null;
  if (rawWebsite && !website) return { ok: false, error: "That website doesn't look like an address, e.g. acme.com." };

  const rawStore = str("store_page_url");
  const store = rawStore ? normalizeSiteUrl(rawStore) : null;
  if (rawStore && !store) return { ok: false, error: "That store page doesn't look like an address, e.g. acme.com/locations/tulsa." };

  const property = cleanSearchConsoleProperty(get("search_console_site_url"));
  if (property === undefined) {
    return { ok: false, error: "Enter the Search Console property as sc-domain:acme.com or https://www.acme.com/." };
  }

  const onlineOnly = get("online_only") === "on";
  const rawCountry = (str("country_code") ?? "").toUpperCase();
  const country = rawCountry === "USA" ? "US" : rawCountry || null;
  if (!onlineOnly && country && !/^[A-Z]{2}$/.test(country)) {
    return { ok: false, error: "Use a two-letter country code, like US." };
  }

  const update: LocationUpdate = {
    name,
    website_url: same(website, current.website_url),
    store_page_url: same(store, current.store_page_url),
    search_console_site_url: property,
    phone_number: str("phone_number"),
    address_line1: onlineOnly ? null : str("address_line1"),
    city: onlineOnly ? null : str("city"),
    region: onlineOnly ? null : str("region"),
    postal_code: onlineOnly ? null : str("postal_code"),
    // Kept when online-only: the country still scopes search data.
    country_code: country,
  };

  const changed = (Object.keys(update) as (keyof LocationRow)[]).filter((k) => (update[k] ?? null) !== (current[k] ?? null));
  if (ADDRESS_FIELDS.some((f) => changed.includes(f))) {
    update.lat = null;
    update.lng = null;
  }
  return { ok: true, update, changed };
}

/** True when the stored row already reads as online-only (no street, no city). */
export function isOnlineOnlyRow(row: Pick<LocationRow, "address_line1" | "city">): boolean {
  return !row.address_line1?.trim() && !row.city?.trim();
}
