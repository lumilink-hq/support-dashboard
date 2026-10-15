// =============================================================================
// test-staff-access.ts — unit tests for safeNext in lib/staff-access.ts.
//
//   npx tsx scripts/test-staff-access.ts
//
// The staff MFA page (/loyalty/security) sends people on to ?next= after they
// enter a code. It serves /loyalty and /outbound, so next must stay inside one
// of those areas and never leave the site.
// =============================================================================

import { safeNext } from "../lib/staff-access";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (got === want) return;
  failed++;
  console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

eq("missing -> /loyalty", safeNext(undefined), "/loyalty");
eq("loyalty root", safeNext("/loyalty"), "/loyalty");
eq("loyalty member", safeNext("/loyalty/members/abc-123"), "/loyalty/members/abc-123");
eq("loyalty with query", safeNext("/loyalty?q=alice%40x"), "/loyalty?q=alice%40x");
eq("outbound root", safeNext("/outbound"), "/outbound");
eq("outbound page", safeNext("/outbound/replies"), "/outbound/replies");
eq("outbound with query", safeNext("/outbound/funnel?profile=1"), "/outbound/funnel?profile=1");

eq("other dashboard page", safeNext("/conversations"), "/loyalty");
eq("prefix lookalike", safeNext("/outboundx"), "/loyalty");
eq("protocol-relative", safeNext("//evil.example/loyalty"), "/loyalty");
eq("absolute URL", safeNext("https://evil.example/outbound"), "/loyalty");
eq("dot segments", safeNext("/outbound/../conversations"), "/loyalty");
eq("backslash", safeNext("/outbound\\..\\x"), "/loyalty");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("test-staff-access: all passed");
