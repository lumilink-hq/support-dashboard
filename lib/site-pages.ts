// The marketing pages we want Google to index, and the site origin they live on.
//
// Pure data with zero imports so scripts/test-route-access.ts can assert that
// every page listed here is reachable without a session. A sitemap entry that
// the proxy bounces to /login is worse than no entry: Google reads it as a
// redirecting URL, and our own audit flags it (sitemap_url_not_ok).
//
// Rule for what goes in: a public page that sets `alternates.canonical` to its
// own path. Noindex pages (/home, /welcome, /partners/*, /lp/*, /demo/hvac) and
// flow pages (/login, /signup, /plans) stay out.

export const SITEMAP_PATHS = [
  "/",
  "/pricing",
  "/products/seo",
  "/solutions/service",
  "/solutions/ecommerce",
  "/story",
  "/contact",
  "/legal/privacy",
  "/legal/terms",
] as const;

/**
 * The public origin, with no trailing slash. NEXT_PUBLIC_SITE_URL is set per
 * environment (localhost in .env.local, www.lumilinkhub.com in Railway); the
 * fallback is production so a missing var can never publish localhost URLs to
 * Google.
 */
export function siteOrigin(): string {
  const v = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  return v || "https://www.lumilinkhub.com";
}
