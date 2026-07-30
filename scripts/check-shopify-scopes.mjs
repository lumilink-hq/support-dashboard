#!/usr/bin/env node
// =============================================================================
// check-shopify-scopes.mjs — ask Shopify what the existing token can actually do
// before assuming a new one is needed.
//
//   SHOPIFY_ACCESS_TOKEN=shpat_… node scripts/check-shopify-scopes.mjs \
//     tsunami-store-7957.myshopify.com
//
// The repo docs record the Tsunami custom app as `read_orders +
// read_fulfillments`, but that's a note someone wrote, not a fact read from the
// API. Custom apps often get broader scopes at creation than anyone wrote down.
// currentAppInstallation.accessScopes is authoritative — it's the grant list
// Shopify itself holds.
//
// Three probes, in order of cost:
//   1. accessScopes      -> what was granted, definitively
//   2. products query    -> does a real catalog read succeed
//   3. inventory fields  -> variant quantities need read_inventory separately,
//                           and this is the one people miss
//
// Prints a verdict. Exits 0 if products are readable, 1 if not, so it can gate a
// deploy step later.
//
// NOTE ON ERRORS: Shopify answers 200 OK for query errors and throttling alike,
// so every response body is inspected rather than trusting the status code.
// (Same trap as shopifyErrorFrom in voice-order-lookup/lib.ts.)
// =============================================================================

const SHOP = process.argv[2];
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
// Keep in step with voice-order-lookup/lib.ts AND the email Zap — they must
// move together.
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";

if (!SHOP || !TOKEN) {
  console.error(
    "usage: SHOPIFY_ACCESS_TOKEN=shpat_… node scripts/check-shopify-scopes.mjs <shop>.myshopify.com",
  );
  process.exit(2);
}

const ENDPOINT = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

async function gql(query, label) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": TOKEN,
      },
      body: JSON.stringify({ query }),
    });
  } catch (e) {
    return { transport: `network error: ${String(e)}` };
  }

  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    return { transport: `HTTP ${res.status} — token rejected outright` };
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { transport: `HTTP ${res.status}, unparseable body: ${text.slice(0, 200)}` };
  }

  // 200 + errors[] is the normal shape for a scope failure.
  return { body, errors: body.errors ?? null, data: body.data ?? null, label };
}

const line = (s = "") => console.log(s);
const ok = (s) => console.log(`  ✓ ${s}`);
const no = (s) => console.log(`  ✗ ${s}`);

line(`Shop:        ${SHOP}`);
line(`API version: ${API_VERSION}`);
line();

// ---------------------------------------------------------------------------
// 1. The authoritative grant list.
// ---------------------------------------------------------------------------
line("1) Granted access scopes");
const scopeRes = await gql(
  `query { currentAppInstallation { accessScopes { handle } } }`,
  "accessScopes",
);

let granted = null;
if (scopeRes.transport) {
  no(scopeRes.transport);
} else if (scopeRes.errors) {
  no(`could not read scopes: ${JSON.stringify(scopeRes.errors).slice(0, 300)}`);
} else {
  granted = (scopeRes.data?.currentAppInstallation?.accessScopes ?? []).map(
    (s) => s.handle,
  );
  if (granted.length === 0) {
    no("no scopes returned (unexpected)");
  } else {
    ok(`${granted.length} scopes: ${granted.sort().join(", ")}`);
  }
}

const has = (s) => Array.isArray(granted) && granted.includes(s);
line();

// ---------------------------------------------------------------------------
// 2. Can we actually read the catalog?
// ---------------------------------------------------------------------------
line("2) Catalog read (products, price range, availability)");
const productRes = await gql(
  `query {
    products(first: 3) {
      edges {
        node {
          id
          handle
          title
          productType
          status
          onlineStoreUrl
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
        }
      }
    }
  }`,
  "products",
);

let productsReadable = false;
if (productRes.transport) {
  no(productRes.transport);
} else if (productRes.errors) {
  no(`denied: ${JSON.stringify(productRes.errors).slice(0, 400)}`);
} else {
  const edges = productRes.data?.products?.edges ?? [];
  productsReadable = true;
  ok(`read ${edges.length} product(s)`);
  for (const { node } of edges) {
    const min = node.priceRangeV2?.minVariantPrice;
    const max = node.priceRangeV2?.maxVariantPrice;
    const band =
      min && max
        ? min.amount === max.amount
          ? `${min.amount} ${min.currencyCode}`
          : `${min.amount}–${max.amount} ${min.currencyCode}`
        : "no price";
    line(
      `      • ${node.title} [${node.productType || "no type"}] ${band} (${node.status})`,
    );
  }
}
line();

// ---------------------------------------------------------------------------
// 3. Inventory — the separate scope people forget.
// ---------------------------------------------------------------------------
line("3) Inventory read (totalInventory, variant quantities)");
const invRes = await gql(
  `query {
    products(first: 3) {
      edges {
        node {
          title
          totalInventory
          tracksInventory
          variants(first: 5) {
            edges {
              node { title availableForSale inventoryQuantity }
            }
          }
        }
      }
    }
  }`,
  "inventory",
);

let inventoryReadable = false;
if (invRes.transport) {
  no(invRes.transport);
} else if (invRes.errors) {
  no(`denied: ${JSON.stringify(invRes.errors).slice(0, 400)}`);
  line("      (products may still be readable — that's probe 2, above)");
} else {
  const edges = invRes.data?.products?.edges ?? [];
  inventoryReadable = true;
  ok("inventory fields returned");
  for (const { node } of edges) {
    const vs = (node.variants?.edges ?? [])
      .map((v) => `${v.node.title}:${v.node.inventoryQuantity ?? "?"}`)
      .join(", ");
    line(
      `      • ${node.title} total=${node.totalInventory ?? "?"} tracks=${node.tracksInventory} [${vs}]`,
    );
  }
}
line();

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
line("VERDICT");
if (productsReadable && inventoryReadable) {
  ok("Existing token is sufficient. No new token needed.");
  ok("You can answer catalog, price and live stock questions.");
} else if (productsReadable && !inventoryReadable) {
  ok("Catalog IS readable with the existing token.");
  no("Inventory is NOT. Add read_inventory to answer 'is it in stock'.");
  line(
    "      Catalog + price bands + descriptions work today; stock does not.",
  );
} else {
  no("Catalog is not readable. Add read_products (and read_inventory for stock).");
  line("      Re-scoping a custom app issues a NEW token — update the Vault secret.");
}

if (Array.isArray(granted)) {
  line();
  line("Scope check against the grant list:");
  for (const s of ["read_products", "read_inventory", "read_orders", "read_fulfillments", "read_all_orders"]) {
    (has(s) ? ok : no)(s);
  }
}

process.exit(productsReadable ? 0 : 1);
