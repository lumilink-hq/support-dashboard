// =============================================================================
// product-sync/woo-store.ts — the PUBLIC WooCommerce Store API adapter.
//
// Third adapter behind the shared ProductRow contract (with shopify.ts and
// woo.ts). Same output, different source: `/wp-json/wc/store/v1/products` is the
// endpoint a Woo storefront's own JavaScript uses, so it is **unauthenticated**
// and returns exactly what any shopper can already see.
//
// WHY THIS EXISTS — three reasons, in order of how much they matter:
//
//  1. ONBOARDING WITHOUT CREDENTIALS. Issuing a REST key means logging into a
//     client's WordPress admin. This adapter needs nothing but the domain, so a
//     catalog can be synced and demoed the same hour a client says yes.
//
//  2. IT DEGRADES INSTEAD OF FAILING. If a REST key is rotated, revoked, or a
//     security plugin starts blocking /wc/v3, the authenticated sync 401s and
//     the catalog goes stale — and under `stock_policy = 'always'` (migration
//     0021) a stale catalog is quoted confidently. Falling back to the public
//     API keeps prices and in/out-of-stock correct while the key is fixed.
//
//  3. THE IDs MATCH. Store API `id` is the same product id `/wc/v3` returns, so
//     `product_ref` is stable across a switch between adapters. Syncing publicly
//     today and authenticated tomorrow UPDATES rows; it does not duplicate them.
//
// WHAT IT CANNOT DO, and why that's acceptable:
//   • No exact stock counts. The Store API deliberately exposes only
//     `is_in_stock` / `is_on_backorder`, plus `low_stock_remaining` when a store
//     opts into showing it. So `tracks_inventory` is false and `total_inventory`
//     is usually null — which `search_products` already reads as "unknown", and
//     the agent declines to assert a number rather than inventing one. "Yes, in
//     stock" is the answer callers actually want; "we have 9 left" is a bonus.
//   • Draft/private products are invisible. That is a FEATURE here: everything
//     it returns is publicly purchasable, so nothing unlaunched can be offered.
//
// PRICES ARE IN MINOR UNITS. `prices.price` is the string "2500" with
// `currency_minor_unit: 2`, meaning $25.00. Reading it as a float gives $2,500 —
// a hundredfold error the agent would state with total confidence. This is the
// single most dangerous field in the payload.
// =============================================================================

import {
  cleanTitle,
  num,
  type ProductRow,
  type ProductVariantRow,
  saleFrom,
  stripHtml,
  stripTrailingSlash,
} from "./types.ts";

export const STORE_API_PER_PAGE = 100;

export function storeProductsUrl(baseUrl: string, page: number): string {
  return (
    `${stripTrailingSlash(baseUrl)}/wp-json/wc/store/v1/products` +
    `?per_page=${STORE_API_PER_PAGE}&page=${Math.max(1, page)}&orderby=id&order=asc`
  );
}

/** Probe URL — one product is enough to prove the endpoint is open. */
export function storeProbeUrl(baseUrl: string): string {
  return `${stripTrailingSlash(baseUrl)}/wp-json/wc/store/v1/products?per_page=1`;
}

/**
 * Convert a Store API money string to a real amount.
 *
 * `{ price: "2500", currency_minor_unit: 2 }` is $25.00. `currency_minor_unit`
 * is NOT always 2 — JPY is 0, and some currencies are 3 — so it must be read
 * from the payload rather than assumed.
 */
export function minorToMajor(
  value: unknown,
  minorUnit: unknown,
): number | null {
  const raw = num(value);
  if (raw === null) return null;
  const unit = Number(minorUnit);
  const exp = Number.isInteger(unit) && unit >= 0 && unit <= 4 ? unit : 2;
  return raw / 10 ** exp;
}

/**
 * Availability. `is_on_backorder` is treated as NOT available, matching woo.ts —
 * a caller asking "do you have it" means "does it ship now".
 */
export function storeAvailable(node: Record<string, any>): boolean {
  if (node?.is_on_backorder === true) return false;
  return node?.is_in_stock === true;
}

/**
 * Tags: category, tag AND brand slugs.
 *
 * The Store API exposes `brands` as a first-class array, which `/wc/v3` does not
 * without a plugin-specific call — so this adapter actually knows MORE about
 * brand than the authenticated one. Slugs (not names) to match migration 0020's
 * suffix-aware tag matching.
 */
export function storeTags(node: Record<string, any>): string[] {
  const out: string[] = [];
  for (const key of ["categories", "tags", "brands"]) {
    const list = Array.isArray(node?.[key]) ? node[key] : [];
    for (const t of list) {
      const slug = String(t?.slug ?? "").trim().toLowerCase();
      if (slug) out.push(slug);
    }
  }
  // Attribute TERMS are how a caller asks for a size: "do you have the
  // twenty-eight gram". Those live in attributes[].terms[].slug and are
  // otherwise unsearchable on a product whose variations aren't expanded.
  const attrs = Array.isArray(node?.attributes) ? node.attributes : [];
  for (const a of attrs) {
    for (const t of Array.isArray(a?.terms) ? a.terms : []) {
      const slug = String(t?.slug ?? "").trim().toLowerCase();
      if (slug) out.push(slug);
    }
  }
  return [...new Set(out)];
}

/** Brand first, since on this API it is a real field and is what "who makes it" means. */
export function storeVendor(node: Record<string, any>): string | null {
  const brands = Array.isArray(node?.brands) ? node.brands : [];
  for (const b of brands) {
    const name = cleanTitle(b?.name);
    if (name) return name;
  }
  return null;
}

const GENERIC_CATEGORIES = new Set(["uncategorized", "all", "shop", "products"]);

/**
 * Product type from the first non-generic category.
 *
 * Merchandising categories ("BOGO Deal", "Best Seller", the brand name) are
 * common and are NOT product types. They're left in `tags` where they're still
 * searchable, but they must not become the answer to "what kind of thing is
 * this" — and migration 0020 already derives a type from a tag prefix when this
 * column is null, which is a better answer than "BOGO Deal".
 */
export function storeProductType(node: Record<string, any>): string | null {
  const cats = Array.isArray(node?.categories) ? node.categories : [];
  const brandSlugs = new Set(
    (Array.isArray(node?.brands) ? node.brands : []).map((b: any) =>
      String(b?.slug ?? "").toLowerCase(),
    ),
  );
  for (const c of cats) {
    const slug = String(c?.slug ?? "").toLowerCase();
    if (GENERIC_CATEGORIES.has(slug)) continue;
    if (brandSlugs.has(slug)) continue; // a brand is not a type
    if (/(deal|sale|bogo|special|offer|featured|best[-_]?seller|top[-_]?rated|new)/.test(slug)) {
      continue; // merchandising, not a type
    }
    const name = cleanTitle(c?.name);
    if (name) return name;
  }
  return null;
}

/**
 * Variants from the Store API.
 *
 * `variations` here is `[{id, attributes:[{name, value}]}]` — the sizes, but NOT
 * their individual prices; the Store API only gives the parent's price RANGE.
 * That's still worth writing: "which sizes do you have" is a far more common
 * question than "what does the 14g cost specifically", and the range answers the
 * price question honestly ("from $25 to $110"). Per-variant prices need the
 * authenticated adapter.
 */
export function storeVariants(node: Record<string, any>): ProductVariantRow[] {
  const variations = Array.isArray(node?.variations) ? node.variations : [];
  const inStock = storeAvailable(node);

  if (variations.length) {
    return variations.map((v: any) => {
      const attrs = Array.isArray(v?.attributes) ? v.attributes : [];
      const title =
        attrs
          .map((a: any) => cleanTitle(a?.value ?? a?.option))
          .filter(Boolean)
          .join(" / ") || null;
      return {
        title,
        sku: null,
        // Unknown per variant on this API — null, never the parent's price,
        // which would state a specific number for the wrong size.
        price: null,
        // Also unknown per variant. The parent's flag is the best available
        // signal and is right whenever the whole product is out of stock.
        available: inStock ? null : false,
        inventory: null,
      };
    });
  }

  // Attribute terms are the fallback: a "simple" product can still advertise
  // sizes through attributes (this store does exactly that on its BOGO items).
  const attrs = Array.isArray(node?.attributes) ? node.attributes : [];
  const terms = attrs.flatMap((a: any) => (Array.isArray(a?.terms) ? a.terms : []));
  if (terms.length > 1) {
    return terms.map((t: any) => ({
      title: cleanTitle(t?.name) || null,
      sku: null,
      price: null,
      available: inStock ? null : false,
      inventory: null,
    }));
  }

  return [
    {
      title: null,
      sku: cleanTitle(node?.sku) || null,
      price: minorToMajor(node?.prices?.price, node?.prices?.currency_minor_unit),
      available: inStock,
      inventory: num(node?.low_stock_remaining),
    },
  ];
}

export function mapStoreProduct(node: Record<string, any>): ProductRow | null {
  const id = node?.id;
  const title = cleanTitle(node?.name);
  if (id === null || id === undefined || !title) return null;

  // Never sync a variation row as if it were a product — the Store API can
  // return them when queried by type, and they'd shadow their own parent.
  if (String(node?.type ?? "").toLowerCase() === "variation") return null;

  const prices = node?.prices ?? {};
  const minorUnit = prices?.currency_minor_unit;
  const range = prices?.price_range;

  const priceMin = range
    ? minorToMajor(range?.min_amount, minorUnit)
    : minorToMajor(prices?.price, minorUnit);
  const priceMax = range
    ? minorToMajor(range?.max_amount, minorUnit)
    : minorToMajor(prices?.price, minorUnit);

  // Discount. `regular_price` is the "was", also in minor units. This is where
  // Bud Club's whole merchandising lives — the homepage is BOGO and ounce
  // specials, and without these fields the agent quotes $25 flat for a product
  // the customer is looking at marked "$50 $25".
  // The platform's own `on_sale` flag is not trusted alone — see the note in
  // woo.ts. A discount is a real, strictly higher reference price or it is not
  // one, because "it's on sale" with no "off what" is not an answer.
  const regular = minorToMajor(prices?.regular_price, minorUnit);
  const sale = saleFrom(priceMin, regular);
  const onSale = sale.on_sale;

  return {
    product_ref: String(id),
    handle: cleanTitle(node?.slug) || null,
    title,
    product_type: storeProductType(node),
    vendor: storeVendor(node),
    // The Store API only returns published, purchasable products.
    status: "ACTIVE",
    tags: storeTags(node),
    description: stripHtml(node?.short_description) ?? stripHtml(node?.description),
    url: String(node?.permalink ?? "").trim() || null,
    currency: String(prices?.currency_code ?? "").trim().toUpperCase() || null,
    price_min: priceMin,
    price_max: priceMax,
    // The public API does not expose counts, so this is honestly false: the
    // agent may say "in stock" but must not say "we have N".
    tracks_inventory: false,
    total_inventory: num(node?.low_stock_remaining),
    available: storeAvailable(node),
    variants: storeVariants(node),
    on_sale: onSale,
    compare_at_min: sale.compare_at,
    // On a price-RANGE product the Store API gives no matching compare-at range,
    // so the max is only meaningful when there is a single price.
    compare_at_max: range ? null : sale.compare_at,
  };
}

export function storeProductsPageFrom(payload: unknown): {
  rows: ProductRow[];
  count: number;
} {
  const list = Array.isArray(payload) ? payload : [];
  const rows: ProductRow[] = [];
  for (const node of list) {
    const mapped = mapStoreProduct(node);
    if (mapped) rows.push(mapped);
  }
  return { rows, count: list.length };
}

/** Same header contract as /wc/v3 — see wooTotalPages. */
export function storeTotalPages(headers: {
  get(name: string): string | null;
}): number | null {
  const raw = headers.get("x-wp-totalpages") ?? headers.get("X-WP-TotalPages");
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
