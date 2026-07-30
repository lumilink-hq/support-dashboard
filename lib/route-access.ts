// Which URL paths are reachable WITHOUT a session.
//
// Split out of lib/supabase/proxy.ts on purpose: this is pure logic with zero
// imports, so it can be unit-tested without booting Next or Supabase (see
// scripts/test-route-access.ts). It is also the single most dangerous predicate
// in the app — getting it wrong doesn't throw, it silently exposes every
// tenant's dashboard — and untestable security logic tends to stay untested.

/**
 * Public paths matched by PREFIX, so sub-paths come along:
 * "/auth" covers "/auth/confirm", "/demo" covers "/demo/<slug>".
 */
export const PUBLIC_PREFIXES = [
  "/login",
  "/signup",
  "/auth",
  "/demo",
] as const;

/**
 * Public paths matched EXACTLY.
 *
 * "/" MUST live here and can never go in PUBLIC_PREFIXES. Every pathname begins
 * with "/", so a prefix entry would make isPublicPath() return true for every
 * route in the application and unauthenticate the whole dashboard in one line.
 *
 * When adding marketing routes later: anything with sub-paths goes in
 * PUBLIC_PREFIXES, bare single pages go here.
 */
export const PUBLIC_EXACT = ["/"] as const;

/**
 * True when `pathname` may be served to a visitor with no session.
 *
 * Note the prefix list is a genuine prefix match, not a segment match, so a
 * hypothetical "/demo-internal" would also be public. That is acceptable only
 * because no gated route begins with any public prefix — an invariant the test
 * suite asserts directly. If you add a gated route, check it against this list.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    (PUBLIC_EXACT as readonly string[]).includes(pathname) ||
    (PUBLIC_PREFIXES as readonly string[]).some((p) => pathname.startsWith(p))
  );
}
