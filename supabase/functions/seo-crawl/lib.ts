// =============================================================================
// lib.ts — pure, side-effect-free helpers for the seo-crawl worker (module 6).
//
// Same split as kb-ingest/lib.ts and voice-personalization: no Deno, no
// network, no database — everything here is unit-testable in plain Node/tsx.
//
// WHY THIS IS A SEPARATE FUNCTION, NOT A REUSE OF kb-ingest/lib.ts. Plan.md
// says "reuse the kb-ingest fetcher" — that's the polite-fetching layer
// (fetchPage/fetchRobots/discoverLinks/normalizeUrl/isAllowedByRobots), which
// this DOES reuse (the four functions below with the same names have the
// same behavior, copied rather than cross-imported — Supabase bundles each
// function's directory independently, and every function in this repo so far
// is self-contained; reaching into a sibling function's directory would be
// the first exception to that, for fetching logic stable enough not to need
// to stay in sync).
//
// The PARSING layer is deliberately NOT reused, because it wants the
// opposite thing. kb-ingest's htmlToText strips <script> (which is exactly
// where LocalBusiness JSON-LD schema lives), never extracts a meta
// description, H1s, or image alt text, and DROP_ELEMENTS removes <nav>/
// <header>/<footer> specifically because navigation boilerplate is noise for
// RAG retrieval — but a missing/duplicate H1 or an unlabeled nav link is
// exactly the kind of thing an SEO audit needs to see, not discard.
// =============================================================================

export const CRAWL_PAGE_LIMIT = 20; // root + 19, matching plan.md's module 6 spec exactly

// -----------------------------------------------------------------------------
// Link discovery / robots / URL normalization — copied from kb-ingest/lib.ts.
// Identical behavior on purpose: a page's SEO audit and its KB ingestion
// should reach the same page set, so "why didn't it check /pricing" has one
// answer, not two slightly different crawlers to reconcile.
// -----------------------------------------------------------------------------

const NON_PAGE = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|mjs|json|xml|zip|gz|mp[34]|mov|avi|woff2?|ttf|eot)(\?|#|$)/i;

const SKIP_PATH =
  /\/(wp-admin|wp-login|wp-json|cart|checkout|basket|my-account|account|login|signin|sign-in|register|signup|search|feed|rss|tag|tags|author|page\/\d)/i;

export function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
    rdquo: "”", ldquo: "“", times: "×", trade: "™", reg: "®", copy: "©",
  };
  return s
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => named[name] ?? m)
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_.*|fbclid|gclid|msclkid|mc_[ec]id|ref|source)$/i.test(p)) {
        u.searchParams.delete(p);
      }
    }
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return raw;
  }
}

export function discoverLinks(html: string, baseUrl: string, limit = CRAWL_PAGE_LIMIT): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>([normalizeUrl(base.href)]);
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html ?? "")) !== null) {
    if (out.length >= limit) break;
    const href = decodeEntities(m[1]).trim();
    if (!href || href.startsWith("#")) continue;
    if (/^(mailto|tel|javascript|data):/i.test(href)) continue;

    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    if (abs.hostname !== base.hostname) continue;
    if (NON_PAGE.test(abs.pathname)) continue;
    if (SKIP_PATH.test(abs.pathname)) continue;

    const key = normalizeUrl(abs.href);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function isAllowedByRobots(
  robotsTxt: string | null,
  path: string,
  userAgent = "lumilinkbot",
): boolean {
  if (!robotsTxt) return true;

  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "disallow") current.rules.push({ allow: false, path: value });
    else if (field === "allow") current.rules.push({ allow: true, path: value });
  }

  const ua = userAgent.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes("*"));
  const group = specific ?? wildcard;
  if (!group) return true;

  let best: { allow: boolean; length: number } | null = null;
  for (const rule of group.rules) {
    if (rule.path === "") continue;
    if (!pathMatches(rule.path, path)) continue;
    if (!best || rule.path.length > best.length) {
      best = { allow: rule.allow, length: rule.path.length };
    }
  }
  return best ? best.allow : true;
}

function pathMatches(pattern: string, path: string): boolean {
  if (!pattern.includes("*") && !pattern.endsWith("$")) {
    return path.startsWith(pattern);
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const anchored = escaped.endsWith("\\$") ? "^" + escaped.slice(0, -2) + "$" : "^" + escaped;
  try {
    return new RegExp(anchored).test(path);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// SEO-specific extraction. Every function here reads raw HTML directly —
// none of it goes through a prose-stripping pass first, because the tags
// themselves are the signal.
// -----------------------------------------------------------------------------

export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html ?? "");
  if (!m) return null;
  const t = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  return t || null;
}

export function extractMetaDescription(html: string): string | null {
  // Order-agnostic: `name` can come before or after `content`.
  const re = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html ?? "")) !== null) {
    const tag = m[0];
    if (!/\bname\s*=\s*["']description["']/i.test(tag)) continue;
    const cm = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (cm) return decodeEntities(cm[1]).trim() || null;
  }
  return null;
}

export function extractCanonical(html: string): string | null {
  const re = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html ?? "")) !== null) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']canonical["']/i.test(tag)) continue;
    const hm = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (hm) return decodeEntities(hm[1]).trim() || null;
  }
  return null;
}

export function extractH1s(html: string): string[] {
  const out: string[] = [];
  const re = /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html ?? "")) !== null) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out;
}

/** src + alt for every <img>. alt is "" (present-but-empty, valid for decorative
 * images) vs null (attribute absent, always a finding) — that distinction is
 * lost if you don't check for the attribute's existence separately. */
export function extractImages(html: string): { src: string; alt: string | null }[] {
  const out: { src: string; alt: string | null }[] = [];
  const re = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html ?? "")) !== null) {
    const tag = m[0];
    const srcM = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!srcM || !srcM[1]) continue;
    const altM = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag);
    out.push({ src: srcM[1], alt: altM ? decodeEntities(altM[1]) : null });
  }
  return out;
}

/** True JSON-LD @type values that count as a local-business schema. Not an
 * exhaustive schema.org taxonomy — the common ones a small business site
 * actually uses. */
const LOCAL_BUSINESS_TYPES = new Set([
  "localbusiness", "store", "restaurant", "professionalservice",
  "homeandconstructionbusiness", "medicalbusiness", "autorepair",
  "foodestablishment", "lodgingbusiness", "legalservice", "financialservice",
  "realestateagent", "dentist", "physician", "attorney",
]);

function collectTypes(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const t = obj["@type"];
  if (typeof t === "string") out.add(t.toLowerCase());
  else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") out.add(x.toLowerCase());
  if (Array.isArray(obj["@graph"])) collectTypes(obj["@graph"], out);
}

/** Does the page carry LocalBusiness (or a subtype) JSON-LD? Malformed JSON
 * in one <script type="application/ld+json"> block must not abort checking
 * the rest — a hand-edited template with one broken block is common and
 * should still let a valid block elsewhere count. */
export function hasLocalBusinessSchema(html: string): boolean {
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const types = new Set<string>();
  while ((m = re.exec(html ?? "")) !== null) {
    try {
      collectTypes(JSON.parse(m[1]), types);
    } catch {
      continue;
    }
  }
  for (const t of types) if (LOCAL_BUSINESS_TYPES.has(t)) return true;
  return false;
}

/** Visible word count, for thin-content detection. Reuses a small prose strip
 * — NOT kb-ingest's htmlToText (that one deliberately drops nav/header/
 * footer, which would make a thin page look thinner than a caller sees). */
export function visibleWordCount(html: string): number {
  let s = html ?? "";
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  const words = s.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/** Does the page's visible text contain this location's phone number, in any
 * common formatting? Compares digits only so "(213) 555-0100" matches
 * "213-555-0100" and "2135550100" alike. */
export function pageContainsPhone(html: string, phoneE164: string | null): boolean {
  if (!phoneE164) return false;
  const wantDigits = phoneE164.replace(/\D/g, "").replace(/^1/, ""); // drop US country code for comparison
  if (wantDigits.length < 7) return false;
  const text = html.replace(/<[^>]+>/g, " ");
  const pageDigits = text.replace(/\D/g, "");
  return pageDigits.includes(wantDigits);
}

// -----------------------------------------------------------------------------
// The rule set. Pure function: page + the location's own NAP in, findings out.
// Nothing here writes to the database — the edge function maps this output
// onto seo_findings rows.
// -----------------------------------------------------------------------------

export type CrawlFinding = {
  finding_type: string;
  severity: "critical" | "warning" | "info";
  title: string;
  details: Record<string, unknown>;
};

export type LocationNap = {
  name: string | null;
  phone_number: string | null;
};

const TITLE_MIN = 15;
const TITLE_MAX = 60;
const META_DESC_MIN = 50;
const META_DESC_MAX = 160;
const THIN_CONTENT_WORDS = 300;

export function auditPage(html: string, location: LocationNap): CrawlFinding[] {
  const findings: CrawlFinding[] = [];

  const title = extractTitle(html);
  if (!title) {
    findings.push({
      finding_type: "missing_title",
      severity: "critical",
      title: "Page has no <title> tag",
      details: {},
    });
  } else if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    findings.push({
      finding_type: "title_length",
      severity: "info",
      title: `Title is ${title.length} characters (aim for ${TITLE_MIN}–${TITLE_MAX})`,
      details: { title, length: title.length },
    });
  }

  const metaDescription = extractMetaDescription(html);
  if (!metaDescription) {
    findings.push({
      finding_type: "missing_meta_description",
      severity: "warning",
      title: "Page has no meta description",
      details: {},
    });
  } else if (metaDescription.length < META_DESC_MIN || metaDescription.length > META_DESC_MAX) {
    findings.push({
      finding_type: "meta_description_length",
      severity: "info",
      title: `Meta description is ${metaDescription.length} characters (aim for ${META_DESC_MIN}–${META_DESC_MAX})`,
      details: { meta_description: metaDescription, length: metaDescription.length },
    });
  }

  const h1s = extractH1s(html);
  if (h1s.length === 0) {
    findings.push({
      finding_type: "missing_h1",
      severity: "warning",
      title: "Page has no H1",
      details: {},
    });
  } else if (h1s.length > 1) {
    findings.push({
      finding_type: "multiple_h1",
      severity: "warning",
      title: `Page has ${h1s.length} H1 tags (expected exactly 1)`,
      details: { h1s },
    });
  }

  if (!hasLocalBusinessSchema(html)) {
    findings.push({
      finding_type: "missing_local_business_schema",
      severity: "warning",
      title: "Page has no LocalBusiness structured data",
      details: {},
    });
  }

  const images = extractImages(html);
  const missingAlt = images.filter((i) => !i.alt);
  if (missingAlt.length > 0) {
    findings.push({
      finding_type: "images_missing_alt",
      severity: "warning",
      title: `${missingAlt.length} of ${images.length} image${images.length === 1 ? "" : "s"} missing alt text`,
      details: { missing: missingAlt.map((i) => i.src).slice(0, 20), total_images: images.length },
    });
  }

  const words = visibleWordCount(html);
  if (words < THIN_CONTENT_WORDS) {
    findings.push({
      finding_type: "thin_content",
      severity: "warning",
      title: `Page has only ${words} words of visible content (under ${THIN_CONTENT_WORDS})`,
      details: { word_count: words },
    });
  }

  if (location.phone_number && !pageContainsPhone(html, location.phone_number)) {
    findings.push({
      finding_type: "phone_not_on_page",
      severity: "info",
      title: "This location's phone number doesn't appear anywhere on the page",
      details: {},
    });
  }

  return findings;
}
