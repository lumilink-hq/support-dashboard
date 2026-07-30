#!/usr/bin/env node
// =============================================================================
// fetch-woo-policies.mjs — the WooCommerce counterpart to
// fetch-shopify-policies.mjs. Pulls a store's policy pages so nobody has to
// retype them, and prints a starting point for clients.settings.policies.
//
//   node scripts/fetch-woo-policies.mjs https://budclub.example
//
//   # optional — lets the script also resolve the page WooCommerce has
//   # configured as its Terms page, instead of only guessing by slug:
//   WOO_CONSUMER_KEY=ck_… WOO_CONSUMER_SECRET=cs_… \
//     node scripts/fetch-woo-policies.mjs https://budclub.example
//
// WHY THIS IS A DIFFERENT SCRIPT AND NOT A FLAG ON THE SHOPIFY ONE:
// Shopify has a real API for this — `shop { shopPolicies { type body url } }`
// returns a typed, enumerable list. WordPress has NO equivalent. A Woo store's
// refund/shipping/terms policies are ordinary WP PAGES with no marker
// distinguishing them from "About Us", so they can only be found by matching
// slugs and titles. That means this script GUESSES, and the operator has to
// check what it found — which is the opposite of the Shopify contract and is
// why the two are not merged behind one interface.
//
// Run this ONCE PER STORE (and again when a policy changes) — NOT per call. The
// bodies are full pages of a few thousand words. A voice system prompt wants
// ~150 words of decision rules, and every token is re-sent each turn, so pasting
// a raw policy in would add latency to every single reply.
//
// The pipeline is: fetch here -> condense (by hand, or with a one-off model
// call) -> store on clients.settings.policies -> the agent prompt interpolates
// {{store_policies}}. Identical to the Shopify path from that point on.
// =============================================================================

const RAW_BASE = process.argv[2];
const KEY = process.env.WOO_CONSUMER_KEY;
const SECRET = process.env.WOO_CONSUMER_SECRET;

if (!RAW_BASE) {
  console.error("usage: node scripts/fetch-woo-policies.mjs https://store.example");
  process.exit(1);
}

// Accept a bare domain the way the production Zap does.
let BASE = RAW_BASE.trim().replace(/\/+$/, "");
if (!/^https?:\/\//i.test(BASE)) BASE = `https://${BASE}`;

// Slug/title fragments that identify a policy page. Ordered: the first match
// wins for a given category, so put the more specific fragment first.
// Ordered by how much a support agent needs them. REFUND is first because on a
// real store the refund page usually also carries cancellation AND delivery
// terms (budclub.com's is literally "refund-cancellation-delivery-policy"), so
// matching it first gets the most answers from one page.
const WANTED = [
  { type: "REFUND_POLICY", match: ["refund", "return", "rma", "cancellation"] },
  { type: "SHIPPING_POLICY", match: ["shipping", "delivery", "track-your-order", "tracking"] },
  // FAQ is not a policy, but on most stores it is where the ANSWERS live —
  // processing times, "where is my order", stock questions — while the policy
  // page carries the legal framing. A support agent needs both.
  { type: "FAQ", match: ["faq", "frequently-asked", "help-center", "support"] },
  { type: "TERMS_OF_SERVICE", match: ["terms", "conditions", "tos"] },
  { type: "PRIVACY_POLICY", match: ["privacy"] },
  { type: "LEGAL_NOTICE", match: ["legal", "disclaimer", "compliance", "security-policy"] },
];

function toText(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function classify(page) {
  const hay = `${page?.slug ?? ""} ${page?.title?.rendered ?? ""}`.toLowerCase();
  for (const w of WANTED) {
    if (w.match.some((m) => hay.includes(m))) return w.type;
  }
  return null;
}

// --- 1. All published pages. Public endpoint; no auth needed. ----------------
// Paged, because a content-heavy WordPress site can easily exceed 100 pages and
// the policy page is exactly the kind of old page that sorts to the end.
const pages = [];
for (let page = 1; page <= 10; page++) {
  const url = `${BASE}/wp-json/wp/v2/pages?per_page=100&page=${page}&status=publish&_fields=id,slug,link,title,content`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.error(`Could not reach ${BASE}: ${e.message}`);
    process.exit(1);
  }
  if (res.status === 400) break; // asked past the last page
  if (!res.ok) {
    console.error(
      `HTTP ${res.status} from the WordPress REST API.\n` +
        `A 401/403 usually means the REST API is locked down by a security plugin;\n` +
        `a 404 means permalinks are set to "Plain" and /wp-json is not routed.`,
    );
    process.exit(1);
  }
  const batch = await res.json();
  if (!Array.isArray(batch) || batch.length === 0) break;
  pages.push(...batch);
  const total = Number(res.headers.get("x-wp-totalpages"));
  if (Number.isInteger(total) && page >= total) break;
}

if (!pages.length) {
  console.error("No published pages found — policies would have to be written by hand.");
  process.exit(2);
}

// --- 2. Ask Woo which page it treats as Terms, if we have credentials. -------
// This is the one policy WooCommerce actually records, so it beats guessing.
let termsPageId = null;
if (KEY && SECRET) {
  try {
    const auth = "Basic " + Buffer.from(`${KEY}:${SECRET}`).toString("base64");
    const res = await fetch(`${BASE}/wp-json/wc/v3/settings/account`, {
      headers: { Authorization: auth },
    });
    if (res.ok) {
      const settings = await res.json();
      const row = (Array.isArray(settings) ? settings : []).find(
        (s) => s?.id === "woocommerce_terms_page_id",
      );
      const id = Number(row?.value);
      if (Number.isInteger(id) && id > 0) termsPageId = id;
    } else {
      console.error(`(note: could not read Woo account settings — HTTP ${res.status})`);
    }
  } catch {
    console.error("(note: could not read Woo account settings)");
  }
}

// --- 3. Match pages to policy types. -----------------------------------------
const found = [];
const seen = new Set();
for (const p of pages) {
  let type = classify(p);
  if (!type && termsPageId && p.id === termsPageId) type = "TERMS_OF_SERVICE";
  if (!type || seen.has(type)) continue;
  seen.add(type);
  found.push({ type, page: p });
}

if (!found.length) {
  console.error(
    `Scanned ${pages.length} pages and matched none.\n` +
      `Slugs seen: ${pages.map((p) => p.slug).slice(0, 40).join(", ")}\n` +
      `Either this store has no policy pages, or they are named unusually — in\n` +
      `which case pick them out of that list by hand.`,
  );
  process.exit(2);
}

console.log(`# ${BASE} — policy pages (WordPress REST)\n`);
let totalWords = 0;
for (const { type, page } of found) {
  const text = toText(page?.content?.rendered);
  const words = text.split(/\s+/).filter(Boolean).length;
  totalWords += words;
  const title = toText(page?.title?.rendered);
  console.log(
    `\n${"=".repeat(78)}\n## ${title || type}  (${type}, ${words} words)\n${page.link ?? ""}\n${"=".repeat(78)}\n`,
  );
  console.log(text);
}

const missing = WANTED.filter((w) => !seen.has(w.type)).map((w) => w.type);

console.error(`
---
${found.length} page(s) matched out of ${pages.length} scanned, ${totalWords} words total.
${missing.length ? `Not found: ${missing.join(", ")}.` : "All policy types matched."}

These were matched by SLUG, not declared by an API — read the titles above and
confirm they are the right pages before trusting them.

A voice prompt wants ~150 words. Condense to decision rules only — what the
agent must DO — then:

  update clients set settings = settings || jsonb_build_object('policies', '<condensed>')
   where slug = '<slug>';
`);
