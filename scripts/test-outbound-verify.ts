// =============================================================================
// test-outbound-verify.ts — unit tests for outbound-verify's Reoon mapping
// (docs/OUTBOUND-PLAN.md, Phase 1 step 4).
//
//   npx tsx scripts/test-outbound-verify.ts
//
// No network, no Deno, no database.
// =============================================================================

import { isVendorError, mapReoon } from "../supabase/functions/outbound-verify/lib.ts";

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

function expect(label: string, response: unknown, verification: string, suppress: boolean) {
  const m = mapReoon(response);
  ok(label, !isVendorError(m) && m.verification === verification && m.suppress === suppress, m);
}

console.log("statuses");
expect("safe is valid", { status: "safe", is_deliverable: true }, "valid", false);
expect("deliverable role account is valid", { status: "role_account", is_deliverable: true }, "valid", false);
expect("safe-to-send role account is valid", { status: "role_account", is_safe_to_send: true }, "valid", false);
expect("undeliverable role account is unknown", { status: "role_account", is_deliverable: false }, "unknown", false);
expect("catch-all role account is catch_all", { status: "role_account", is_catch_all: true, is_deliverable: true }, "catch_all", false);
expect("catch_all is kept, flagged", { status: "catch_all" }, "catch_all", false);
expect("unknown is kept, flagged", { status: "unknown" }, "unknown", false);
expect("inbox_full is invalid but not suppressed", { status: "inbox_full" }, "invalid", false);
expect("invalid is suppressed", { status: "invalid" }, "invalid", true);
expect("disabled is suppressed", { status: "disabled" }, "invalid", true);
expect("spamtrap is suppressed", { status: "spamtrap" }, "invalid", true);
expect("disposable is suppressed", { status: "disposable" }, "disposable", true);
expect("status case doesn't matter", { status: "SAFE" }, "valid", false);
expect("quick-mode valid still maps", { status: "valid" }, "valid", false);

console.log("detail");
{
  const m = mapReoon({ status: "safe", overall_score: 98, is_deliverable: true, email: "x@y.com", mx_records: ["a"] });
  ok("keeps the useful fields", !isVendorError(m) && m.detail.overall_score === 98 && m.detail.status === "safe", m);
  ok("drops the address and MX list", !isVendorError(m) && !("email" in m.detail) && !("mx_records" in m.detail), m);
}

console.log("errors");
{
  const m = mapReoon({ status: "error", reason: "Not enough credits" });
  ok("out of credits is fatal", isVendorError(m) && m.fatal, m);
}
{
  const m = mapReoon({ status: "error", reason: "Invalid API key" });
  ok("bad key is fatal", isVendorError(m) && m.fatal, m);
}
{
  const m = mapReoon({ status: "error", reason: "Temporary SMTP failure" });
  ok("other errors are not fatal", isVendorError(m) && !m.fatal, m);
}
{
  const m = mapReoon({ reason: "Something odd" });
  ok("a reason with no status is an error", isVendorError(m), m);
}
ok("unexpected status is an error, not a guess", isVendorError(mapReoon({ status: "maybe" })));
ok("null is an error", isVendorError(mapReoon(null)));
ok("array is an error", isVendorError(mapReoon([])));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
