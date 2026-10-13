// =============================================================================
// test-outbound-enrich.ts — unit tests for the outbound-enrich pure helpers
// (docs/OUTBOUND-PLAN.md, Phase 1 step 3).
//
//   npx tsx scripts/test-outbound-enrich.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  cleanEmail,
  contactLinks,
  decodeCfEmail,
  extractEmails,
  pickEmail,
  startUrl,
} from "../supabase/functions/outbound-enrich/lib.ts";

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

/** Cloudflare's encoding, for building fixtures: key byte, then each char XOR key. */
function cfEncode(email: string, key = 0x2a): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return hex(key) + [...email].map((c) => hex(c.charCodeAt(0) ^ key)).join("");
}

console.log("cleanEmail");
ok("lower-cases and trims", cleanEmail("  Info@GreenLeaf.com ") === "info@greenleaf.com", cleanEmail("  Info@GreenLeaf.com "));
ok("strips mailto: and query", cleanEmail("mailto:hello@acme.com?subject=Hi") === "hello@acme.com");
ok("decodes %40", cleanEmail("hello%40acme.com") === "hello@acme.com", cleanEmail("hello%40acme.com"));
ok("strips trailing punctuation", cleanEmail("hello@acme.com.") === "hello@acme.com", cleanEmail("hello@acme.com."));
ok("rejects image filenames", cleanEmail("logo@2x.png") === null);
ok("rejects placeholder domains", cleanEmail("you@example.com") === null && cleanEmail("name@domain.com") === null);
ok("rejects platform addresses", cleanEmail("abc@sentry.wixpress.com") === null);
ok("rejects no-reply", cleanEmail("no-reply@acme.com") === null && cleanEmail("noreply@acme.com") === null);
ok("rejects hash-like locals", cleanEmail("605a7baede844d278b89dc95ae0a9123@sentry.io") === null);
ok("rejects missing TLD", cleanEmail("hello@acme") === null);

console.log("decodeCfEmail");
ok("decodes Cloudflare protection", decodeCfEmail(cfEncode("info@greenleaf.com")) === "info@greenleaf.com");
ok("rejects junk", decodeCfEmail("zz") === null && decodeCfEmail("abc") === null);

console.log("extractEmails");
{
  const html = `
    <html><head><script>var x = "dev@library.io";</script><style>.a{content:"css@style.io"}</style></head>
    <body>
      <a href="mailto:Hello@GreenLeaf.com?subject=Hi">Email us</a>
      <p>Owner: owner&#64;greenleaf.com</p>
      <p>Write to orders [at] greenleaf [dot] com</p>
      <a href="/cdn-cgi/l/email-protection#${cfEncode("manager@greenleaf.com")}">[email protected]</a>
      <span class="__cf_email__" data-cfemail="${cfEncode("team@greenleaf.com")}">[email protected]</span>
      <p>Email us at gmail.com for help</p>
      <img src="logo@2x.png">
    </body></html>`;
  const found = extractEmails(html);
  const emails = found.map((c) => c.email);
  ok("mailto link found first", found[0]?.email === "hello@greenleaf.com" && found[0]?.how === "mailto", found[0]);
  ok("entity-encoded @ found", emails.includes("owner@greenleaf.com"), emails);
  ok("[at] [dot] obfuscation found", emails.includes("orders@greenleaf.com"), emails);
  ok("Cloudflare link decoded", emails.includes("manager@greenleaf.com"), emails);
  ok("Cloudflare span decoded", emails.includes("team@greenleaf.com"), emails);
  ok("script and style emails ignored", !emails.includes("dev@library.io") && !emails.includes("css@style.io"), emails);
  ok("prose 'at gmail.com' is not an address", !emails.some((e) => e.startsWith("us@")), emails);
  ok("no duplicates", new Set(emails).size === emails.length);
}

console.log("pickEmail");
{
  const pick = pickEmail(
    [
      { email: "jane@webdesignco.com", how: "mailto" },
      { email: "careers@greenleaf.com", how: "mailto" },
      { email: "greenleafdetroit@gmail.com", how: "text" },
      { email: "info@greenleaf.com", how: "text" },
      { email: "jane.doe@greenleaf.com", how: "mailto" },
    ],
    "www.greenleaf.com",
  );
  ok("own-domain preferred inbox wins", pick?.email === "info@greenleaf.com", pick);
  ok("rank marks own domain (<100)", (pick?.rank ?? 999) < 100, pick);
}
{
  const pick = pickEmail(
    [
      { email: "jane@webdesignco.com", how: "mailto" },
      { email: "greenleafdetroit@gmail.com", how: "text" },
    ],
    "greenleaf.com",
  );
  ok("webmail is used when no own-domain address", pick?.email === "greenleafdetroit@gmail.com", pick);
  ok("webmail ranks 100+", (pick?.rank ?? 0) >= 100, pick);
}
ok(
  "third-party domains never qualify",
  pickEmail([{ email: "jane@webdesignco.com", how: "mailto" }], "greenleaf.com") === null,
);
ok(
  "avoided inboxes never qualify",
  pickEmail([{ email: "privacy@greenleaf.com", how: "mailto" }, { email: "jobs@greenleaf.com", how: "text" }], "greenleaf.com") ===
    null,
);
ok(
  "a named person on the own domain beats webmail",
  pickEmail(
    [{ email: "shop@gmail.com", how: "mailto" }, { email: "jane.doe@greenleaf.com", how: "text" }],
    "greenleaf.com",
  )?.email === "jane.doe@greenleaf.com",
);
ok(
  "a mail subdomain counts as own domain",
  pickEmail([{ email: "info@mail.greenleaf.com", how: "text" }], "greenleaf.com")?.email === "info@mail.greenleaf.com",
);
ok("no site domain: only webmail qualifies", pickEmail([{ email: "info@greenleaf.com", how: "text" }], null) === null);

console.log("contactLinks");
{
  const html = `
    <a href="/">Home</a>
    <a href="/menu">Menu</a>
    <a href="/about-us">About us</a>
    <a href="https://www.greenleaf.com/contact">Contact</a>
    <a href="/locations">Our locations</a>
    <a href="https://facebook.com/greenleaf">Facebook</a>
    <a href="/wp-login.php">Log in</a>
    <a href="/team">Meet the team</a>`;
  const links = contactLinks(html, "https://greenleaf.com/");
  ok("contact page first", links[0] === "https://www.greenleaf.com/contact", links);
  ok("at most three", links.length === 3, links);
  ok("other sites and logins skipped", !links.some((l) => l.includes("facebook") || l.includes("wp-login")), links);
  ok("plain pages skipped", !links.some((l) => l.endsWith("/menu")), links);
}
{
  const links = contactLinks(`<a href="/menu">Menu</a>`, "https://greenleaf.com/");
  ok(
    "falls back to /contact and /contact-us",
    JSON.stringify(links) === JSON.stringify(["https://greenleaf.com/contact", "https://greenleaf.com/contact-us"]),
    links,
  );
}

console.log("startUrl");
ok("adds https to a bare domain", startUrl("greenleaf.com") === "https://greenleaf.com/", startUrl("greenleaf.com"));
ok("keeps the origin only", startUrl("http://www.greenleaf.com/menu?x=1") === "http://www.greenleaf.com/");
ok("rejects non-web schemes", startUrl("ftp://greenleaf.com") === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
