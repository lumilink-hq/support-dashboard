// =============================================================================
// test-seo-location-form.ts — unit tests for lib/seo-location-form.ts, the
// location settings form on /seo?tab=settings.
//
//   npx tsx scripts/test-seo-location-form.ts
// =============================================================================

import { cleanSearchConsoleProperty, isOnlineOnlyRow, parseLocationForm, type LocationRow } from "../lib/seo-location-form.ts";

let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const stored: LocationRow = {
  name: "Acme Plumbing",
  website_url: "https://acme.com/",
  store_page_url: null,
  search_console_site_url: "sc-domain:acme.com",
  phone_number: "918-555-0142",
  address_line1: "12 Main St",
  city: "Tulsa",
  region: "OK",
  postal_code: "74103",
  country_code: "US",
};

// The form as it renders for `stored`, with overrides.
const form = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    name: stored.name,
    website_url: stored.website_url ?? "",
    store_page_url: "",
    search_console_site_url: stored.search_console_site_url ?? "",
    phone_number: stored.phone_number ?? "",
    address_line1: stored.address_line1 ?? "",
    city: stored.city ?? "",
    region: stored.region ?? "",
    postal_code: stored.postal_code ?? "",
    country_code: stored.country_code ?? "",
  };
  const all = { ...base, ...over };
  return (k: string) => all[k] ?? "";
};

console.log("\nunchanged form");
{
  const r = parseLocationForm(form(), stored);
  ok("parses", r.ok);
  ok("nothing changed", r.ok && r.changed.length === 0, r.ok ? r.changed : r);
  ok("coordinates kept", r.ok && !("lat" in r.update));
}

console.log("\nURL spelling");
{
  const noSlash = { ...stored, website_url: "https://acme.com" };
  const r = parseLocationForm(form({ website_url: "https://acme.com" }), noSlash);
  ok("a stored URL without a trailing slash is not 'changed' on re-save", r.ok && r.changed.length === 0 && r.update.website_url === "https://acme.com", r.ok ? r.changed : r);
  const typed = parseLocationForm(form({ website_url: "acme.com" }), noSlash);
  ok("typing the same site without https:// is not a change either", typed.ok && typed.changed.length === 0, typed.ok ? typed.changed : typed);
}

console.log("\nonline only (LumiLink's case, 2026-10-08)");
{
  const r = parseLocationForm(form({ online_only: "on" }), stored);
  ok("parses", r.ok);
  if (r.ok) {
    ok("clears street, city, region and postal code", r.update.address_line1 === null && r.update.city === null && r.update.region === null && r.update.postal_code === null);
    ok("keeps the country", r.update.country_code === "US");
    ok("resets the map position", r.update.lat === null && r.update.lng === null);
    ok("the result reads as online-only", isOnlineOnlyRow(r.update));
  }
  const already = { ...stored, address_line1: null, city: null, region: null, postal_code: null };
  const again = parseLocationForm(form({ online_only: "on", address_line1: "", city: "", region: "", postal_code: "" }), already);
  ok("saving online-only again changes nothing", again.ok && again.changed.length === 0, again.ok ? again.changed : again);
}

console.log("\naddress changes");
{
  const r = parseLocationForm(form({ address_line1: "14 Main St" }), stored);
  ok("a new street resets the map position", r.ok && r.update.lat === null && r.update.lng === null);
  ok("and is reported as changed", r.ok && r.changed.includes("address_line1"));
  const phone = parseLocationForm(form({ phone_number: "918-555-0199" }), stored);
  ok("a phone change keeps the map position", phone.ok && !("lat" in phone.update));
  const serviceArea = parseLocationForm(form({ address_line1: "" }), stored);
  ok("a city with no street is still local", serviceArea.ok && !isOnlineOnlyRow(serviceArea.update));
}

console.log("\nvalidation");
{
  const noName = parseLocationForm(form({ name: "  " }), stored);
  ok("a name is required", !noName.ok);
  const longName = parseLocationForm(form({ name: "x".repeat(121) }), stored);
  ok("a name over 120 characters is refused", !longName.ok);
  const bare = parseLocationForm(form({ website_url: "acme.org" }), stored);
  ok("a bare domain gets https://", bare.ok && bare.update.website_url?.startsWith("https://acme.org") === true, bare.ok ? bare.update.website_url : bare);
  const junk = parseLocationForm(form({ website_url: "not a site" }), stored);
  ok("a website that isn't an address is refused", !junk.ok);
  const noSite = parseLocationForm(form({ website_url: "" }), stored);
  ok("the website can be cleared", noSite.ok && noSite.update.website_url === null);
  const usa = parseLocationForm(form({ country_code: "usa" }), stored);
  ok("USA is stored as US", usa.ok && usa.update.country_code === "US");
  const badCountry = parseLocationForm(form({ country_code: "1" }), stored);
  ok("a country that isn't two letters is refused", !badCountry.ok);
  const badStore = parseLocationForm(form({ store_page_url: "menu" }), stored);
  ok("a store page that isn't an address is refused", !badStore.ok);
  const badProperty = parseLocationForm(form({ search_console_site_url: "acme.com" }), stored);
  ok("a Search Console property without sc-domain: or a scheme is refused", !badProperty.ok);
}

console.log("\ncleanSearchConsoleProperty");
ok("domain property, lower-cased", cleanSearchConsoleProperty(" sc-domain:Acme.com ") === "sc-domain:acme.com");
ok("URL prefix property gets its trailing slash", cleanSearchConsoleProperty("https://www.acme.com") === "https://www.acme.com/");
ok("URL prefix with a path is kept", cleanSearchConsoleProperty("https://acme.com/shop/") === "https://acme.com/shop/");
ok("blank clears it", cleanSearchConsoleProperty("") === null);
ok("junk is undefined (invalid)", cleanSearchConsoleProperty("sc-domain:") === undefined && cleanSearchConsoleProperty("acme") === undefined);

console.log(failures === 0 ? "\nAll location form tests passed.\n" : `\n${failures} location form test(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
