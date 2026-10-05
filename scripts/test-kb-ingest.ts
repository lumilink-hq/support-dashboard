// =============================================================================
// test-kb-ingest.ts — unit tests for the kb-ingest pure helpers.
//
//   npx tsx scripts/test-kb-ingest.ts
//
// No network, no Deno, no database. Everything here is a decision that changes
// what the agent knows, so it is worth pinning down away from the wiring.
// =============================================================================

import {
  CHUNK_TARGET_CHARS,
  chunkText,
  contentHash,
  decodeEntities,
  discoverLinks,
  extractTitle,
  hasUsableText,
  htmlToText,
  isAllowedByRobots,
  normalizeSiteUrl,
  normalizeUrl,
} from "../supabase/functions/kb-ingest/lib.ts";

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
console.log("\nhtmlToText — what the agent ends up learning");
// ---------------------------------------------------------------------------
{
  const html = `
    <html><head><title>Acme Heating</title>
    <style>.a{color:red}</style><script>var x = "call us now";</script></head>
    <body>
      <nav><a href="/">Home</a><a href="/blog">Blog</a></nav>
      <h1>Our services</h1>
      <p>We service all of Los Angeles County.</p>
      <p>AC repair from &pound;89 &mdash; call-out included.</p>
      <footer>Copyright 2026 Acme</footer>
    </body></html>`;

  const text = htmlToText(html);

  ok("keeps body copy", text.includes("We service all of Los Angeles County."));
  ok("drops <script> contents", !text.includes("call us now"), text.slice(0, 80));
  ok("drops <style> contents", !text.includes("color:red"));
  // Nav and footer repeat on every page; left in, they become the most common
  // text in the corpus and dominate retrieval.
  ok("drops nav", !text.includes("Home"));
  ok("drops footer", !text.includes("Copyright 2026"));
  ok("decodes entities", text.includes("—"), text);

  // The classic failure: "</p><p>" welding two sentences into one word.
  ok(
    "block tags become boundaries, not welds",
    !/County\.AC/.test(text),
    text,
  );
}

{
  // Unclosed <svg> is common in icon sprites and would otherwise swallow the
  // rest of the document with a greedy match.
  const text = htmlToText("<p>Before</p><svg viewBox='0 0 1 1'><p>After</p>");
  ok("survives an unclosed dropped element", text.includes("After"), text);
}

ok("empty input is empty output", htmlToText("") === "");

// ---------------------------------------------------------------------------
console.log("\nhasUsableText — catching JavaScript-rendered sites");
// ---------------------------------------------------------------------------
{
  // A client-rendered site returns a shell. Embedding it marks the document
  // 'ready' and tells the client their site is synced when nothing was learned.
  const shell = htmlToText(
    `<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>`,
  );
  ok("rejects an empty SPA shell", !hasUsableText(shell), shell);
  ok(
    "accepts a real page",
    hasUsableText("We are open Monday to Friday, eight until five. ".repeat(6)),
  );
}

// ---------------------------------------------------------------------------
console.log("\ndiscoverLinks — shallow, same-host, no junk");
// ---------------------------------------------------------------------------
{
  const html = `
    <a href="/about">About</a>
    <a href="/services/ac-repair">AC repair</a>
    <a href="https://acme.com/pricing">Pricing</a>
    <a href="https://shop.acme.com/store">Shop</a>
    <a href="https://facebook.com/acme">Facebook</a>
    <a href="/brochure.pdf">Brochure</a>
    <a href="/cart">Cart</a>
    <a href="/wp-admin/index.php">Admin</a>
    <a href="mailto:hi@acme.com">Email</a>
    <a href="tel:+13105551234">Call</a>
    <a href="#top">Top</a>
    <a href="/about/">About again</a>`;

  const links = discoverLinks(html, "https://acme.com/");

  ok("finds relative links", links.includes("https://acme.com/about"));
  ok("finds nested paths", links.includes("https://acme.com/services/ac-repair"));
  ok("finds absolute same-host links", links.includes("https://acme.com/pricing"));

  // A subdomain is routinely a different system. "Shallow crawl" becoming
  // "discovered your whole storefront" is a surprise with real consequences.
  ok("excludes subdomains", !links.some((l) => l.includes("shop.acme.com")), links);
  ok("excludes other domains", !links.some((l) => l.includes("facebook")));
  ok("excludes non-page files", !links.some((l) => l.includes(".pdf")));
  ok("excludes cart/checkout", !links.some((l) => l.includes("/cart")));
  ok("excludes wp-admin", !links.some((l) => l.includes("wp-admin")));
  ok("excludes mailto/tel", !links.some((l) => /mailto|tel:/.test(l)));
  ok("excludes bare fragments", !links.some((l) => l.includes("#")));

  // /about and /about/ are one page. Two documents means duplicate chunks,
  // which the caller hears as the agent repeating itself.
  ok(
    "de-duplicates trailing-slash variants",
    links.filter((l) => l.endsWith("/about")).length === 1,
    links,
  );

  ok("respects the limit", discoverLinks(html, "https://acme.com/", 2).length === 2);
}

// ---------------------------------------------------------------------------
console.log("\nnormalizeUrl / normalizeSiteUrl");
// ---------------------------------------------------------------------------
{
  ok(
    "strips utm parameters",
    normalizeUrl("https://a.com/p?utm_source=fb&id=3") === "https://a.com/p?id=3",
    normalizeUrl("https://a.com/p?utm_source=fb&id=3"),
  );
  ok("strips fragments", normalizeUrl("https://a.com/p#top") === "https://a.com/p");
  ok("keeps the root slash", normalizeUrl("https://a.com/") === "https://a.com/");
  ok("strips embedded credentials", !normalizeUrl("https://u:p@a.com/x").includes("u:p"));

  // People type "acme.com" into a form. Rejecting that is a support ticket.
  ok(
    "adds a scheme when the client omits it",
    normalizeSiteUrl("acme.com") === "https://acme.com/",
    normalizeSiteUrl("acme.com"),
  );
  ok("trims whitespace", normalizeSiteUrl("  https://acme.com  ") === "https://acme.com/");
  ok("rejects a bare word", normalizeSiteUrl("acme") === null);
  ok("rejects empty", normalizeSiteUrl("") === null);
}

// ---------------------------------------------------------------------------
console.log("\nisAllowedByRobots — we are fetching someone else's server");
// ---------------------------------------------------------------------------
{
  const robots = `
User-agent: *
Disallow: /private
Disallow: /admin

User-agent: lumilinkbot
Disallow: /nope
Allow: /private/ok
`;

  ok("allows an unlisted path", isAllowedByRobots(robots, "/about", "lumilinkbot"));
  ok("obeys our own group", !isAllowedByRobots(robots, "/nope", "lumilinkbot"));

  // A group naming us specifically REPLACES the wildcard group. That is the
  // spec, and it is how a site owner grants one crawler access without opening
  // the path to everyone.
  ok(
    "a named group overrides the wildcard entirely",
    isAllowedByRobots(robots, "/admin", "lumilinkbot"),
  );
  ok("wildcard still applies to others", !isAllowedByRobots(robots, "/admin", "otherbot"));

  // No robots.txt means no restrictions stated — the conventional reading.
  ok("fails open when absent", isAllowedByRobots(null, "/anything"));
  ok("fails open when empty", isAllowedByRobots("", "/anything"));

  // "Disallow:" with no value means allow all. Treating it as a zero-length
  // prefix would block the entire site.
  ok(
    "empty Disallow does not block everything",
    isAllowedByRobots("User-agent: *\nDisallow:", "/anything"),
  );

  ok(
    "longest match wins",
    isAllowedByRobots("User-agent: *\nDisallow: /a\nAllow: /a/b", "/a/b"),
  );
  ok("wildcard patterns", !isAllowedByRobots("User-agent: *\nDisallow: /*.php", "/x.php"));
  ok("end anchors", !isAllowedByRobots("User-agent: *\nDisallow: /x$", "/x"));
  ok("end anchor does not over-match", isAllowedByRobots("User-agent: *\nDisallow: /x$", "/xy"));
  ok("ignores comments", isAllowedByRobots("# nothing here\nUser-agent: *", "/a"));
}

// ---------------------------------------------------------------------------
console.log("\nchunkText — the 512-token ceiling is a hard constraint");
// ---------------------------------------------------------------------------
{
  ok("empty text yields no chunks", chunkText("").length === 0);
  ok("short text stays one chunk", chunkText("Short policy.").length === 1);

  const long = ("Sentence number one is here. ".repeat(200)).trim();
  const chunks = chunkText(long);

  ok("long text is split", chunks.length > 1, chunks.length);

  // THE INVARIANT. gte-small silently truncates past 512 tokens — no error,
  // just an embedding of the first part answering questions about the rest.
  ok(
    "EVERY chunk is within target",
    chunks.every((c) => c.length <= CHUNK_TARGET_CHARS),
    chunks.map((c) => c.length),
  );

  ok("no empty chunks", chunks.every((c) => c.trim().length > 0));

  // Overlap: a fact straddling a boundary must survive whole somewhere.
  const overlapping = chunkText(long);
  ok(
    "consecutive chunks share a tail",
    overlapping.length < 2 ||
      overlapping[1].startsWith(overlapping[0].slice(-50).trim().split(" ")[0]) ||
      overlapping[0].slice(-100).split(" ").some((w) => w && overlapping[1].includes(w)),
  );

  // A single unbroken run (a minified blob, a long table) still has to be cut.
  const unbroken = "x".repeat(CHUNK_TARGET_CHARS * 3);
  ok(
    "hard-splits text with no sentence boundaries",
    chunkText(unbroken).every((c) => c.length <= CHUNK_TARGET_CHARS),
  );

  // Prices are everywhere in this corpus and must not split into sentences.
  const priced = "Tune-up is $129.00 flat. Repairs start at $89.00.";
  ok("does not split on decimals", chunkText(priced).length === 1, chunkText(priced));

  ok(
    "paragraph structure is preferred",
    chunkText("A".repeat(900) + "\n\n" + "B".repeat(900)).length === 2,
  );
}

// ---------------------------------------------------------------------------
console.log("\ncontentHash — the re-sync skip");
// ---------------------------------------------------------------------------
{
  ok("stable across calls", contentHash("hello world") === contentHash("hello world"));
  ok("differs on change", contentHash("hello world") !== contentHash("hello worle"));
  ok("differs on whitespace", contentHash("a b") !== contentHash("ab"));
  ok("handles empty", typeof contentHash("") === "string");
  ok("fixed width", contentHash("x").length === 8, contentHash("x"));
}

// ---------------------------------------------------------------------------
console.log("\nextractTitle / decodeEntities");
// ---------------------------------------------------------------------------
{
  ok(
    "reads <title>",
    extractTitle("<title>Acme &amp; Sons</title>", "https://a.com") === "Acme & Sons",
  );
  ok(
    "falls back to host and path",
    extractTitle("<html></html>", "https://a.com/pricing") === "a.com/pricing",
  );
  ok(
    "falls back to host at root",
    extractTitle("", "https://a.com/") === "a.com",
    extractTitle("", "https://a.com/"),
  );
  ok("numeric entities", decodeEntities("caf&#233;") === "café");
  ok("hex entities", decodeEntities("caf&#xE9;") === "café");
  ok("leaves unknown entities alone", decodeEntities("&bogus;") === "&bogus;");
}

console.log(
  failed === 0
    ? `\nAll kb-ingest tests passed (${passed}).`
    : `\n${failed} FAILED, ${passed} passed.`,
);
process.exit(failed === 0 ? 0 : 1);
