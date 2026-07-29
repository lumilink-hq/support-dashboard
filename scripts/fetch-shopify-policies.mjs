#!/usr/bin/env node
// =============================================================================
// fetch-shopify-policies.mjs — pull a store's legal policies straight from
// Shopify so nobody has to retype them, and print a starting point for
// clients.settings.policies.
//
//   SHOPIFY_ACCESS_TOKEN=shpat_… node scripts/fetch-shopify-policies.mjs \
//     tsunami-store-7957.myshopify.com
//
// Run this ONCE PER STORE (and again when a policy changes) — NOT per call.
// The bodies are full HTML pages of a few thousand words. A voice system prompt
// wants ~150 words of decision rules, and every token is re-sent each turn, so
// pasting the raw policy in would add latency to every single reply.
//
// The pipeline is: fetch here -> condense (by hand, or with a one-off model
// call) -> store on clients.settings.policies -> the agent prompt interpolates
// {{store_policies}}.
// =============================================================================

const SHOP = process.argv[2];
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";

if (!SHOP || !TOKEN) {
  console.error(
    "usage: SHOPIFY_ACCESS_TOKEN=shpat_… node scripts/fetch-shopify-policies.mjs <shop>.myshopify.com",
  );
  process.exit(1);
}

const QUERY = `
query ShopPolicies {
  shop {
    name
    shopPolicies { type title body url }
  }
}`.trim();

// Policy bodies are HTML. Strip to readable text for the condensing step.
function toText(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
  method: "POST",
  headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
  body: JSON.stringify({ query: QUERY }),
});

if (!res.ok) {
  console.error(`HTTP ${res.status}. A 403 usually means the token lacks the legal-policy scope.`);
  process.exit(1);
}

const body = await res.json();
if (Array.isArray(body.errors) && body.errors.length) {
  console.error("GraphQL error:", JSON.stringify(body.errors, null, 2));
  process.exit(1);
}

const policies = body?.data?.shop?.shopPolicies ?? [];
if (!policies.length) {
  console.error("No policies published on this store — they'd have to be written by hand.");
  process.exit(2);
}

console.log(`# ${body.data.shop.name} — policies (API ${API_VERSION})\n`);
let totalWords = 0;
for (const p of policies) {
  const text = toText(p.body);
  const words = text.split(/\s+/).filter(Boolean).length;
  totalWords += words;
  console.log(`\n${"=".repeat(78)}\n## ${p.title || p.type}  (${words} words)\n${p.url ?? ""}\n${"=".repeat(78)}\n`);
  console.log(text);
}

console.error(`
---
${policies.length} policies, ${totalWords} words total.
A voice prompt wants ~150. Condense to decision rules only — what the agent must
DO — then:

  update clients set settings = settings || jsonb_build_object('policies', '<condensed>')
   where slug = '<slug>';
`);
