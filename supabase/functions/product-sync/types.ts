// =============================================================================
// product-sync/types.ts — the platform-agnostic contract.
//
// This file is the whole point of the adapter split. `products_cache`,
// `upsert_products`, `search_products` and `voice-product-lookup` know nothing
// about Shopify or WooCommerce; they only know `ProductRow`. Each adapter
// (shopify.ts, woo.ts) is responsible for one job: turn its platform's product
// payload into this shape. Nothing platform-specific belongs in here, and
// nothing in here should be redefined inside an adapter.
//
// The rule that keeps the two honest: every field below means the SAME thing on
// both platforms. Where a platform can't answer, the adapter returns null rather
// than inventing a value — `search_products` treats null as "unknown" and the
// agent declines to assert, which is the safe failure.
//
// No Deno, no network, no Supabase — unit-testable from plain node.
// =============================================================================

/**
 * One row of products_cache, as the adapters produce it.
 *
 * `price` is always a UNIT price and `total_inventory` is always a whole-product
 * count. Shopify and Woo disagree about both natively (Woo line totals are line
 * totals, Woo stock can be tracked per-variation or per-parent), so the adapters
 * normalize rather than the SQL.
 */
export type ProductVariantRow = {
  title: string | null;
  sku: string | null;
  price: number | null;
  available: boolean | null;
  inventory: number | null;
};

export type ProductRow = {
  /** Shopify product gid, or the numeric id as text for Woo. Stable across renames. */
  product_ref: string;
  handle: string | null;
  title: string;
  product_type: string | null;
  vendor: string | null;
  /** Raw platform status. The SQL decides what is surfaceable — never filter here. */
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
  variants: ProductVariantRow[];
  /**
   * Discounted right now, per the platform.
   *
   * Stored INDEPENDENTLY of compare_at_*: a store can flag a sale without
   * publishing a struck-through price, so deriving one from the other loses
   * real information in both directions. `false` is the honest default for a
   * platform that doesn't say.
   */
  on_sale: boolean;
  /** The "was" price — Shopify compareAtPrice, Woo regular_price. */
  compare_at_min: number | null;
  compare_at_max: number | null;
};

/**
 * Decide `on_sale` / `compare_at_*` from a current and a reference price.
 *
 * Shared by all three adapters so they cannot disagree about what counts as a
 * discount. The rule: a reference price only counts when it is STRICTLY GREATER
 * than what's being charged. Platforms routinely carry a compare-at equal to
 * the price (a sale that ended, a field filled in by habit), and treating that
 * as a discount makes the agent announce "0% off" — which sounds broken and
 * erodes trust in every other number it says.
 */
export function saleFrom(
  price: number | null,
  compareAt: number | null,
): { on_sale: boolean; compare_at: number | null } {
  if (
    price === null ||
    compareAt === null ||
    !Number.isFinite(price) ||
    !Number.isFinite(compareAt) ||
    compareAt <= price
  ) {
    return { on_sale: false, compare_at: null };
  }
  return { on_sale: true, compare_at: compareAt };
}

/**
 * Decode HTML entities, including NUMERIC ones.
 *
 * WordPress returns product *names* entity-encoded even in JSON:
 * `"Milk and Cookies &#8211; Hybrid – 3.5G"`. Two things break if this is
 * skipped, and both are silent:
 *   • the agent reads the literal string "ampersand-hash-8211" out loud, and
 *   • `search_products` matches on `title`, so a caller asking for "Milk and
 *     Cookies" scores against a title containing entity noise.
 * Named entities alone are not enough — `&#8211;` (en dash) and `&#8217;`
 * (curly apostrophe) are the two that actually appear in real catalogs.
 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    // Ampersand LAST, so "&amp;#8211;" (double-encoded, which WordPress does
    // produce) doesn't decode into a live entity on the first pass.
    .replace(/&amp;/gi, "&");
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/**
 * Normalize the typographic characters a store's copy is full of into what a
 * caller would actually say and type. En/em dashes, curly quotes and
 * non-breaking spaces all look identical when spoken but are different bytes,
 * and `search_products` compares bytes.
 */
export function normalizeTypography(input: string): string {
  return input
    .replace(/[‐-―]/g, "-") // hyphen/en/em dashes
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[   ]/g, " ")
    .replace(/…/g, "...");
}

/** Product titles: decoded, de-typographed, whitespace-collapsed. */
export function cleanTitle(input: unknown): string {
  return normalizeTypography(decodeEntities(String(input ?? "")))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Product descriptions are HTML pages on every platform. This is read out loud,
 * so flatten to text and cap it — the SQL caps again at 400 chars for the spoken
 * payload, but there is no reason to carry kilobytes through the sync to get
 * there.
 */
export function stripHtml(input: unknown, maxLen = 600): string | null {
  if (input == null) return null;
  const text = normalizeTypography(
    decodeEntities(
      String(input)
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<\/(p|div|li|h[1-6])>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]*>/g, ""),
    ),
  )
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trimEnd()}…` : text;
}

/** Money and counts arrive as strings from both REST APIs. Never NaN. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** Vault secrets are stored as JSON strings. A malformed one must not throw. */
export function parseCreds<T>(raw: unknown): T {
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
