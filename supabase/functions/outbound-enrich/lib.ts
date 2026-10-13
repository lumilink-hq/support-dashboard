// =============================================================================
// outbound-enrich/lib.ts — pure helpers for outbound-enrich: pull email
// addresses out of a business's web pages, pick the one worth emailing, and
// find the contact / about pages to look at next. No network, no Deno APIs,
// so scripts/test-outbound-enrich.ts can run them under Node.
//
// Shares decodeEntities / normalizeUrl / visibleWordCount / robots parsing
// with seo-crawl (imported, not copied) so both crawlers read HTML the same
// way.
// =============================================================================

import { decodeEntities, normalizeUrl, visibleWordCount } from "../seo-crawl/lib.ts";
import { isCrawlable, sameSite } from "../seo-crawl/site.ts";

export { visibleWordCount };

/** Below this many visible words a homepage is treated as a JavaScript shell
 * and, when render-service is configured, rendered once. Same bar as seo-crawl. */
export const JS_SHELL_WORDS = 40;

/** Contact / about pages fetched per lead after the homepage. */
export const MAX_EXTRA_PAGES = 3;

const EMAIL = /[a-z0-9][a-z0-9._%+-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}/gi;

// "name [at] domain [dot] com", "name(at)domain.com". A bare " at " is NOT
// accepted: ordinary prose ("email us at gmail.com") would read as an address.
const OBFUSCATED =
  /([a-z0-9][a-z0-9._%+-]{0,63})\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\})\s*([a-z0-9-]+(?:\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|\s+dot\s+|\.)\s*[a-z0-9-]+)+)/gi;

/** Cloudflare "email protection": data-cfemail="<hex>", first byte is the XOR key. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2 !== 0) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out.includes("@") ? out : null;
}

// Addresses that are never a business's own inbox.
const PLACEHOLDER_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "domain.com", "yourdomain.com", "email.com",
  "company.com", "yoursite.com", "website.com", "test.com", "sentry.io", "sentry-next.wixpress.com",
  "wixpress.com", "wix.com", "godaddy.com", "squarespace.com", "shopify.com", "mysite.com",
]);
const IMAGE_LIKE = /\.(png|jpe?g|gif|webp|svg|ico|css|js)$/i;
const NO_REPLY = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|bounces)$/i;
// Inboxes that won't reach an owner or would be rude to cold email.
const AVOID_LOCAL =
  /^(abuse|privacy|legal|dmca|careers|jobs|hr|recruiting|webmaster|hostmaster|admin|billing|accounts|payroll|press|media|unsubscribe|compliance|security)$/i;
// Preferred inboxes, best first. Anything else on the business's own domain
// (e.g. a person's name) ranks between these and the avoided ones.
const PREFERRED_LOCAL = ["owner", "info", "hello", "contact", "office", "sales", "team", "inquiries", "manager", "support"];

/** Free mailbox providers small businesses commonly use instead of their own domain. */
export const WEBMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "comcast.net", "att.net", "sbcglobal.net",
  "verizon.net", "bellsouth.net", "protonmail.com", "proton.me", "zoho.com", "gmx.com",
]);

function bare(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, "");
}

/** Lower-cased, trimmed, and plausible as a real business address, or null. */
export function cleanEmail(raw: string): string | null {
  let e = raw.trim().toLowerCase();
  e = e.replace(/^mailto:/, "").split("?")[0];
  try {
    e = decodeURIComponent(e);
  } catch {
    // keep as is
  }
  e = e.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  const at = e.lastIndexOf("@");
  if (at <= 0 || e.length > 254) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (!/^[a-z0-9][a-z0-9._%+-]*$/.test(local) || local.length > 64) return null;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(domain)) return null;
  if (IMAGE_LIKE.test(e)) return null; // logo@2x.png
  if (PLACEHOLDER_DOMAINS.has(domain) || /(^|\.)(example|sentry|wixpress)\./.test(domain)) return null;
  if (NO_REPLY.test(local)) return null;
  if (/^[0-9a-f]{16,}$/.test(local)) return null; // tracking hashes
  return e;
}

export type Candidate = { email: string; how: "mailto" | "text" | "obfuscated" | "cloudflare" };

/** Every plausible address on a page, de-duplicated, mailto links first. */
export function extractEmails(html: string): Candidate[] {
  const found = new Map<string, Candidate["how"]>();
  const add = (raw: string, how: Candidate["how"]) => {
    const e = cleanEmail(raw);
    if (e && !found.has(e)) found.set(e, how);
  };

  for (const m of html.matchAll(/href\s*=\s*["']\s*mailto:([^"']+)["']/gi)) {
    for (const part of decodeEntities(m[1]).split(/[,;]/)) add(part, "mailto");
  }
  for (const m of html.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) {
    const e = decodeCfEmail(m[1]);
    if (e) add(e, "cloudflare");
  }
  for (const m of html.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)) {
    const e = decodeCfEmail(m[1]);
    if (e) add(e, "cloudflare");
  }

  // Visible text, scripts and styles removed (they hold library emails).
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
  for (const m of text.matchAll(EMAIL)) add(m[0], "text");
  for (const m of text.matchAll(OBFUSCATED)) {
    const domain = m[2].replace(/\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|\s+dot\s+)\s*/gi, ".").replace(/\s+/g, "");
    add(`${m[1]}@${domain}`, "obfuscated");
  }

  return [...found.entries()].map(([email, how]) => ({ email, how }));
}

export type Pick = { email: string; rank: number; reason: string };

/**
 * The address worth emailing for a business whose site is `siteDomain`, or
 * null. Only addresses on the business's own domain or a free mailbox
 * provider qualify: anything else is usually the web designer, a supplier
 * or a platform, not the owner.
 */
export function pickEmail(candidates: Candidate[], siteDomain: string | null): Pick | null {
  const site = siteDomain ? bare(siteDomain) : null;
  let best: Pick | null = null;

  for (const c of candidates) {
    const [local, domain] = [c.email.slice(0, c.email.lastIndexOf("@")), c.email.slice(c.email.lastIndexOf("@") + 1)];
    const ownDomain = site !== null && (domain === site || domain.endsWith(`.${site}`) || site.endsWith(`.${domain}`));
    const webmail = WEBMAIL.has(domain);
    if (!ownDomain && !webmail) continue;
    if (AVOID_LOCAL.test(local)) continue;

    // Lower rank is better. Own domain beats webmail; preferred inboxes beat
    // other names; a mailto link beats an address found in text.
    const pref = PREFERRED_LOCAL.indexOf(local);
    let rank = (ownDomain ? 0 : 100) + (pref >= 0 ? pref : PREFERRED_LOCAL.length) * 2;
    if (c.how !== "mailto") rank += 1;
    const reason = `${ownDomain ? "own domain" : "webmail"}, ${pref >= 0 ? `${local}@` : "named inbox"}, ${c.how}`;
    if (!best || rank < best.rank) best = { email: c.email, rank, reason };
  }
  return best;
}

const CONTACT_HINT = /(contact|about|reach|get-in-touch|find-us|location|visit|team|our-story|connect)/i;
const CONTACT_TEXT = /(contact|about|get in touch|reach us|find us|locations?|visit us|our team|our story)/i;

/**
 * Same-site pages likely to carry an email address, best first: anchors whose
 * href or text mentions contact / about / locations. Falls back to the usual
 * /contact and /contact-us paths when the homepage links none.
 */
export function contactLinks(html: string, pageUrl: string, max = MAX_EXTRA_PAGES): string[] {
  let host: string;
  try {
    host = new URL(pageUrl).host;
  } catch {
    return [];
  }
  const scored: { url: string; score: number }[] = [];
  const seen = new Set<string>([normalizeUrl(pageUrl)]);

  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: string;
    try {
      url = normalizeUrl(new URL(decodeEntities(m[1]), pageUrl).href);
    } catch {
      continue;
    }
    if (seen.has(url) || !sameSite(url, host) || !isCrawlable(url)) continue;
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).trim();
    const path = new URL(url).pathname;
    const score = (/contact/i.test(path) || /contact/i.test(text) ? 2 : 0) +
      (CONTACT_HINT.test(path) ? 1 : 0) + (CONTACT_TEXT.test(text) ? 1 : 0);
    if (score === 0) continue;
    seen.add(url);
    scored.push({ url, score });
  }

  const out = scored.sort((a, b) => b.score - a.score).map((s) => s.url);
  if (out.length === 0) {
    for (const p of ["/contact", "/contact-us"]) {
      const url = normalizeUrl(new URL(p, pageUrl).href);
      if (!seen.has(url)) out.push(url);
    }
  }
  return out.slice(0, max);
}

/** The homepage to start from: https, origin only. */
export function startUrl(websiteUrl: string): string | null {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}/`;
  } catch {
    return null;
  }
}
