// =============================================================================
// test-seo-location-details.ts — unit tests for module 28: cleaning the
// local-detail intake (seo-content/details.ts), the prompt payload, and which
// claims module 16's validator lets through with and without vouched facts
// (seo-content/lib.ts).
//
//   npx tsx scripts/test-seo-location-details.ts
//
// No network, no Deno, no database.
// =============================================================================

import { cleanItem, cleanList, cleanYear, detailsUsed, emptyDetails, type LocationDetails } from "../supabase/functions/seo-content/details.ts";
import { buildArticlePayload, payloadDetails, SYSTEM_PROMPT, validateArticle, type ParsedOutput } from "../supabase/functions/seo-content/lib.ts";

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

const NOW = new Date("2026-10-02T00:00:00Z");

const details = (over: Partial<LocationDetails> = {}): LocationDetails => ({ ...emptyDetails(), ...over });

/** A valid article (passes every non-claim rule) with `extra` added to the body. */
function article(extra: string): ParsedOutput {
  const para = "Clogged drains are a common problem in older Springfield homes, and most of them start small. ".repeat(8); // 4 x 128 words: over the 450-word minimum
  return {
    title: "Drain cleaning in Springfield: what to expect",
    meta: "What a drain cleaning visit in Springfield involves, how long it takes, and how to keep drains clear afterwards.",
    image_brief: "A plumber's toolbag beside a kitchen sink with the cabinet doors open, morning light.",
    alt: "Plumbing tools beside an open kitchen sink cabinet",
    html: `<p>${para}</p><h2>Why drains clog</h2><p>${para}</p><h2>What we do</h2><p>${para} ${extra}</p><h2>After the visit</h2><p>${para}</p>`,
  };
}
const ctx = (d: LocationDetails | null) => ({ keyword: "drain cleaning springfield", city: "Springfield", details: d, thisYear: 2026 });
const verdict = (extra: string, d: LocationDetails | null) => validateArticle(article(extra), ctx(d));

console.log("\ncleaning what the client types");
{
  ok("an ordinary item is kept, spaces collapsed", cleanItem("  Midtown   Springfield ", 60) === "Midtown Springfield");
  ok("too short, too long, URL, markup and phone-shaped are dropped",
    cleanItem("a", 60) === null && cleanItem("x".repeat(61), 60) === null && cleanItem("see www.acme.com", 60) === null && cleanItem("<b>Midtown</b>", 60) === null && cleanItem("call 555 555 0100", 60) === null);
  ok("control characters become spaces", cleanItem("Mid\u0000town", 60) === "Mid town");
  const r = cleanList("Midtown\n\nmidtown\nDowntown\nhttp://x.com\n" + Array.from({ length: 30 }, (_, i) => `Area ${i}`).join("\n"), "service_areas");
  ok("one per line, blank lines ignored, case-insensitive duplicates and bad lines dropped, capped at 20", r.items.length === 20 && r.items[0] === "Midtown" && r.items[1] === "Downtown" && r.dropped === 14, r);
  ok("a past year, not a future one, not 1700, not text", cleanYear("2004", NOW) === 2004 && cleanYear("2027", NOW) === null && cleanYear("1700", NOW) === null && cleanYear("twenty", NOW) === null && cleanYear("", NOW) === null);
}

console.log("\nthe prompt payload");
{
  ok("no intake: exactly the old payload (no extra keys)", Object.keys(JSON.parse(buildArticlePayload({ name: "Acme", city: "Springfield", region: "IL", primary_category: "Plumber" }, "drain cleaning"))).join(",") === "business_name,category,city,region,keyword,target_words");
  ok("an empty intake adds nothing", Object.keys(payloadDetails(emptyDetails())).length === 0);
  const p = JSON.parse(buildArticlePayload({ name: "Acme", city: "Springfield", region: "IL", primary_category: "Plumber", details: details({ service_areas: ["Midtown"], services: ["drain cleaning"], year_founded: 2004, insured: true, guarantee: "a one-year labour warranty" }) }, "drain cleaning"));
  ok("lists and only the true facts go in", JSON.stringify(p.service_areas) === '["Midtown"]' && !("nearby_landmarks" in p) && p.vouched_facts.year_founded === 2004 && p.vouched_facts.insured === true && !("licensed" in p.vouched_facts) && p.vouched_facts.guarantee === "a one-year labour warranty", p);
  ok("the system prompt stays a constant that tells the model how to use them", SYSTEM_PROMPT.includes("vouched_facts") && SYSTEM_PROMPT.includes("service_areas") && !SYSTEM_PROMPT.includes("Midtown"));
}

console.log("\nclaims: blocked without the intake (unchanged)");
{
  ok("a plain article passes", verdict("", null).ok);
  for (const claim of ["We are licensed and insured.", "Serving Springfield since 2004.", "A family-owned business.", "Every job is guaranteed.", "Call for a free estimate."]) {
    ok(`refused with no intake: ${claim}`, !verdict(claim, null).ok);
    ok(`refused with an empty intake: ${claim}`, !verdict(claim, emptyDetails()).ok);
  }
}

console.log("\nclaims: allowed only by the matching fact");
{
  ok("licensed and insured, both vouched", verdict("We are licensed and insured.", details({ licensed: true, insured: true })).ok);
  const half = verdict("We are licensed and insured.", details({ licensed: true }));
  ok("licensed vouched, insured not → refused, naming the phrase", !half.ok && /"insured"/.test(half.ok ? "" : half.reason), half);
  ok("bonded", verdict("We are bonded.", details({ bonded: true })).ok && !verdict("We are bonded.", details({ licensed: true })).ok);
  ok("certified needs a certification on file", verdict("Our technicians are certified.", details({ certifications: ["NATE"] })).ok && !verdict("Our technicians are certified.", details({ licensed: true })).ok);
  ok("award-winning needs an award on file", verdict("An award-winning team.", details({ awards: ["Best of Springfield 2025"] })).ok && !verdict("An award-winning team.", details({ certifications: ["NATE"] })).ok);

  const founded = details({ year_founded: 2004 });
  ok("since the founding year", verdict("Serving Springfield since 2004.", founded).ok);
  ok("since a different year is refused", !verdict("Serving Springfield since 1998.", founded).ok);
  ok("over 20 years when founded 2004 (22 years)", verdict("For over 20 years we have cleared drains.", founded).ok);
  ok("more than 30 years is refused", !verdict("For more than 30 years we have cleared drains.", founded).ok);
  ok("22+ years of experience allowed, 23+ refused", verdict("With 22+ years of experience.", founded).ok && !verdict("With 23+ years of experience.", founded).ok);
  ok("nearly allows one year of slack", verdict("For nearly 23 years now.", founded).ok && !verdict("For nearly 24 years now.", founded).ok);

  ok("family-owned / locally owned each need their own box", verdict("A family-owned business.", details({ family_owned: true })).ok && !verdict("A family-owned business.", details({ locally_owned: true })).ok && verdict("We are locally owned.", details({ locally_owned: true })).ok);
  ok("guarantee needs the guarantee text", verdict("Every job is guaranteed.", details({ guarantee: "a one-year labour warranty" })).ok);
  ok("free estimates / quotes need the box", verdict("Ask for a free estimate or free quotes.", details({ free_estimates: true })).ok && !verdict("Ask for a free estimate.", details({ licensed: true })).ok);
  ok("'affordable' and 'cheapest' are never allowed", !verdict("Affordable drain cleaning.", details({ free_estimates: true })).ok && !verdict("The cheapest in town.", details({ free_estimates: true })).ok);
  ok("percentages and superlatives are never allowed", !verdict("95% of clogs clear in an hour.", details({ year_founded: 2004, licensed: true })).ok && !verdict("The best plumber in Springfield.", details({ awards: ["x x"] })).ok);
  ok("every occurrence must be backed, not just the first", !verdict("Since 2004 we have been here, and since 1990 our family has fixed pipes.", founded).ok);
}

console.log("\ndetailsUsed");
{
  const d = details({ service_areas: ["Midtown", "Oak Park"], landmarks: ["County Fairgrounds"], services: ["Drain cleaning"] });
  ok("lists the items the article mentions, case-insensitive", JSON.stringify(detailsUsed(d, "We often work in midtown near the county fairgrounds, mostly drain cleaning.")) === '["Midtown","County Fairgrounds","Drain cleaning"]');
  ok("no intake → none", detailsUsed(null, "anything").length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
