// =============================================================================
// voice-product-lookup/lib.ts — pure helpers. No Deno, no Supabase, no network.
// Unit-tested from node via scripts/test-product-lookup.ts.
// =============================================================================

/**
 * Pull the tenant routing keys out of a tool-call body.
 *
 * ⚠️ ElevenLabs sends EVERY configured parameter on EVERY call, filling unused
 * ones with EMPTY STRINGS. Phone arrives as { called_number: "+1…",
 * client_ref: "" }; web as { called_number: "", client_ref: "slug" }. Treating
 * "" as present routes a web call down the phone path and 400s. Identical
 * semantics to voice-order-lookup's extractClientRef — keep them in step.
 */
export function extractClientRef(body: unknown): {
  calledNumber: string | null;
  clientSlug: string | null;
  conversationRef: string | null;
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const s = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t === "" ? null : t;
  };
  return {
    calledNumber: s(b.called_number),
    clientSlug: s(b.client_ref) ?? s(b.client_slug),
    // A browser call has no Twilio SID, so the ElevenLabs conversation id is the
    // only stable reference.
    conversationRef: s(b.call_sid) ?? s(b.conversation_id),
  };
}

/** What the caller asked about, cleaned up for a trigram search. */
export function normalizeProductQuery(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Strip the conversational wrapper the model sometimes includes verbatim.
  s = s.replace(
    /^\s*(do you (have|sell|carry)|is there|any|got any|looking for)\s+/i,
    "",
  );
  s = s.replace(/\?+\s*$/, "");
  // Keep letters, digits, spaces and the separators real product names use
  // ("3.5g", "WAVE Super Runtz", "pre-roll").
  s = s.replace(/[^A-Za-z0-9 .\-&']/g, " ").replace(/\s+/g, " ").trim();
  return s || null;
}

export type SpokenVariant = {
  size: string | null;
  price: number | null;
  available: boolean | null;
};

export type SpokenProduct = {
  name: string;
  type: string | null;
  price_from: number | null;
  price_to: number | null;
  currency: string | null;
  description: string | null;
  in_stock: boolean | null;
  stock_confidence: string;
  sizes: SpokenVariant[];
  sizes_in_stock: string[];
  sizes_out_of_stock: string[];
  // Discount, when the store publishes one. `was_price` is only ever present
  // alongside a real, higher reference price (see saleFrom in the sync), so the
  // agent can say "fifty, down to twenty-five" without checking the arithmetic.
  on_sale: boolean;
  was_price: number | null;
  discount_pct: number | null;
};

/** A product the agent can offer when everything asked for is sold out. */
export type SpokenAlternative = {
  name: string;
  price_from: number | null;
  price_to: number | null;
  currency: string | null;
  on_sale: boolean;
};

type RpcMatch = Record<string, any>;

/**
 * Reshape one search_products match into the compact form the agent reads.
 *
 * Two deliberate choices:
 *
 * 1. STOCK IS SPLIT BY SIZE. The real Tsunami catalog has one product with 28g
 *    at zero and 3.5g at nine. "Is it in stock" has no single answer there, so we
 *    hand the agent both lists and let the prompt say "the 14g is available, the
 *    28g is out" rather than a misleading yes or no.
 *
 * 2. WHEN THE CACHE IS STALE, STOCK IS STRIPPED ENTIRELY — not softened. The SQL
 *    already nulls total_inventory; here we drop in_stock and both size lists
 *    too. A hedged "it might be in stock" still gets heard as yes.
 */
export function toSpokenProduct(m: RpcMatch): SpokenProduct {
  const confidence = String(m.stock_confidence ?? "none");
  const fresh = confidence === "fresh";

  const rawVariants: any[] = Array.isArray(m.variants) ? m.variants : [];
  const sizes: SpokenVariant[] = rawVariants.map((v) => ({
    size: v?.title ?? null,
    price: typeof v?.price === "number" ? v.price : null,
    available: fresh && typeof v?.available === "boolean" ? v.available : null,
  }));

  const inStock: string[] = [];
  const outOfStock: string[] = [];
  if (fresh) {
    for (const v of rawVariants) {
      const label = v?.title ? String(v.title) : null;
      if (!label) continue;
      if (v.available === true) inStock.push(label);
      else if (v.available === false) outOfStock.push(label);
    }
  }

  return {
    name: String(m.title ?? "(unnamed)"),
    type: m.product_type ?? null,
    price_from: m.price_min != null ? Number(m.price_min) : null,
    price_to: m.price_max != null ? Number(m.price_max) : null,
    currency: m.currency ?? null,
    description: m.description || null,
    in_stock: fresh && typeof m.available === "boolean" ? m.available : null,
    stock_confidence: confidence,
    sizes,
    sizes_in_stock: inStock,
    sizes_out_of_stock: outOfStock,
    on_sale: m.on_sale === true,
    was_price: m.was_price != null ? Number(m.was_price) : null,
    discount_pct: m.discount_pct != null ? Number(m.discount_pct) : null,
  };
}

export function toAlternatives(raw: unknown): SpokenAlternative[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a: any) => ({
      name: String(a?.title ?? "").trim(),
      price_from: a?.price_min != null ? Number(a.price_min) : null,
      price_to: a?.price_max != null ? Number(a.price_max) : null,
      currency: a?.currency ?? null,
      on_sale: a?.on_sale === true,
    }))
    .filter((a) => a.name);
}

export type CatalogOverview = {
  types: Array<{ type: string; n: number; examples: string[] }>;
  brands: string[];
};

export type ProductLookupResponse = {
  found: boolean;
  need_product_name?: boolean;
  catalog_unavailable?: boolean;
  stock_known?: boolean;
  match_count?: number;
  // How many products cleared the floor before the read-aloud limit.
  total_matches?: number;
  // True when the query matched far more than can be read out, so the agent
  // should narrow rather than list.
  broad?: boolean;
  products?: SpokenProduct[];
  // Present ONLY on a miss: what the store does carry, so the agent offers real
  // options instead of a dead end.
  catalog?: CatalogOverview;
  // 'deals' when the caller asked about discounts rather than naming a product.
  intent?: string;
  // Every matched product is out of stock. Distinct from found:false — the store
  // DOES sell it, so the agent must not say otherwise.
  all_out_of_stock?: boolean;
  // In-stock products of the same kind, present only alongside all_out_of_stock.
  alternatives?: SpokenAlternative[];
  wrap_up?: boolean;
  message?: string;
};

/** Normalize the jsonb catalog_overview into something predictable. */
export function toCatalogOverview(raw: unknown): CatalogOverview | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, any>;
  const types = Array.isArray(o.types)
    ? o.types.map((t: any) => ({
        type: String(t?.type ?? "Other"),
        n: Number(t?.n ?? 0),
        examples: Array.isArray(t?.examples) ? t.examples.map(String) : [],
      }))
    : [];
  const brands = Array.isArray(o.brands) ? o.brands.map(String) : [];
  if (types.length === 0 && brands.length === 0) return undefined;
  return { types, brands };
}

/**
 * Turn a search_products result into the agent's response.
 *
 * The important case is `catalog_not_synced`: an empty match set and an unsynced
 * catalog look identical to a model, and it will happily tell the caller "we
 * don't sell that." Only one of those is true, so they get different flags and
 * different instructions.
 */
export function buildProductResponse(rpc: unknown): ProductLookupResponse {
  const r = (rpc ?? {}) as Record<string, any>;

  if (r.ok === false) {
    if (r.error === "need_product_name") {
      return {
        found: false,
        need_product_name: true,
        message: "Ask the caller which product they mean.",
      };
    }
    if (r.error === "catalog_not_synced") {
      return {
        found: false,
        catalog_unavailable: true,
        message:
          "Product information isn't available right now. Do NOT tell the caller the item does not exist — say you can't check the catalogue at the moment and offer to have someone follow up.",
      };
    }
    return {
      found: false,
      catalog_unavailable: true,
      message:
        "Product lookup failed. Do NOT guess. Offer to have a teammate follow up.",
    };
  }

  const matches: RpcMatch[] = Array.isArray(r.matches) ? r.matches : [];

  // ---------------------------------------------------------------------------
  // DEALS. "What's on sale" is a different question from "do you have X", and
  // answering it with the normal matcher returns whichever product is named
  // something similar to the word "deal".
  // ---------------------------------------------------------------------------
  if (r.intent === "deals") {
    if (matches.length === 0) {
      const catalog = toCatalogOverview(r.catalog);
      return {
        found: false,
        intent: "deals",
        match_count: 0,
        ...(catalog ? { catalog } : {}),
        message:
          "Nothing is discounted right now. Say so plainly — do NOT invent a promotion or " +
          "repeat one you remember from elsewhere. Offer to point them at what the store carries instead.",
      };
    }
    const products = matches.map(toSpokenProduct);
    const total = Number(r.total_matches ?? products.length);
    return {
      found: true,
      intent: "deals",
      match_count: products.length,
      total_matches: total,
      broad: r.broad === true,
      stock_known: r.fresh === true,
      products,
      message:
        `${total} product${total === 1 ? " is" : "s are"} on sale, biggest saving first; ` +
        `${products.length} listed here. Quote was_price and the current price together ` +
        `("normally fifty, on sale at twenty-five"). Only state a percentage if discount_pct is present. ` +
        `Everything listed is in stock. Do NOT describe any other product as discounted.`,
    };
  }

  if (matches.length === 0) {
    // A miss is not a dead end. search_products hands back the catalogue, so the
    // agent names what the store DOES carry. Callers rarely know a product's
    // exact title, and "we couldn't find that" ends a call that offering two
    // real options would have continued.
    const catalog = toCatalogOverview(r.catalog);
    if (catalog) {
      const typeList = catalog.types.map((t) => t.type).join(", ");
      return {
        found: false,
        match_count: 0,
        catalog,
        message:
          `No exact match. Do NOT say the store doesn't sell it — the caller may have used a different name. ` +
          `Say what is carried and let them pick: ${typeList || "see the catalog field"}. ` +
          `Use the examples and brands in the catalog field. Never invent a product that isn't listed there.`,
      };
    }
    return {
      found: false,
      match_count: 0,
      message:
        "Nothing in the catalogue matched. Ask them to describe it differently, or invite them to browse the store. Do not speculate about products.",
    };
  }

  const products = matches.map(toSpokenProduct);
  const stockKnown = r.fresh === true;
  const stockLine = stockKnown
    ? "Stock figures are current. You may say whether a size is available."
    : "Stock data is out of date and has been withheld. Describe the product and its price, but do NOT say whether it is in stock — offer to check and follow up.";

  // BROAD hit: the query matched far more than we can read out ("flower" hits the
  // whole catalogue). Listing three alphabetically sounds arbitrary and answers
  // nothing, so tell the agent to narrow using the catalogue instead.
  if (r.broad === true) {
    const catalog = toCatalogOverview(r.catalog);
    const total = Number(r.total_matches ?? products.length);
    return {
      found: true,
      match_count: products.length,
      total_matches: total,
      broad: true,
      stock_known: stockKnown,
      products,
      ...(catalog ? { catalog } : {}),
      message:
        `That matched ${total} products, so do NOT just read these few out as if they were the whole range. ` +
        `Say roughly how many there are and ask ONE narrowing question — a strain type, an effect they're after, or a size. ` +
        `Only name specific products if they ask for examples. ${stockLine}`,
    };
  }

  // ---------------------------------------------------------------------------
  // EVERYTHING MATCHED IS SOLD OUT. The most common way a product call ends
  // badly: the caller named the one thing that's gone, and the agent had nothing
  // to offer while a dozen similar products sat in stock. Note this is NOT
  // found:false — the store does sell it, and saying otherwise is a lie the
  // caller can check on the website in ten seconds.
  // ---------------------------------------------------------------------------
  const alternatives = toAlternatives(r.alternatives);
  if (r.all_out_of_stock === true) {
    return {
      found: true,
      match_count: products.length,
      total_matches: Number(r.total_matches ?? products.length),
      stock_known: stockKnown,
      all_out_of_stock: true,
      products,
      ...(alternatives.length ? { alternatives } : {}),
      message:
        alternatives.length
          ? "We DO sell this, it is just out of stock — say that, not that we don't carry it. " +
            "Then offer ONE or TWO of the alternatives by name with their price. Only offer what is " +
            "in the alternatives list. Do not promise a restock date."
          : "We DO sell this, it is just out of stock — say that, not that we don't carry it. " +
            "Nothing comparable is in stock either, so offer to log a ticket so someone can follow up. " +
            "Do not promise a restock date.",
    };
  }

  return {
    found: true,
    match_count: products.length,
    total_matches: Number(r.total_matches ?? products.length),
    stock_known: stockKnown,
    products,
    message: stockLine,
  };
}
