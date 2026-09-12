// =============================================================================
// test-route-access.ts — unit tests for lib/route-access.ts.
//
//   npx tsx scripts/test-route-access.ts
//   (or: node --experimental-strip-types scripts/test-route-access.ts)
//
// WHY THIS EXISTS: adding a public marketing page turned the dashboard from
// "everything is gated" into "some things are gated", and the failure mode is
// silent. Nothing throws when a route becomes public by accident; the tenant
// data just starts serving to anyone. The specific trap is that every pathname
// starts with "/", so putting "/" into PUBLIC_PREFIXES would make the whole
// application public in one character of diff, with no error anywhere.
//
// The canary is simple: /conversations must never be public.
// =============================================================================

import {
  PUBLIC_EXACT,
  PUBLIC_PREFIXES,
  isPublicPath,
  safeNextPath,
} from "../lib/route-access.ts";

let failures = 0;

function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\npublic routes are reachable without a session");
// ---------------------------------------------------------------------------
ok("/ (landing page)", isPublicPath("/"));
ok("/plans (public acquisition page)", isPublicPath("/plans"));
ok("/home (landing, no redirect)", isPublicPath("/home"));
ok("/preview (retired, redirects to /home)", isPublicPath("/preview"));
ok("/login", isPublicPath("/login"));
ok("/signup", isPublicPath("/signup"));
ok("/auth/confirm (prefix covers sub-paths)", isPublicPath("/auth/confirm"));
ok("/demo (bare)", isPublicPath("/demo"));
ok("/demo/tsunami (prefix covers slugs)", isPublicPath("/demo/tsunami"));
ok(
  "/api/webhooks/stripe (Stripe calls with no session cookie)",
  isPublicPath("/api/webhooks/stripe"),
);
ok(
  "/api/billing/checkout (auth is the route's own requireClientId check, not a redirect)",
  isPublicPath("/api/billing/checkout"),
);

// ---------------------------------------------------------------------------
console.log("\nEVERY dashboard route stays gated");
// ---------------------------------------------------------------------------
// Mirrors components/sidebar.tsx. If a route is added there, add it here too —
// this list is the actual security assertion, not decoration.
const GATED = [
  "/conversations",
  "/conversations/8f2c1e00-0000-0000-0000-000000000000",
  "/appointments",
  "/leads",
  "/review-queue",
  "/services",
  "/settings",
  "/billing",
  "/knowledge-base",
];

for (const route of GATED) {
  ok(`${route} is NOT public`, !isPublicPath(route));
}

// ---------------------------------------------------------------------------
console.log("\nthe structural invariants that make prefix-matching safe");
// ---------------------------------------------------------------------------

// Prefix matching is only sound while no gated route begins with a public
// prefix. Assert it rather than trusting a future author to notice.
const collisions = GATED.filter((route) =>
  PUBLIC_PREFIXES.some((p) => route.startsWith(p)),
);
ok(
  "no gated route begins with a public prefix",
  collisions.length === 0,
  collisions,
);

// The one-character catastrophe. Holds whether or not "/" is currently public:
// if it is ever made public it belongs in PUBLIC_EXACT, and it must never
// appear in PUBLIC_PREFIXES, where it would match every route in the app.
ok(
  '"/" is NOT in PUBLIC_PREFIXES (would expose every route)',
  !(PUBLIC_PREFIXES as readonly string[]).includes("/"),
);
ok(
  "every PUBLIC_EXACT entry is a rooted path",
  PUBLIC_EXACT.every((p) => p.startsWith("/")),
  PUBLIC_EXACT,
);

// Every prefix must be a rooted path segment; a bare "" would match everything.
ok(
  "every public prefix starts with / and is non-trivial",
  PUBLIC_PREFIXES.every((p) => p.startsWith("/") && p.length > 1),
  PUBLIC_PREFIXES,
);

// ---------------------------------------------------------------------------
console.log("\nedge cases");
// ---------------------------------------------------------------------------
ok("trailing slash on a gated route stays gated", !isPublicPath("/billing/"));
ok("unknown route is gated by default", !isPublicPath("/does-not-exist"));
ok("deep unknown route is gated by default", !isPublicPath("/a/b/c"));

// Documents the known looseness of prefix matching. This is currently harmless
// because no such route exists — but if one is ever added it will be PUBLIC,
// and this assertion is where you'll find out.
ok(
  "KNOWN: prefix match is not segment-aware (/demo-internal would be public)",
  isPublicPath("/demo-internal"),
);

// ---------------------------------------------------------------------------
console.log("\nsafeNextPath — open-redirect guard on /login?next=");
// ---------------------------------------------------------------------------
// /plans sends signed-out visitors to /login?next=/plans. An unchecked value
// here lets an attacker host a phishing login on YOUR domain's reputation:
//   yourdomain.com/login?next=https://evil.example/login
ok("keeps a plain same-site path", safeNextPath("/plans") === "/plans");
ok("keeps a nested path", safeNextPath("/billing/invoices") === "/billing/invoices");

ok(
  "REJECTS an absolute URL",
  safeNextPath("https://evil.example/login") === "/conversations",
);
ok(
  "REJECTS a protocol-relative URL (the one people miss)",
  safeNextPath("//evil.example") === "/conversations",
);
ok(
  "REJECTS a backslash path (browsers normalise \\\\ to //)",
  safeNextPath("/\\evil.example") === "/conversations",
);
ok(
  "REJECTS javascript:",
  safeNextPath("javascript:alert(1)") === "/conversations",
);
ok(
  "REJECTS a newline (header splitting)",
  safeNextPath("/plans\nSet-Cookie: x=1") === "/conversations",
);
ok("missing value falls back", safeNextPath(null) === "/conversations");
ok("empty string falls back", safeNextPath("") === "/conversations");
ok(
  "honours a custom fallback",
  safeNextPath("https://evil.example", "/plans") === "/plans",
);

// ---------------------------------------------------------------------------
console.log(
  failures === 0
    ? "\nAll route-access tests passed.\n"
    : `\n${failures} route-access test(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
