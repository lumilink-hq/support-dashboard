// =============================================================================
// test-ssrf-guard.ts — unit tests for src/ssrf-guard.ts.
//
//   npm test   (inside render-service/)
//
// No network, no Playwright.
// =============================================================================

import { isBlockedUrl } from "../src/ssrf-guard.js";

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

console.log("\nallows a public site");
{
  ok("a real https domain", isBlockedUrl("https://example.com/") === false);
  ok("a real http domain", isBlockedUrl("http://example.com/about") === false);
  ok("a subdomain", isBlockedUrl("https://shop.example.com/") === false);
  ok("host.docker.internal (used by this service's own local test setup) is allowed, not treated as private", isBlockedUrl("http://host.docker.internal:8099/") === false);
}

console.log("\nblocks non-http(s) and unparseable");
{
  ok("file scheme", isBlockedUrl("file:///etc/passwd") === true);
  ok("javascript scheme", isBlockedUrl("javascript:alert(1)") === true);
  ok("ftp scheme", isBlockedUrl("ftp://example.com/") === true);
  ok("garbage", isBlockedUrl("not a url") === true);
  ok("empty", isBlockedUrl("") === true);
}

console.log("\nblocks private/loopback-shaped hosts");
{
  ok("localhost", isBlockedUrl("http://localhost/") === true);
  ok("localhost with port", isBlockedUrl("http://localhost:8080/x") === true);
  ok("0.0.0.0", isBlockedUrl("http://0.0.0.0/") === true);
  ok("loopback IPv4 literal", isBlockedUrl("http://127.0.0.1/") === true);
  ok("private IPv4 literal", isBlockedUrl("http://10.0.0.5/") === true);
  ok("link-local IPv4 literal (cloud metadata)", isBlockedUrl("http://169.254.169.254/latest/meta-data/") === true);
  ok("IPv6 loopback literal", isBlockedUrl("http://[::1]/") === true);
  ok(".local suffix (mDNS)", isBlockedUrl("http://printer.local/") === true);
  ok(".localhost suffix", isBlockedUrl("http://anything.localhost/") === true);
  ok("case-insensitive host check", isBlockedUrl("http://LOCALHOST/") === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
