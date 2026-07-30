// =============================================================================
// product-sync/shopify.ts — the Shopify product adapter.
//
// One of two adapters behind the shared `ProductRow` contract in types.ts (the
// other is woo.ts). Everything downstream — products_cache, upsert_products,
// search_products, voice-product-lookup — is platform-agnostic and must stay
// that way; if something here needs to leak outward, it belongs in types.ts.
//
// No Deno, no network, no Supabase: everything here is unit-testable from node
// (scripts/test-product-sync.ts). index.ts holds the I/O.
//
// Field choices are pinned against a REAL probe of the Tsunami store
// (scripts/check-shopify-scopes.mjs, run 2026-07-29), not assumed from docs:
//   • products carry productType "Flower" and variants named by weight
//     ("3.5g", "7g", "14g", "28g")
//   • variant inventoryQuantity goes to 0 independently — Super Runtz 28g was
//     out while its 3.5g had 9. So stock is a VARIANT question and the whole
//     variant list has to survive into the cache.
//   • status is not limited to ACTIVE/DRAFT/ARCHIVED — the probe returned
//     UNLISTED. Never switch on an allow-list of statuses here; store the raw
//     value and let the SQL decide what is surfaceable.
// =============================================================================

import {
  num,
  parseCreds,
  type ProductRow,
  saleFrom,
  stripHtml,
  stripTrailingSlash,
} from "./types.ts";

// Re-exported so existing importers (and the tests) keep one import site.
export { stripHtml, type ProductRow };

export type ShopifyCreds = {
  access_token?: string;
  base_url?: string;
};

/**
 * Pull Shopify credentials out of get_client_integration_secrets.
 *
 * ⚠️ The RPC labels the result `woocommerce` for EVERY platform — it predates
 * Shopify and reads the generic clients.store_credentials_ref. Reading only
 * `secrets.shopify` yields nothing and looks like a Vault problem. Same order of
 * preference as voice-order-lookup/lib.ts; keep them identical.
 */
export function pickShopifyCreds(
  secrets: Record<string, unknown> | null | undefined,
): ShopifyCreds {
  if (!secrets) return {};
  const raw = secrets.shopify ?? secrets.store ?? secrets.woocommerce;
  return parseCreds<ShopifyCreds>(raw);
}

/** Pinned to voice-order-lookup and the email Zap. Bump all three together. */
export const SHOPIFY_API_VERSION = "2026-04";

export function shopifyGraphqlUrl(baseUrl: string): string {
  return `${stripTrailingSlash(baseUrl)}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
}

/**
 * Shopify answers HTTP 200 for query errors AND for throttling, so the body is
 * the only source of truth. Returns null when the payload is trustworthy.
 */
export function shopifyErrorFrom(
  body: Record<string, any> | null,
): string | null {
  if (!body) return "empty response";
  if (Array.isArray(body.errors) && body.errors.length) {
    const codes = body.errors
      .map((e: any) => e?.extensions?.code ?? e?.message)
      .filter(Boolean);
    return codes.length ? String(codes.join(", ")) : "graphql error";
  }
  return null;
}

/** True when the error we just read is a rate limit worth retrying. */
export function isThrottled(body: Record<string, any> | null): boolean {
  if (!body || !Array.isArray(body.errors)) return false;
  return body.errors.some(
    (e: any) =>
      e?.extensions?.code === "THROTTLED" ||
      /throttl/i.test(String(e?.message ?? "")),
  );
}

/**
 * Seconds to wait before retrying, derived from Shopify's own cost extension
 * when present. Falls back to a fixed pause rather than hammering.
 */
export function throttleWaitMs(
  body: Record<string, any> | null,
  attempt: number,
): number {
  const st = body?.extensions?.cost?.throttleStatus;
  if (st && typeof st.restoreRate === "number" && typeof st.currentlyAvailable === "number") {
    const needed = Math.max(0, 100 - st.currentlyAvailable);
    const secs = needed / Math.max(st.restoreRate, 1);
    return Math.min(Math.ceil(secs * 1000) + 250, 10_000);
  }
  return Math.min(1000 * 2 ** attempt, 8000);
}

// -----------------------------------------------------------------------------
// The query. 50 products/page: large enough to keep round trips low, small
// enough to stay inside the calculated-cost ceiling once variants are included.
// -----------------------------------------------------------------------------
export const PRODUCTS_QUERY = `
query SyncProducts($cursor: String) {
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        handle
        title
        productType
        vendor
        status
        tags
        description
        onlineStoreUrl
        totalInventory
        tracksInventory
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        compareAtPriceRange {
          minVariantCompareAtPrice { amount }
          maxVariantCompareAtPrice { amount }
        }
        variants(first: 25) {
          edges {
            node {
              id
              title
              sku
              price
              compareAtPrice
              availableForSale
              inventoryQuantity
            }
          }
        }
      }
    }
  }
}`.trim();

// ProductRow, stripHtml and num now live in types.ts — shared with woo.ts so the
// two adapters cannot drift apart on the row shape. Imported and re-exported at
// the top of this file.

/** Map one GraphQL product node onto the products_cache row shape. */
export function mapShopifyProduct(node: Record<string, any>): ProductRow | null {
  const ref = node?.id ? String(node.id) : "";
  if (!ref) return null; // no stable key -> unusable, skip rather than guess

  const variantEdges: any[] = node?.variants?.edges ?? [];
  const variants = variantEdges.map((e) => {
    const v = e?.node ?? {};
    return {
      title: v.title ?? null,
      sku: v.sku ?? null,
      price: num(v.price),
      available: typeof v.availableForSale === "boolean" ? v.availableForSale : null,
      inventory: num(v.inventoryQuantity),
    };
  });

  const tracks = node?.tracksInventory !== false;

  // `available` means "can a caller buy ANY variant right now". Deliberately
  // derived from availableForSale rather than a positive inventory count:
  // Shopify lets a store oversell when it chooses to, and the store's own
  // purchasability flag is the honest answer to "can I get one".
  let available: boolean | null = null;
  if (variants.length) {
    const known = variants.filter((v) => v.available !== null);
    available = known.length ? known.some((v) => v.available === true) : null;
  } else if (!tracks) {
    available = true;
  }

  const min = node?.priceRangeV2?.minVariantPrice;
  const max = node?.priceRangeV2?.maxVariantPrice;

  // Discount. compareAtPriceRange is the product-level "was" band; when a store
  // sets compare-at per variant instead, fall back to the variants themselves so
  // a per-variant sale still registers.
  const cmpMinRaw =
    num(node?.compareAtPriceRange?.minVariantCompareAtPrice?.amount) ??
    lowest(variantEdges.map((e) => num(e?.node?.compareAtPrice)));
  const cmpMaxRaw =
    num(node?.compareAtPriceRange?.maxVariantCompareAtPrice?.amount) ??
    highest(variantEdges.map((e) => num(e?.node?.compareAtPrice)));

  const saleMin = saleFrom(num(min?.amount), cmpMinRaw);
  const saleMax = saleFrom(num(max?.amount), cmpMaxRaw);

  return {
    product_ref: ref,
    handle: node.handle ?? null,
    title: node.title ? String(node.title) : "(untitled)",
    product_type: node.productType || null,
    vendor: node.vendor || null,
    // Raw, not validated against an allow-list: the probe returned UNLISTED,
    // which is not in the documented ACTIVE/DRAFT/ARCHIVED set.
    status: node.status ? String(node.status) : null,
    tags: Array.isArray(node.tags) ? node.tags.map(String) : [],
    description: stripHtml(node.description),
    url: node.onlineStoreUrl ?? null,
    currency: min?.currencyCode ?? max?.currencyCode ?? null,
    price_min: num(min?.amount),
    price_max: num(max?.amount),
    tracks_inventory: tracks,
    total_inventory: num(node.totalInventory),
    available,
    variants,
    on_sale: saleMin.on_sale || saleMax.on_sale,
    compare_at_min: saleMin.compare_at,
    compare_at_max: saleMax.compare_at,
  };
}

function lowest(xs: (number | null)[]): number | null {
  const v = xs.filter((n): n is number => n !== null);
  return v.length ? Math.min(...v) : null;
}
function highest(xs: (number | null)[]): number | null {
  const v = xs.filter((n): n is number => n !== null);
  return v.length ? Math.max(...v) : null;
}

/** Pull the page of nodes plus the pagination cursor out of a response. */
export function productsPageFrom(data: Record<string, any> | null): {
  rows: ProductRow[];
  cursor: string | null;
  hasNext: boolean;
} {
  const conn = data?.products;
  const edges: any[] = conn?.edges ?? [];
  const rows = edges
    .map((e) => mapShopifyProduct(e?.node ?? {}))
    .filter((r): r is ProductRow => r !== null);
  return {
    rows,
    cursor: conn?.pageInfo?.endCursor ?? null,
    hasNext: Boolean(conn?.pageInfo?.hasNextPage),
  };
}
