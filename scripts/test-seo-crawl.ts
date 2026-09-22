// =============================================================================
// test-seo-crawl.ts — unit tests for the seo-crawl pure helpers (module 6).
//
//   npx tsx scripts/test-seo-crawl.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  auditPage,
  discoverLinks,
  extractCanonical,
  extractH1s,
  extractImages,
  extractMetaDescription,
  extractTitle,
  hasLocalBusinessSchema,
  isAllowedByRobots,
  normalizeUrl,
  pageContainsPhone,
  visibleWordCount,
} from "../supabase/functions/seo-crawl/lib.ts";

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

// ---------------------------------------------------------------------------
console.log("\nextractTitle");
// ---------------------------------------------------------------------------
{
  ok("finds a normal title", extractTitle("<title>Acme Heating | Austin TX</title>") === "Acme Heating | Austin TX");
  ok("decodes entities", extractTitle("<title>Acme &amp; Sons</title>") === "Acme & Sons");
  ok("null when absent", extractTitle("<html><body>no title here</body></html>") === null);
  ok("null when empty", extractTitle("<title>   </title>") === null);
}

// ---------------------------------------------------------------------------
console.log("\nextractMetaDescription");
// ---------------------------------------------------------------------------
{
  ok(
    "name before content",
    extractMetaDescription('<meta name="description" content="We fix HVAC in Austin.">') === "We fix HVAC in Austin.",
  );
  ok(
    "content before name (order-agnostic)",
    extractMetaDescription('<meta content="Order-agnostic desc." name="description">') === "Order-agnostic desc.",
  );
  ok("ignores other meta tags", extractMetaDescription('<meta name="viewport" content="width=device-width">') === null);
  ok("null when no description meta at all", extractMetaDescription("<head></head>") === null);
}

// ---------------------------------------------------------------------------
console.log("\nextractCanonical");
// ---------------------------------------------------------------------------
{
  ok(
    "finds canonical href",
    extractCanonical('<link rel="canonical" href="https://acme.com/services">') === "https://acme.com/services",
  );
  ok("null when absent", extractCanonical('<link rel="stylesheet" href="/style.css">') === null);
}

// ---------------------------------------------------------------------------
console.log("\nextractH1s");
// ---------------------------------------------------------------------------
{
  const one = extractH1s("<h1>Emergency HVAC Repair</h1><p>text</p>");
  ok("finds one H1", one.length === 1 && one[0] === "Emergency HVAC Repair", one);

  const two = extractH1s("<h1>First</h1><h1>Second</h1>");
  ok("finds multiple H1s", two.length === 2, two);

  ok("empty array when none", extractH1s("<h2>Not an H1</h2>").length === 0);

  const nested = extractH1s('<h1><span class="hl">Austin</span> HVAC Repair</h1>');
  ok("strips nested tags from H1 text", nested[0] === "Austin HVAC Repair", nested);
}

// ---------------------------------------------------------------------------
console.log("\nextractImages");
// ---------------------------------------------------------------------------
{
  const imgs = extractImages(
    '<img src="/a.jpg" alt="A technician repairing a furnace"><img src="/b.jpg" alt=""><img src="/c.jpg">',
  );
  ok("finds 3 images", imgs.length === 3, imgs);
  ok("alt text captured", imgs[0].alt === "A technician repairing a furnace");
  ok("empty alt is '' not null (decorative, not a violation on its own)", imgs[1].alt === "");
  ok("missing alt attribute is null", imgs[2].alt === null);
  ok("no src, no entry", extractImages('<img alt="orphan, no src">').length === 0);
}

// ---------------------------------------------------------------------------
console.log("\nhasLocalBusinessSchema");
// ---------------------------------------------------------------------------
{
  const withSchema = `<script type="application/ld+json">
    {"@context":"https://schema.org","@type":"LocalBusiness","name":"Acme Heating"}
  </script>`;
  ok("detects a direct LocalBusiness block", hasLocalBusinessSchema(withSchema));

  const subtype = `<script type="application/ld+json">{"@type":"Restaurant","name":"Acme Diner"}</script>`;
  ok("detects a recognised subtype (Restaurant)", hasLocalBusinessSchema(subtype));

  const graph = `<script type="application/ld+json">
    {"@graph":[{"@type":"WebSite"},{"@type":"LocalBusiness","name":"Acme"}]}
  </script>`;
  ok("finds it inside @graph", hasLocalBusinessSchema(graph));

  const arrayType = `<script type="application/ld+json">{"@type":["Organization","LocalBusiness"]}</script>`;
  ok("finds it when @type is an array", hasLocalBusinessSchema(arrayType));

  ok("false when no JSON-LD at all", !hasLocalBusinessSchema("<p>no schema here</p>"));

  const wrongType = `<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>`;
  ok("false for an unrelated schema type", !hasLocalBusinessSchema(wrongType));

  const malformedThenValid = `
    <script type="application/ld+json">{ this is not json }</script>
    <script type="application/ld+json">{"@type":"LocalBusiness"}</script>
  `;
  ok(
    "one malformed JSON-LD block doesn't stop a later valid one from counting",
    hasLocalBusinessSchema(malformedThenValid),
  );
}

// ---------------------------------------------------------------------------
console.log("\nvisibleWordCount");
// ---------------------------------------------------------------------------
{
  const html = "<p>" + "word ".repeat(50) + "</p>";
  ok("counts ~50 words", visibleWordCount(html) >= 48 && visibleWordCount(html) <= 52, visibleWordCount(html));

  const withScript = `<script>var junk = "not real content not real content not real content";</script><p>four real words here</p>`;
  ok("excludes script content from the count", visibleWordCount(withScript) === 4, visibleWordCount(withScript));

  ok("zero for empty page", visibleWordCount("<html><body></body></html>") === 0);
}

// ---------------------------------------------------------------------------
console.log("\npageContainsPhone");
// ---------------------------------------------------------------------------
{
  const html = "<p>Call us at (213) 555-0100 today!</p>";
  ok("matches formatted vs stored E.164", pageContainsPhone(html, "+12135550100"));
  ok("matches when page uses dashes", pageContainsPhone("<p>213-555-0100</p>", "+12135550100"));
  ok("false when phone truly absent", !pageContainsPhone("<p>no number here</p>", "+12135550100"));
  ok("false when location has no stored phone", !pageContainsPhone(html, null));
}

// ---------------------------------------------------------------------------
console.log("\nauditPage — the rule set end to end");
// ---------------------------------------------------------------------------
{
  const goodPage = `
    <html><head>
      <title>Emergency HVAC Repair in Austin, TX | Acme Heating</title>
      <meta name="description" content="Same-day emergency HVAC repair across Austin, TX. Licensed technicians, upfront pricing, 24/7 dispatch.">
      <script type="application/ld+json">{"@type":"LocalBusiness","name":"Acme Heating","telephone":"+12135550100"}</script>
    </head><body>
      <h1>Emergency HVAC Repair in Austin</h1>
      <p>${"Acme Heating has served Austin homeowners with fast, licensed, upfront-priced repairs for over twenty years. ".repeat(25)}</p>
      <img src="/van.jpg" alt="Acme Heating service van outside a home in Austin">
      <p>Call (213) 555-0100 any time, day or night.</p>
    </body></html>`;
  const goodFindings = auditPage(goodPage, { name: "Acme Heating", phone_number: "+12135550100" });
  ok("a well-formed page produces no findings", goodFindings.length === 0, goodFindings);

  const badPage = `<html><head></head><body><h2>Not an H1</h2><p>Too short.</p></body></html>`;
  const badFindings = auditPage(badPage, { name: "Acme Heating", phone_number: "+12135550100" });
  const types = badFindings.map((f) => f.finding_type);
  ok("flags missing title", types.includes("missing_title"));
  ok("flags missing meta description", types.includes("missing_meta_description"));
  ok("flags missing H1", types.includes("missing_h1"));
  ok("flags missing schema", types.includes("missing_local_business_schema"));
  ok("flags thin content", types.includes("thin_content"));
  ok("flags phone not on page", types.includes("phone_not_on_page"));
  ok("missing_title is critical", badFindings.find((f) => f.finding_type === "missing_title")?.severity === "critical");

  const twoH1sPage = `<title>Fine Title Here For This Page</title><h1>First</h1><h1>Second</h1>`;
  const twoH1sFindings = auditPage(twoH1sPage, { name: null, phone_number: null });
  ok(
    "flags multiple H1s distinctly from missing H1",
    twoH1sFindings.some((f) => f.finding_type === "multiple_h1")
      && !twoH1sFindings.some((f) => f.finding_type === "missing_h1"),
  );

  // No stored phone at all: the phone_not_on_page check must not fire (there's
  // nothing to compare against, not a violation).
  const noPhoneOnFile = auditPage(goodPage, { name: "Acme Heating", phone_number: null });
  ok(
    "phone_not_on_page never fires when the location has no phone on file",
    !noPhoneOnFile.some((f) => f.finding_type === "phone_not_on_page"),
  );
}

// ---------------------------------------------------------------------------
console.log("\ndiscoverLinks / normalizeUrl / isAllowedByRobots — copied fetch layer sanity");
// ---------------------------------------------------------------------------
{
  const html = `<a href="/services">Services</a><a href="https://acme.com/contact">Contact</a>
    <a href="https://other-domain.com/x">Off-site</a><a href="/cart">Cart</a><a href="/image.jpg">img</a>`;
  const links = discoverLinks(html, "https://acme.com/");
  ok("keeps same-domain page links", links.includes("https://acme.com/services"));
  ok("drops off-domain links", !links.some((l) => l.includes("other-domain.com")));
  ok("drops skip-listed paths (cart)", !links.some((l) => l.includes("/cart")));
  ok("drops non-page extensions", !links.some((l) => l.endsWith(".jpg")));

  ok("normalizeUrl strips utm params", normalizeUrl("https://acme.com/a?utm_source=fb&x=1") === "https://acme.com/a?x=1");
  ok("normalizeUrl drops trailing slash", normalizeUrl("https://acme.com/a/") === "https://acme.com/a");

  const robots = "User-agent: *\nDisallow: /admin\n";
  ok("robots disallows /admin", !isAllowedByRobots(robots, "/admin/edit"));
  ok("robots allows everything else", isAllowedByRobots(robots, "/services"));
  ok("no robots.txt fails open", isAllowedByRobots(null, "/anything"));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
