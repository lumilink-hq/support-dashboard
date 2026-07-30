// =============================================================================
// product-sync/woo.ts — the WooCommerce product adapter.
//
// Produces the same `ProductRow` as shopify.ts, so products_cache,
// search_products and voice-product-lookup stay platform-agnostic. index.ts
// holds the I/O; everything here is pure and unit-tested by
// scripts/test-product-sync.ts.
//
// FOUR WAYS WOO DIFFERS FROM SHOPIFY THAT THE MAPPING HAS TO ABSORB:
//
//  1. REST + PAGINATION, NOT GRAPHQL CURSORS. Woo pages with ?page=N&per_page=100
//     and reports the total page count in the `X-WP-TotalPages` HEADER, not the
//     body. A sync that only looks at the body cannot tell "last page" from
//     "empty page" and will either stop early or loop.
//
//  2. VARIATIONS ARE A SECOND REQUEST. A `variable` product lists variation IDs
//     only; the sizes, prices and per-variation stock live at
//     /products/{id}/variations. Since "is the 3.5g in stock" is a VARIANT
//     question, skipping that request would make the whole catalog answer at
//     product granularity only. Simple products get one synthetic variant so
//     both platforms present the same shape.
//
//  3. NO CURRENCY ON THE PRODUCT. Shopify returns a currencyCode per price; Woo
//     has one store-wide currency, fetched once per sync from
//     /settings/general and passed in here.
//
//  4. NO `vendor`, AND CATEGORIES DO THE JOB OF productType. Woo core has no
//     vendor field, so it stays null — which is correct, and it also keeps the
//     "house vendor" suppression in migration 0020 from having to fire. Tags AND
//     categories are both flattened into `tags` by SLUG, because 0020's matcher
//     is suffix-aware over hyphenated tags ("indica" matches "strain-indica")
//     and Woo slugs are already in that shape.
// =============================================================================

import {
  num,
  type ProductRow,
  type ProductVariantRow,
  saleFrom,
  stripHtml,
  stripTrailingSlash,
} from "./types.ts";

export type WooCreds = {
  consumer_key?: string;
  consumer_secret?: string;
  base_url?: string;
};

/**
 * Pull WooCommerce credentials out of get_client_integration_secrets.
 *
 * The RPC labels the generic store blob `woocommerce`, which for once is the
 * right name on this path. `store` is accepted too so a client provisioned with
 * the neutral key still works. Mirrors pickShopifyCreds deliberately.
 */
export function pickWooCreds(
  secrets: Record<string, unknown> | null | undefined,
): WooCreds {
  if (!secrets) return {};
  const raw = secrets.woocommerce ?? secrets.store ?? secrets.woo;
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as WooCreds;
    } catch {
      return {};
    }
  }
  return raw as WooCreds;
}

export const WOO_PER_PAGE = 100; // Woo's documented maximum.

/** Products page URL. `status=any` so the SQL, not the sync, decides visibility. */
export function wooProductsUrl(baseUrl: string, page: number): string {
  return (
    `${stripTrailingSlash(baseUrl)}/wp-json/wc/v3/products` +
    `?per_page=${WOO_PER_PAGE}&page=${Math.max(1, page)}&status=any&orderby=id&order=asc`
  );
}

export function wooVariationsUrl(baseUrl: string, productId: string | number): string {
  return (
    `${stripTrailingSlash(baseUrl)}/wp-json/wc/v3/products/${encodeURIComponent(String(productId))}` +
    `/variations?per_page=${WOO_PER_PAGE}`
  );
}

export function wooSettingsUrl(baseUrl: string): string {
  return `${stripTrailingSlash(baseUrl)}/wp-json/wc/v3/settings/general`;
}

/**
 * Total page count, read from the `X-WP-TotalPages` response header.
 *
 * Woo does NOT put pagination in the body, so this header is the only signal
 * that a pass is complete. Missing or unparseable returns null, and the caller
 * must then treat the pass as INCOMPLETE — which suppresses the prune. Deleting
 * a catalog because a proxy stripped a header would be a very bad day.
 */
export function wooTotalPages(headers: {
  get(name: string): string | null;
}): number | null {
  const raw = headers.get("x-wp-totalpages") ?? headers.get("X-WP-TotalPages");
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Store currency out of /settings/general. Defaults to USD, never throws. */
export function wooCurrencyFrom(settings: unknown): string {
  const list = Array.isArray(settings) ? settings : [];
  const row = list.find(
    (s: any) => s?.id === "woocommerce_currency" || s?.id === "currency",
  );
  const v = row?.value ?? row?.default;
  const code = String(v ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "USD";
}

/** Only `variable` products have variations worth a second request. */
export function needsVariations(node: Record<string, any>): boolean {
  return (
    String(node?.type ?? "").toLowerCase() === "variable" &&
    Array.isArray(node?.variations) &&
    node.variations.length > 0
  );
}

/**
 * Is this purchasable right now?
 *
 * `onbackorder` is deliberately NOT available. Woo means "you may order it, it
 * ships later"; a caller asking "do you have it" is asking whether it ships now,
 * and answering yes to a backorder is the kind of small lie that produces a
 * refund request. The raw status survives on the variant rows.
 */
export function wooAvailable(node: Record<string, any>): boolean {
  return String(node?.stock_status ?? "").toLowerCase() === "instock";
}

/**
 * Does this product track inventory?
 *
 * `manage_stock` is `true`, `false`, or the STRING "parent" on a variation
 * (meaning the parent product holds the count). "parent" is truthy-as-a-string
 * and would read as `true` under a naive Boolean() — correct here by accident,
 * but only by accident, so it's explicit.
 */
export function wooTracksInventory(node: Record<string, any>): boolean {
  const m = node?.manage_stock;
  if (m === true) return true;
  if (typeof m === "string") return m.toLowerCase() === "parent" || m === "true";
  return false;
}

/** Woo status -> the cache's vocabulary. `publish` is the only surfaceable one. */
export function wooProductStatus(node: Record<string, any>): string {
  const s = String(node?.status ?? "").toLowerCase();
  if (s === "publish") return "ACTIVE";
  if (s === "draft" || s === "auto-draft") return "DRAFT";
  // private / pending / trash — exists, but must never be offered to a caller.
  return "ARCHIVED";
}

/**
 * Flatten categories + tags into one slug list.
 *
 * Both are `[{id, name, slug}]`. Slugs (not names) because 0020 matches tags
 * suffix-aware over hyphenated values, and because a slug is stable while a
 * display name is edited freely.
 */
export function wooTags(node: Record<string, any>): string[] {
  const out: string[] = [];
  for (const key of ["categories", "tags"]) {
    const list = Array.isArray(node?.[key]) ? node[key] : [];
    for (const t of list) {
      const slug = String(t?.slug ?? t?.name ?? "").trim().toLowerCase();
      if (slug) out.push(slug);
    }
  }
  return [...new Set(out)];
}

/**
 * Product type. Woo has no `productType`, so the FIRST category is the closest
 * analogue — and it's what a customer means by "what kind of thing is this".
 *
 * Left null when there are no categories: migration 0020 already derives a type
 * from a tag prefix when this column is empty, and letting that run is better
 * than inventing "Uncategorized" as a real type.
 */
export function wooProductType(node: Record<string, any>): string | null {
  const cats = Array.isArray(node?.categories) ? node.categories : [];
  for (const c of cats) {
    const name = String(c?.name ?? "").trim();
    if (name && name.toLowerCase() !== "uncategorized") return name;
  }
  return null;
}

function variantFrom(v: Record<string, any>, fallbackTitle: string): ProductVariantRow {
  // A variation's name is the full "Product - 3.5g"; `attributes` carries just
  // the distinguishing part, which is what a caller actually says.
  const attrs = Array.isArray(v?.attributes)
    ? v.attributes.map((a: any) => String(a?.option ?? "").trim()).filter(Boolean)
    : [];
  const title = attrs.length ? attrs.join(" / ") : (String(v?.name ?? "").trim() || fallbackTitle);
  return {
    title,
    sku: String(v?.sku ?? "").trim() || null,
    price: num(v?.price),
    available: wooAvailable(v),
    inventory: num(v?.stock_quantity),
  };
}

/**
 * Map one Woo product (plus its variations, if any) into a ProductRow.
 *
 * Returns null for a product with no usable identity, matching
 * mapShopifyProduct's contract — the caller drops it rather than writing a row
 * the agent could read out as a nameless item.
 */
export function mapWooProduct(
  node: Record<string, any>,
  opts: { currency?: string; variations?: Record<string, any>[] } = {},
): ProductRow | null {
  const id = node?.id;
  const title = String(node?.name ?? "").trim();
  if (id === null || id === undefined || String(id).trim() === "" || !title) {
    return null;
  }

  const variations = Array.isArray(opts.variations) ? opts.variations : [];
  const variants: ProductVariantRow[] = variations.length
    ? variations.map((v) => variantFrom(v, title))
    : [
        // A simple product still gets one variant, so the spoken answer and the
        // SQL never have to special-case "product with no variants".
        {
          title: null,
          sku: String(node?.sku ?? "").trim() || null,
          price: num(node?.price),
          available: wooAvailable(node),
          inventory: num(node?.stock_quantity),
        },
      ];

  // Price band across whatever variants exist. Woo's own `price` on a variable
  // product is only the lowest, so it can't stand in for the max.
  const prices = variants
    .map((v) => v.price)
    .filter((p): p is number => p !== null && Number.isFinite(p));
  const fallbackPrice = num(node?.price);
  const priceMin = prices.length ? Math.min(...prices) : fallbackPrice;
  const priceMax = prices.length ? Math.max(...prices) : fallbackPrice;

  // A variable product is in stock if ANY variation is — the parent's own
  // stock_status is frequently left at the default and lies.
  const available = variations.length
    ? variants.some((v) => v.available === true)
    : wooAvailable(node);

  // Same reasoning for the count: sum the variations that report one, and keep
  // null (not 0) when none do, because 0 means "none left" and null means
  // "not tracked". Conflating them makes the agent say "out of stock" about a
  // product that simply isn't counted.
  const variantCounts = variants
    .map((v) => v.inventory)
    .filter((n): n is number => n !== null);
  const totalInventory = variations.length
    ? (variantCounts.length ? variantCounts.reduce((a, b) => a + b, 0) : null)
    : num(node?.stock_quantity);

  // Discount. Woo's `on_sale` is authoritative on the parent; `regular_price` is
  // the "was". On a variable product the parent's regular_price is often blank,
  // so fall back to the variations' own.
  const regulars = variations.length
    ? variations.map((v) => num(v?.regular_price)).filter((n): n is number => n !== null)
    : [num(node?.regular_price)].filter((n): n is number => n !== null);
  const cmpMin = regulars.length ? Math.min(...regulars) : null;
  const cmpMax = regulars.length ? Math.max(...regulars) : null;
  const saleMin = saleFrom(priceMin, cmpMin);
  const saleMax = saleFrom(priceMax, cmpMax);
  // Woo's own `on_sale` flag is deliberately NOT trusted on its own. It stays
  // true after a scheduled sale lapses and is set on products whose
  // regular_price equals their price, so honouring it would have the agent
  // announcing discounts that don't exist — and the first thing a caller asks
  // is "off what?", which there'd be no answer to. A discount is a real,
  // strictly higher reference price or it isn't one.
  const onSale = saleMin.on_sale || saleMax.on_sale;

  return {
    product_ref: String(id),
    handle: String(node?.slug ?? "").trim() || null,
    title,
    product_type: wooProductType(node),
    // Woo core has no vendor. Null is honest, and it keeps 0020's house-vendor
    // suppression from needing to fire on this platform at all.
    vendor: null,
    status: wooProductStatus(node),
    tags: wooTags(node),
    // short_description is the marketing one-liner and is what should be spoken;
    // the full description is a page.
    description: stripHtml(node?.short_description) ?? stripHtml(node?.description),
    url: String(node?.permalink ?? "").trim() || null,
    currency: opts.currency ?? null,
    price_min: priceMin,
    price_max: priceMax,
    tracks_inventory: wooTracksInventory(node),
    total_inventory: totalInventory,
    available,
    variants,
    on_sale: onSale,
    compare_at_min: saleMin.compare_at,
    compare_at_max: saleMax.compare_at,
  };
}

/** Map a whole page. Unusable products are dropped, not written as blanks. */
export function wooProductsPageFrom(
  payload: unknown,
  opts: { currency?: string; variationsById?: Record<string, Record<string, any>[]> } = {},
): { rows: ProductRow[]; count: number } {
  const list = Array.isArray(payload) ? payload : [];
  const rows: ProductRow[] = [];
  for (const node of list) {
    const mapped = mapWooProduct(node, {
      currency: opts.currency,
      variations: opts.variationsById?.[String(node?.id)],
    });
    if (mapped) rows.push(mapped);
  }
  return { rows, count: list.length };
}
