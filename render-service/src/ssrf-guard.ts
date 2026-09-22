// Pure guard against pointing this service at something other than a public
// website. No network, no Playwright: unit-tested by test/test-ssrf-guard.ts.
//
// SCOPE. This service is not a general-purpose public proxy: it is called only
// by seo-crawl, behind a shared secret, with a URL that always comes from our
// own seo_locations.website_url column — never from a public, unauthenticated
// caller or from arbitrary end-user input. This guard is defense in depth for
// that already-narrow path (a bad website_url value, or a bug upstream), not
// the only thing standing between it and the public internet.
//
// WHAT IT DOES NOT DO. It rejects a URL whose HOSTNAME is already a private
// literal (an IP, "localhost", ".local") — it does NOT resolve DNS and check
// the resolved address, so it has no defense against DNS rebinding (a public
// hostname that resolves to a private IP only at request time). A real
// business's website_url is a registered public domain, never a raw IP, so
// this bar is deliberately simple rather than a hardened network proxy.

// ".local" is mDNS (RFC 6762) and ".localhost" is reserved for loopback (RFC
// 6761) — both are genuinely never a public business's real domain.
// Deliberately NOT ".internal": that's just a naming convention some orgs use,
// not a reserved private suffix, and Docker's own "host.docker.internal" (used
// by this service's own local dev/test setup to reach the host machine) would
// collide with it.
const PRIVATE_HOST_SUFFIXES = [".local", ".localhost"];

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isIpv6Literal(host: string): boolean {
  // Any bracketed or bare hex:colon literal — a real hostname never looks like this.
  return host.includes(":");
}

/** True when this URL should be refused: not http(s), or a private/loopback-shaped host. */
export function isBlockedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "0.0.0.0") return true;
  if (isIpv4Literal(host) || isIpv6Literal(host)) return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  return false;
}
