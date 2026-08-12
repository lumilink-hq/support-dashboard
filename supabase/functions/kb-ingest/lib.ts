// =============================================================================
// lib.ts — pure, side-effect-free helpers for the kb-ingest worker.
//
// Kept separate from index.ts (the Deno/Supabase/fetch wiring) so every parsing
// and chunking decision can be unit tested in plain Node/tsx with no network,
// no Deno and no database. Same split as voice-personalization and
// voice-product-lookup. No imports.
// =============================================================================

// -----------------------------------------------------------------------------
// Chunking targets.
//
// gte-small TRUNCATES INPUT AT 512 TOKENS. Anything past that is silently
// dropped — no error, no warning, just an embedding that represents the first
// part of the text and answers questions about the rest badly. So the target
// below is a hard product constraint, not a tuning knob.
//
// ~4 characters per token is the usual English approximation, making 512 tokens
// roughly 2000 characters. 1400 leaves real headroom for text that tokenizes
// worse than average: prices, part numbers, URLs and ALL-CAPS all produce more
// tokens per character than prose, and a policy page is full of them.
// -----------------------------------------------------------------------------
export const CHUNK_TARGET_CHARS = 1400;

// Overlap so a fact that straddles a boundary survives in one piece. Without
// it, "we do not ship to Alaska or Hawaii" split across two chunks retrieves as
// two half-answers and the agent gives the caller one of them.
export const CHUNK_OVERLAP_CHARS = 200;

/** Hard ceiling on pages fetched per crawl. See discoverLinks. */
export const CRAWL_PAGE_LIMIT = 20;

// -----------------------------------------------------------------------------
// HTML → text
// -----------------------------------------------------------------------------

/** Elements whose CONTENT is never useful and often actively harmful. */
const DROP_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  // Navigation and boilerplate repeat on every page of a site. Left in, they
  // become the most common text in the corpus and dominate retrieval: ask any
  // question and the nearest chunk is the cookie banner.
  "nav",
  "header",
  "footer",
  "aside",
  "form",
];

/**
 * Strip HTML to readable text.
 *
 * Regex rather than a DOM parser, deliberately. Edge Functions have no DOM, and
 * pulling a parser in for this is a large dependency to extract paragraphs from
 * a marketing site. The failure mode of a regex here is mildly untidy text,
 * which an embedding tolerates; it is not a correctness boundary.
 */
export function htmlToText(html: string): string {
  if (!html) return "";
  let s = html;

  // Comments first — they can contain anything, including unbalanced tags.
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  for (const el of DROP_ELEMENTS) {
    s = s.replace(new RegExp(`<${el}\\b[^>]*>[\\s\\S]*?<\\/${el}>`, "gi"), " ");
    // Unclosed variants (common with <svg> and stray <form>): drop the open tag
    // rather than leaving its attributes to be read as prose.
    s = s.replace(new RegExp(`<${el}\\b[^>]*>`, "gi"), " ");
  }

  // Block-level boundaries become newlines BEFORE tags are stripped, so
  // "</p><p>" does not weld two sentences into one word.
  s = s.replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(td|th)>/gi, "\t");

  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);

  // Collapse whitespace but keep paragraph breaks — they are the only structure
  // left, and the chunker splits on them.
  s = s.replace(/[ \t ]+/g, " ");
  s = s.replace(/\s*\n\s*/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

/** The handful of entities that actually appear in body copy. */
export function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
    times: "×",
    trade: "™",
    reg: "®",
    copy: "©",
  };
  return s
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => named[name] ?? m)
    .replace(/&#(\d+);/g, (_m, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) =>
      String.fromCodePoint(parseInt(code, 16)),
    );
}

/** Page title, for the kb_documents row. Falls back to the URL path. */
export function extractTitle(html: string, url: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html ?? "");
  const raw = m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
  if (raw) return raw.slice(0, 200);
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    return (path === "" ? u.hostname : `${u.hostname}${path}`).slice(0, 200);
  } catch {
    return url.slice(0, 200);
  }
}

/**
 * Does this page carry enough prose to be worth embedding?
 *
 * A JS-rendered site returns a nearly empty shell to a plain fetch — a div and
 * a bundle tag. Embedding that produces a chunk that matches nothing and, worse,
 * marks the document `ready`, so the client is told their site is synced when
 * the agent learned nothing at all. Better to fail loudly.
 */
export function hasUsableText(text: string): boolean {
  return text.replace(/\s+/g, " ").trim().length >= 200;
}

// -----------------------------------------------------------------------------
// Link discovery — shallow, same-domain
// -----------------------------------------------------------------------------

/** File extensions that are not pages. */
const NON_PAGE = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|mjs|json|xml|zip|gz|mp[34]|mov|avi|woff2?|ttf|eot)(\?|#|$)/i;

/**
 * Paths that are never useful to a phone agent and actively dilute retrieval.
 *
 * This list is the difference between a KB that answers "what's your returns
 * policy" and one whose nearest chunk is a blog post from 2019. Crawling
 * everything sounds thorough and produces a worse agent.
 */
const SKIP_PATH =
  /\/(wp-admin|wp-login|wp-json|cart|checkout|basket|my-account|account|login|signin|sign-in|register|signup|search|feed|rss|tag|tags|author|blog\/page|page\/\d|careers?|jobs?|privacy-policy\/?$|cookie)/i;

/**
 * Same-domain links from one page, absolute and de-duplicated.
 *
 * SAME REGISTRABLE HOST ONLY, and exact-host at that: a link to
 * `shop.example.com` from `example.com` is not followed. Subdomains are
 * routinely a different system with different content, and "shallow crawl"
 * turning into "discovered your entire Shopify store" is the kind of surprise
 * that ends with a client's competitor pricing in their bot.
 */
export function discoverLinks(
  html: string,
  baseUrl: string,
  limit = CRAWL_PAGE_LIMIT,
): string[] {
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
    // mailto:, tel:, javascript: and data: are not pages.
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

/**
 * Canonical form for de-duplication.
 *
 * Drops the fragment and trailing slash, and strips tracking parameters. Left
 * alone, `/pricing`, `/pricing/`, `/pricing#top` and `/pricing?utm_source=fb`
 * are four URLs, four documents and four copies of the same chunks — which
 * makes retrieval return the same passage repeatedly, heard by the caller as
 * the agent repeating itself.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      // `utm_` is a PREFIX (utm_source, utm_medium, utm_campaign…), so it needs
      // the trailing `.*`. Anchoring it as `^utm_$` — which is what this looked
      // like at first glance — matches a parameter literally named "utm_" and
      // therefore nothing at all, letting every tracking variant through and
      // turning one page into five documents.
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

// -----------------------------------------------------------------------------
// robots.txt
// -----------------------------------------------------------------------------

/**
 * Is `path` allowed for our user-agent?
 *
 * A deliberately small subset of the robots spec: `User-agent`, `Disallow`,
 * `Allow`, and longest-match-wins between them. Enough to respect a site
 * owner's stated wishes, which is the point — we are fetching a stranger's
 * server on a schedule, on behalf of a customer who says they own it.
 *
 * FAILS OPEN on an unreadable or missing robots.txt, matching how crawlers
 * conventionally behave: no robots.txt means no restrictions stated.
 */
export function isAllowedByRobots(
  robotsTxt: string | null,
  path: string,
  userAgent = "lumilink",
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
      // Consecutive User-agent lines share one rule block.
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
  // A group naming us specifically overrides the wildcard group entirely — that
  // is what the spec says, and it is how a site owner grants or denies one
  // crawler without touching the others.
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes("*"));
  const group = specific ?? wildcard;
  if (!group) return true;

  let best: { allow: boolean; length: number } | null = null;
  for (const rule of group.rules) {
    // "Disallow:" with an empty value means allow everything; it is not a
    // zero-length prefix match on every path.
    if (rule.path === "") continue;
    if (!pathMatches(rule.path, path)) continue;
    if (!best || rule.path.length > best.length) {
      best = { allow: rule.allow, length: rule.path.length };
    }
  }

  return best ? best.allow : true;
}

/** Prefix match with `*` and `$` support. */
function pathMatches(pattern: string, path: string): boolean {
  if (!pattern.includes("*") && !pattern.endsWith("$")) {
    return path.startsWith(pattern);
  }
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const anchored = escaped.endsWith("\\$")
    ? "^" + escaped.slice(0, -2) + "$"
    : "^" + escaped;
  try {
    return new RegExp(anchored).test(path);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Chunking
// -----------------------------------------------------------------------------

/**
 * Split text into embeddable chunks.
 *
 * Splits on PARAGRAPHS first, then sentences, then hard character boundaries.
 * The order matters: a chunk that ends mid-sentence embeds a fragment whose
 * meaning is partly in the chunk next door, and retrieval then returns
 * something that reads to the caller as the agent losing its thread.
 *
 * Every returned chunk is <= targetChars, which is the property the 512-token
 * truncation limit depends on.
 */
export function chunkText(
  text: string,
  targetChars = CHUNK_TARGET_CHARS,
  overlapChars = CHUNK_OVERLAP_CHARS,
): string[] {
  const clean = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= targetChars) return [clean];

  const pieces = splitToPieces(clean, targetChars);

  const chunks: string[] = [];
  let buf = "";

  for (const piece of pieces) {
    if (buf && buf.length + 1 + piece.length > targetChars) {
      chunks.push(buf.trim());
      const tail = overlapChars > 0 ? tailOf(buf, overlapChars) : "";
      buf = tail ? tail + "\n" + piece : piece;
    } else {
      buf = buf ? buf + "\n" + piece : piece;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());

  // The overlap can push a chunk over target when a single piece is already
  // close to it. Hard-split anything still too long — the invariant matters
  // more than the prettiness of the boundary.
  return chunks.flatMap((c) =>
    c.length <= targetChars ? [c] : hardSplit(c, targetChars),
  );
}

/** Paragraphs, then sentences for oversized paragraphs, then hard splits. */
function splitToPieces(text: string, targetChars: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= targetChars) {
      out.push(p);
      continue;
    }
    for (const sentence of splitSentences(p)) {
      if (sentence.length <= targetChars) out.push(sentence);
      else out.push(...hardSplit(sentence, targetChars));
    }
  }
  return out;
}

/**
 * Sentence split that does not break on common abbreviations or on decimals.
 * "$1,299.00 covers it. Call us." must be two sentences, not three.
 */
function splitSentences(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "\n") continue;
    if (ch === "." && /\d/.test(text[i + 1] ?? "")) continue; // 1.5, $12.00
    const next = text[i + 1];
    if (next && next !== " " && next !== "\n" && next !== '"' && next !== "'") continue;
    const seg = text.slice(start, i + 1).trim();
    if (seg && !/\b(mr|mrs|ms|dr|st|inc|ltd|co|vs|approx|no|est)\.$/i.test(seg)) {
      parts.push(seg);
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.length ? parts : [text];
}

function hardSplit(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size).trim());
  return out.filter(Boolean);
}

/** Last `n` characters, snapped forward to a word boundary. */
function tailOf(s: string, n: number): string {
  if (s.length <= n) return s;
  const slice = s.slice(s.length - n);
  const space = slice.indexOf(" ");
  return (space === -1 ? slice : slice.slice(space + 1)).trim();
}

// -----------------------------------------------------------------------------
// Change detection
// -----------------------------------------------------------------------------

/**
 * FNV-1a, 32-bit, hex. Used only to answer "did this page change since last
 * sync?" so that an unchanged page is not re-embedded.
 *
 * NOT a security primitive and never used as one — no signature, no
 * deduplication of untrusted input depends on it. A cryptographic hash would
 * need a Web Crypto call, which is async and would drag this whole module into
 * promises for a comparison whose worst failure is one unnecessary re-embed.
 */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Normalise a user-supplied website address into something fetchable. */
export function normalizeSiteUrl(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  // People type "acme.com". Default to https rather than rejecting them.
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname.includes(".")) return null;
    return normalizeUrl(u.toString());
  } catch {
    return null;
  }
}
