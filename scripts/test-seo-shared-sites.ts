// =============================================================================
// test-seo-shared-sites.ts — unit tests for module 29: several locations on one
// website (supabase/functions/seo-crawl/stores.ts, and the dashboard's split in
// lib/seo-portal.ts).
//
//   npx tsx scripts/test-seo-shared-sites.ts
//
// Fixtures are PACKS's real four stores on packsclub.com. No network, no Deno,
// no database.
// =============================================================================

import { hostOf, ISSUE_LABELS, splitSiteFindings } from "../lib/seo-portal";
import {
  auditStorePage,
  draftFactsFor,
  pageContainsAddress,
  pageKey,
  siteGroup,
  siteKey,
  type SiteMember,
  storeFor,
  storeLinkedFromHome,
  storePageMap,
  streetParts,
} from "../supabase/functions/seo-crawl/stores.ts";
import { buildUserPayload, SYSTEM_PROMPT } from "../supabase/functions/seo-draft/lib.ts";

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

type Loc = SiteMember & { city: string | null; region: string | null; address_line1: string | null };

const W = "https://www.packsclub.com";
const loc = (id: string, name: string, created: string, store: string | null, city: string, addr: string, extra: Partial<Loc> = {}): Loc => ({
  id,
  name,
  website_url: W,
  store_page_url: store,
  created_at: created,
  city,
  region: "CA",
  address_line1: addr,
  ...extra,
});

const OC = loc("oc", "PACKS OC – Santa Ana", "2026-10-06T23:20:00Z", `${W}/menu/orange-county`, "Santa Ana", "2840 S Croddy Way");
const SGV = loc("sgv", "PACKS SGV – El Monte", "2026-10-06T23:20:01Z", `${W}/menu/san-gabriel-valley`, "El Monte", "3551 Peck Rd");
const SB = loc("sb", "PACKS SB – San Bernardino", "2026-10-06T23:20:02Z", `${W}/menu/san-bernardino`, "San Bernardino", "2211 S Hunts Ln");
const HW = loc("hw", "PACKS Hollywood", "2026-10-06T23:20:03Z", `${W}/menu/south-los-angeles`, "Los Angeles", "1944 Cahuenga Blvd N");
const PACKS = [SGV, HW, OC, SB]; // deliberately not in age order

// -----------------------------------------------------------------------------
console.log("\nsiteKey / pageKey");
{
  ok("www, case and path don't matter", siteKey("https://WWW.PacksClub.com/menu/x") === "packsclub.com");
  ok("http and https are the same site", siteKey("http://packsclub.com") === siteKey("https://www.packsclub.com/"));
  ok("a bare domain counts", siteKey("packsclub.com") === "packsclub.com");
  ok("a default port is dropped, another kept", siteKey("https://acme.com:443/") === "acme.com" && siteKey("http://localhost:8080/x") === "localhost:8080");
  ok("not a website: empty, mailto, ftp", siteKey("") === null && siteKey(null) === null && siteKey("mailto:a@b.com") === null && siteKey("ftp://acme.com") === null);
  ok("a subdomain is a different website", siteKey("https://shop.acme.com") !== siteKey("https://acme.com"));
  ok(
    "pageKey ignores www, scheme, trailing slash, fragment and utm",
    pageKey("http://packsclub.com/menu/orange-county/#top") === pageKey(`${W}/menu/orange-county?utm_source=gbp`),
    [pageKey("http://packsclub.com/menu/orange-county/#top"), pageKey(`${W}/menu/orange-county?utm_source=gbp`)],
  );
  ok("pageKey keeps real query strings and distinct paths", pageKey(`${W}/menu?store=oc`) !== pageKey(`${W}/menu?store=sb`) && pageKey(`${W}/a`) !== pageKey(`${W}/b`));
  ok("the homepage's key", pageKey(W) === "packsclub.com/" && pageKey(`${W}/`) === "packsclub.com/");
}

// -----------------------------------------------------------------------------
console.log("\nsiteGroup: one website, one primary");
{
  const g = siteGroup(PACKS, SB)!;
  ok("all four stores share the website", g.members.length === 4 && g.shared);
  ok("the oldest is primary, whoever asks", g.primary.id === "oc" && siteGroup(PACKS, HW)!.primary.id === "oc");
  ok("members are in age order", g.members.map((m) => m.id).join(",") === "oc,sgv,sb,hw");
  const tie = [loc("b", "B", "2026-01-01T00:00:00Z", null, "", ""), loc("a", "A", "2026-01-01T00:00:00Z", null, "", "")];
  ok("a created_at tie falls back to id (as the SQL view does)", siteGroup(tie, tie[0])!.primary.id === "a");
  const other = loc("x", "Other site", "2020-01-01T00:00:00Z", null, "", "", { website_url: "https://example.com" });
  const solo = siteGroup([...PACKS, other], other)!;
  ok("a location on another website is on its own", !solo.shared && solo.members.length === 1 && solo.primary.id === "x");
  ok("and doesn't join PACKS's group", siteGroup([...PACKS, other], OC)!.members.length === 4);
  ok("a location missing from the list still counts", siteGroup([SGV], OC)!.primary.id === "oc");
  ok("no website: no group", siteGroup(PACKS, { ...OC, website_url: null }) === null);
}

// -----------------------------------------------------------------------------
console.log("\nstore pages");
{
  const g = siteGroup(PACKS, OC)!;
  const stores = storePageMap(g, W);
  ok("one store page per store", stores.size === 4);
  ok("each page maps to its store", storeFor(stores, `${W}/menu/orange-county`)?.id === "oc" && storeFor(stores, `${W}/menu/south-los-angeles`)?.id === "hw");
  ok("www and trailing slash don't hide a store page", storeFor(stores, "https://packsclub.com/menu/san-bernardino/")?.id === "sb");
  ok("the homepage of a shared site is nobody's store page", storeFor(stores, W) === null && storeFor(stores, `${W}/`) === null);
  ok("an ordinary page is nobody's", storeFor(stores, `${W}/products/packs-hat-red`) === null);
  ok("a redirect target can identify the store", storeFor(stores, `${W}/oc`, `${W}/menu/orange-county`)?.id === "oc");

  const offsite = { ...SGV, store_page_url: "https://menu.aiq.example/sgv" };
  const g2 = siteGroup([OC, offsite], OC)!;
  ok("a store page on another website is ignored", storePageMap(g2, W).size === 1);

  const single = loc("one", "Harbor Plumbing", "2026-01-01T00:00:00Z", null, "Tacoma", "1 Main St", { website_url: "https://harbor.example" });
  const sg = siteGroup([single], single)!;
  const sm = storePageMap(sg, "https://www.harbor.example/");
  ok("a single-location site's store page is its homepage, where it lands", sm.size === 1 && storeFor(sm, "https://harbor.example")?.id === "one");
  const singleWithPage = { ...single, store_page_url: "https://harbor.example/contact" };
  const sp = storePageMap(siteGroup([singleWithPage], singleWithPage)!, "https://harbor.example/");
  ok("unless it has a store page of its own", sp.size === 1 && storeFor(sp, "https://harbor.example/contact")?.id === "one" && storeFor(sp, "https://harbor.example/") === null);
}

// -----------------------------------------------------------------------------
console.log("\nstreet address");
{
  ok("2840 S Croddy Way", JSON.stringify(streetParts("2840 S Croddy Way")) === JSON.stringify({ number: "2840", word: "croddy" }), streetParts("2840 S Croddy Way"));
  ok("1944 Cahuenga Blvd N", streetParts("1944 Cahuenga Blvd N")?.word === "cahuenga");
  ok("3551 Peck Rd", streetParts("3551 Peck Rd")?.word === "peck");
  ok("2211 S Hunts Ln", streetParts("2211 S Hunts Ln")?.word === "hunts");
  ok("unit letters and suites", streetParts("12B Old Mill Rd Suite 4")?.number === "12" && streetParts("12B Old Mill Rd Suite 4")?.word === "mill");
  ok("no number or no name word: nothing to check", streetParts("PO Box") === null && streetParts("100 N") === null && streetParts(null) === null);

  // The real titles of the two pages (fetched 2026-10-07).
  const ocPage = "<html><head><title>PACKS OC - Santa Ana | 2840 South Croddy Way Santa Ana, CA 92704</title></head><body><h1>PACKS OC</h1></body></html>";
  const slaPage = "<html><body><h1>PACKS Weed Dispensary South Los Angeles</h1><p>Wilmington Avenue, Los Angeles, CA</p></body></html>";
  ok("OC's page carries its address, spelled differently", pageContainsAddress(ocPage, OC.address_line1));
  ok("the old South LA page doesn't carry Hollywood's", !pageContainsAddress(slaPage, HW.address_line1));
  ok("the number alone isn't enough", !pageContainsAddress("<p>Call 1944 times</p>", HW.address_line1));
  ok("a number inside a longer one doesn't count", !pageContainsAddress("<p>21944 Cahuenga</p>", HW.address_line1));
  ok("text in a script doesn't count", !pageContainsAddress("<script>var a='1944 Cahuenga'</script><p>hi</p>", HW.address_line1));
}

// -----------------------------------------------------------------------------
console.log("\nauditStorePage");
{
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  const good = `<html><body><p>${words(80)}</p><p>1944 Cahuenga Blvd</p></body></html>`;
  ok("a readable page with the address: nothing", auditStorePage({ html: good, status: 200, wordCount: 83 }, HW, { shared: true }).length === 0);

  const sla = `<html><body><p>${words(80)}</p><p>Wilmington Ave</p></body></html>`;
  const f = auditStorePage({ html: sla, status: 200, wordCount: 82 }, HW, { shared: true });
  ok("the wrong store's address is flagged", f.length === 1 && f[0].finding_type === "address_not_on_page" && f[0].severity === "warning", f);

  const empty = auditStorePage({ html: "<div id=app></div><p>1944 Cahuenga</p>", status: 200, wordCount: 2 }, HW, { shared: true });
  ok("an empty shell (menu by JavaScript) is flagged", empty.some((x) => x.finding_type === "store_page_needs_javascript"));

  const broken = auditStorePage({ html: null, status: 404, wordCount: null }, HW, { shared: true });
  ok("a broken store page is critical, with its status", broken.length === 1 && broken[0].finding_type === "store_page_unreachable" && broken[0].severity === "critical" && /404/.test(broken[0].title), broken);
  const down = auditStorePage({ html: null, status: 0, wordCount: null }, HW, { shared: true });
  ok("no answer at all says so", /couldn't be fetched/.test(down[0].title));

  ok("a single-location homepage: no JS or broken rules (the crawl has its own)", auditStorePage({ html: null, status: 500, wordCount: null }, HW, { shared: false }).length === 0 && auditStorePage({ html: "<p>1944 Cahuenga</p>", status: 200, wordCount: 2 }, HW, { shared: false }).length === 0);
  ok("a store with no usable address skips the address rule", auditStorePage({ html: sla, status: 200, wordCount: 82 }, { ...HW, address_line1: null }, { shared: true }).length === 0);
}

// -----------------------------------------------------------------------------
console.log("\nlinked from the homepage");
{
  const homeLinks = [`${W}/menu/orange-county`, `${W}/menu/san-gabriel-valley`, "https://packsclub.com/menu/south-los-angeles/", `${W}/collections/hats`];
  ok("linked (exact)", storeLinkedFromHome(homeLinks, `${W}/menu/orange-county`));
  ok("linked (www and slash differ)", storeLinkedFromHome(homeLinks, `${W}/menu/south-los-angeles`));
  ok("not linked", !storeLinkedFromHome(homeLinks, `${W}/menu/san-bernardino`));
  ok("a bad URL is never linked", !storeLinkedFromHome(homeLinks, "not a url"));
}

// -----------------------------------------------------------------------------
console.log("\ndraft facts");
{
  const g = siteGroup(PACKS, SGV)!;
  const shared = draftFactsFor(SGV, g, `${W}/collections/hats`, "PACKS");
  ok("a shared page gets the brand and no city", shared.scope === "site" && shared.facts.name === "PACKS" && shared.facts.city === null, shared);
  ok("and the region every store shares", shared.facts.region === "CA");
  const own = draftFactsFor(SGV, g, "https://packsclub.com/menu/san-gabriel-valley/", "PACKS");
  ok("its own store page gets its own facts", own.scope === "store" && own.facts.name === SGV.name && own.facts.city === "El Monte", own);
  const others = draftFactsFor(SGV, g, `${W}/menu/orange-county`, "PACKS");
  ok("another store's page is not SGV's to name", others.scope === "site" && others.facts.city === null);
  const mixed = siteGroup([...PACKS, { ...SB, id: "nv", created_at: "2027-01-01T00:00:00Z", region: "NV" }], OC)!;
  ok("stores in different states: no region", draftFactsFor(OC, mixed, `${W}/`, "PACKS").facts.region === null);
  ok("no brand name: falls back to the location's", draftFactsFor(OC, g, `${W}/`, null).facts.name === OC.name);
  ok("blank brand name: same", draftFactsFor(OC, g, `${W}/`, "  ").facts.name === OC.name);

  const single = loc("one", "Harbor Plumbing", "2026-01-01T00:00:00Z", null, "Tacoma", "1 Main St", { website_url: "https://harbor.example" });
  const s = draftFactsFor(single, siteGroup([single], single), "https://harbor.example/services", "Harbor");
  ok("a single-location site keeps its own facts on every page (unchanged)", s.scope === "store" && s.facts.name === "Harbor Plumbing" && s.facts.city === "Tacoma");
  ok("no group at all: own facts", draftFactsFor(single, null, null, "Harbor").facts.city === "Tacoma");

  const payload = JSON.parse(
    buildUserPayload("meta_description", { ...OC, phone_number: null, postal_code: null, country_code: null, primary_category: "Cannabis store", ...shared.facts }, null, `${W}/collections/hats`),
  );
  ok("the payload carries the brand, no city", payload.business_name === "PACKS" && payload.city === null && payload.page_path === "/collections/hats", payload);
  ok("the system prompt says what an empty city means", /city is empty/i.test(SYSTEM_PROMPT));
}

// -----------------------------------------------------------------------------
console.log("\ndashboard split");
{
  const rows = [
    { location_id: "oc", scope: null, finding_type: "missing_meta_description" },
    { location_id: "oc", scope: "store", finding_type: "address_not_on_page" },
    { location_id: "hw", scope: "store", finding_type: "address_not_on_page" },
    { location_id: "hw", scope: null, finding_type: "stray" },
  ];
  const fromHw = splitSiteFindings(rows, { shared: true, primaryId: "oc", locationId: "hw" });
  ok("Hollywood sees the website's issues (held by OC)", fromHw.site.length === 1 && fromHw.site[0].finding_type === "missing_meta_description");
  ok("and only its own store page's", fromHw.store.length === 1 && fromHw.store[0].location_id === "hw");
  const fromOc = splitSiteFindings(rows, { shared: true, primaryId: "oc", locationId: "oc" });
  ok("OC's own store issue isn't shown as the website's", fromOc.site.length === 1 && fromOc.store.length === 1 && fromOc.store[0].location_id === "oc");
  const solo = splitSiteFindings([{ location_id: "x", scope: "store", finding_type: "a" }, { location_id: "x", scope: null, finding_type: "b" }], { shared: false, primaryId: "x", locationId: "x" });
  ok("a website with one location shows everything as before", solo.site.length === 2 && solo.store.length === 0);
  ok("hostOf", hostOf(`${W}/menu/x`) === "packsclub.com" && hostOf(null) === null && hostOf("nope") === null);
  ok(
    "every new finding type has a plain label",
    ["address_not_on_page", "store_page_unreachable", "store_page_needs_javascript", "store_page_not_linked_from_homepage", "store_page_not_set"].every((t) => !!ISSUE_LABELS[t]),
  );
  ok("the schema and phone labels no longer say homepage", !/homepage/i.test(ISSUE_LABELS.missing_local_business_schema) && !/homepage/i.test(ISSUE_LABELS.phone_not_on_page));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
