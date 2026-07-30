// =============================================================================
// shopify-product-sync/lib.ts — pure helpers for the catalog sync.
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

export type ShopifyCreds = {
  access_token?: string;
  base_url?: string;
};

function parseCreds<T>(raw: unknown): T {
  if (!raw) return {} as T;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return {} as T;
    }
  }
  return raw as T;
}

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

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

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
        variants(first: 25) {
          edges {
            node {
              id
              title
              sku
              price
              availableForSale
              inventoryQuantity
            }
          }
        }
      }
    }
  }
}`.trim();

export type ProductRow = {
  product_ref: string;
  handle: string | null;
  title: string;
  product_type: string | null;
  vendor: string | null;
  status: string | null;
  tags: string[];
  description: string | null;
  url: string | null;
  currency: string | null;
  price_min: number | null;
  price_max: number | null;
  tracks_inventory: boolean;
  total_inventory: number | null;
  available: boolean | null;
  variants: Array<{
    title: string | null;
    sku: string | null;
    price: number | null;
    available: boolean | null;
    inventory: number | null;
  }>;
};

/**
 * Shopify descriptions are HTML pages. This is read out loud, so flatten to text
 * and cap it — the SQL caps again at 400 chars for the spoken payload, but there
 * is no reason to carry kilobytes through the sync to get there.
 */
export function stripHtml(input: unknown, maxLen = 600): string | null {
  if (input == null) return null;
  const text = String(input)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6])>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trimEnd()}…` : text;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

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
  };
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
