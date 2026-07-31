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
 *   "/"        the marketing landing page. Signed-in users are redirected to
 *              the dashboard by the route itself, not by this list.
 *   "/home"    the same page without that redirect, so a signed-in user can
 *              still reach the marketing site. noindex.
 *   "/preview" retired; redirects to /home. Kept so shared links don't 404.
 *
 * "/" MUST stay in THIS list and never move to PUBLIC_PREFIXES. Every pathname
 * begins with "/", so a prefix entry would make isPublicPath() return true for
 * every route in the application and unauthenticate the whole dashboard in one
 * character of diff, silently. scripts/test-route-access.ts asserts this.
 *
 * When adding marketing routes later: anything with sub-paths goes in
 * PUBLIC_PREFIXES, bare single pages go here.
 */
export const PUBLIC_EXACT = ["/", "/home", "/preview", "/plans"] as const;

/**
 * Sanitise a `?next=` value before redirecting to it.
 *
 * WHY. /plans sends a signed-out visitor to /login?next=/plans so they land back
 * on the plan they picked. Redirecting to an attacker-supplied value is an open
 * redirect: a link to
 *   yourdomain.com/login?next=https://evil.example/login
 * looks like your domain, takes a real password on your real login form, then
 * drops the user on a copy of it. Phishing that borrows your domain's
 * credibility.
 *
 * Only same-site absolute paths pass. Everything else falls back.
 *
 * The `//` case is the one people miss: "//evil.example" starts with "/" and is
 * a protocol-relative URL, so a naive startsWith("/") check sends the browser
 * off-site. Backslashes are rejected because some browsers normalise "\" to "/".
 */
export function safeNextPath(
  value: string | null | undefined,
  fallback = "/conversations",
): string {
  if (typeof value !== "string") return fallback;
  const v = value.trim();

  if (!v.startsWith("/")) return fallback; // absolute URLs, "javascript:", ""
  if (v.startsWith("//")) return fallback; // protocol-relative -> off-site
  if (v.includes("\\")) return fallback; // "/\evil.example" normalises to "//"
  if (v.includes("\n") || v.includes("\r")) return fallback; // header splitting

  return v;
}

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
