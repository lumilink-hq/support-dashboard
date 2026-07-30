// =============================================================================
// lib.ts — pure, side-effect-free helpers for the voice-order-lookup function.
// Kept separate from index.ts (the Deno/Supabase wiring) so they can be unit
// tested in plain Node/tsx without a running Supabase or Deno. No imports.
//
// Covers both store platforms. The whole point of this file is that WooCommerce
// and Shopify responses collapse into ONE normalized shape, so everything
// downstream (orders_cache -> evaluate_flag -> the agent's spoken answer) is
// platform-agnostic.
//
// The Shopify half is deliberately ALIGNED WITH THE PRODUCTION EMAIL ZAP
// (the "Tsunami order lookup" code step). Both channels upsert the same
// orders_cache row on (client_id, order_number), so a field-shape difference
// between them would mean the two channels silently overwrite each other with
// incompatible data. Where this file intentionally differs, the comment says so.
// =============================================================================

export type LineItemLite = { name?: string; quantity?: number; price?: number };

// The normalized order — mirrors the orders_cache column set.
export type NormalizedOrder = {
  store_status: string | null;
  customer_name: string | null;
  customer_email: string | null;
  currency: string | null;
  order_total: number | null;
  order_placed_at: string | null;
  line_items: LineItemLite[];
  tracking_number: string | null;
  carrier: string | null;
  shipping_status: string | null;
  shipped_at: string | null;
  estimated_delivery: string | null;
  raw_store: Record<string, unknown>;
  raw_shipping: Record<string, unknown>;
};

// -----------------------------------------------------------------------------
// Tenant routing — phone vs web
// -----------------------------------------------------------------------------

export type ClientRef = {
  calledNumber: string | null; // phone: the dialed number
  clientSlug: string | null; // web: the tenant slug
  conversationRef: string | null; // Twilio call SID, or the ElevenLabs conversation id
};

/**
 * ElevenLabs sends EVERY configured tool parameter on every call, filling the
 * ones that don't apply with an EMPTY STRING rather than omitting them. A phone
 * call arrives as {called_number: "+1…", client_ref: ""} and a browser call as
 * {called_number: "", client_ref: "shopify-store"}. Treating "" as a present
 * value is the classic way this breaks — it routes a web call down the phone
 * path and 400s. Same normalization the scheduling function already does.
 */
export function extractClientRef(body: unknown): ClientRef {
  const b = (body ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = b[k];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
      if (typeof v === "number") return String(v);
    }
    return null;
  };
  return {
    calledNumber: pick("called_number", "system__called_number"),
    clientSlug: pick("client_ref", "client_slug"),
    // A browser call has no Twilio SID; ElevenLabs' conversation id is the
    // stable per-session ref in that case.
    conversationRef: pick("call_sid", "conversation_id", "system__conversation_id"),
  };
}

// -----------------------------------------------------------------------------
// Order numbers over the phone
// -----------------------------------------------------------------------------

/**
 * Normalize whatever the LLM heard into a bare order number.
 *
 * Callers say "order number pound ten oh one" and the model hands us anything
 * from "#1001" to " 1001 " to "Order #1001". Shopify's search syntax treats
 * "#" as significant, so a stray hash silently returns zero results — which the
 * agent would then read out as "I couldn't find that order." Strip it here,
 * once, rather than trusting the prompt.
 *
 * Preserves internal dashes/letters: Shopify names like "1001-A" or "TS1001"
 * are legitimate.
 */
export function normalizeOrderNumber(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Drop a leading "order"/"number"/"#" preamble. Loop, because callers stack
  // them: "order number 1001", "order #1001".
  const PREAMBLE = /^\s*(orders?|numbers?|no\.?|#)\s*/i;
  while (PREAMBLE.test(s)) {
    const next = s.replace(PREAMBLE, "");
    if (next === s) break; // defensive: never spin on a zero-width match
    s = next;
  }
  const cleaned = s.replace(/[^A-Za-z0-9\-]/g, "");
  return cleaned || null;
}

/** Shopify order names are stored with a leading "#". Compare without it. */
export function stripHash(name: unknown): string {
  return String(name ?? "").trim().replace(/^#/, "");
}

/**
 * Forms of an order number worth trying, in order of preference.
 *
 * WHY THIS EXISTS: callers say a prefix the store doesn't store. Tsunami's
 * customers read "TSU#1749" off their confirmation, but Shopify names that order
 * "#1749" — proved by orders_cache, which is keyed on the store's own canonical
 * name and contains bare digits (1491, 1699, 1749).
 *
 * normalizeOrderNumber("TSU#1749") yields "TSU1749" (the "#" is punctuation, the
 * letters are not), which matches nothing. So after the literal form we also try
 * digits-only.
 *
 * Safe because pickExactOrder still demands an exact match against the store's
 * real name — a second candidate widens what we ASK Shopify, never what we
 * accept as a hit. Only fires when the caller's value actually contains letters,
 * so a plain "1749" costs no extra request.
 */
export function orderNumberCandidates(orderNumber: string): string[] {
  const first = String(orderNumber ?? "").trim();
  if (!first) return [];
  const out = [first];
  const digits = first.replace(/[^0-9]/g, "");
  if (digits && digits !== first && /[A-Za-z]/.test(first)) out.push(digits);
  return [...new Set(out)];
}

/**
 * Comparison key for order names: alphanumerics only, lowercased.
 *
 * stripHash alone is not enough once a store sets an order-name PREFIX. Tsunami's
 * orders are named "TSU#1749"; stripHash only removes a *leading* "#", so it
 * returns "TSU#1749" unchanged, while normalizeOrderNumber turns what the caller
 * said into "TSU1749". Those never compare equal and the real order gets thrown
 * away as a near-miss.
 *
 * This stays strict about the parts that matter — "#1001-A" keys to "1001a" and
 * still will not match "1001" — so the guard against Shopify's token search
 * returning a neighbouring order is preserved.
 */
export function orderKey(value: unknown): string {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

/**
 * Shopify's `query` arg for the orders connection.
 *
 * With a prefix configured we must search the store's REAL name ("TSU#1749"),
 * quoted so the "#" survives as part of the term. Callers rarely say the prefix
 * out loud — they say "seventeen forty-nine" — so we re-attach it here rather
 * than depending on the caller to produce it.
 *
 * Without a prefix this is byte-identical to the previous behaviour.
 */
export function buildShopifySearchQuery(
  orderNumber: string,
  prefix?: string | null,
): string {
  const p = (prefix ?? "").trim();
  if (!p) return `name:${orderNumber}`;
  // Don't double-apply when the caller already included the prefix.
  const bare = orderKey(orderNumber).startsWith(orderKey(p))
    ? orderNumber.slice(
        // Strip however many characters of the raw string correspond to the
        // prefix's alphanumerics, tolerating punctuation the caller dropped.
        matchedPrefixLength(orderNumber, p),
      )
    : orderNumber;
  return `name:"${p}${bare}"`;
}

/** How many leading chars of `raw` correspond to `prefix`, ignoring punctuation. */
function matchedPrefixLength(raw: string, prefix: string): number {
  const wanted = orderKey(prefix);
  let seen = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/[A-Za-z0-9]/.test(ch)) seen += ch.toLowerCase();
    if (seen === wanted) return i + 1;
    if (!wanted.startsWith(seen)) return 0;
  }
  return 0;
}

/**
 * `name:1001` is a token match, not an exact one — it can also return "1001-A".
 * Pick the exact match if there is one; otherwise treat it as not-found rather
 * than reading a stranger's order down the phone.
 *
 * DIFFERS FROM THE ZAP (which takes edges[0] of first:1) — deliberate. Worth
 * backporting to the email Zap.
 */
export function pickExactOrder<T extends { name?: string }>(
  nodes: T[],
  orderNumber: string,
  prefix?: string | null,
): T | null {
  if (!nodes.length) return null;
  const want = orderKey(orderNumber);
  const p = orderKey(prefix ?? "");
  // Accept the caller's digits with OR without the store's prefix: they say
  // "seventeen forty-nine", the store calls it "TSU#1749", and both must match.
  const wantPrefixed = p && !want.startsWith(p) ? p + want : want;
  return (
    nodes.find((n) => {
      const got = orderKey(n.name);
      return got === want || got === wantPrefixed;
    }) ?? null
  );
}

// -----------------------------------------------------------------------------
// Status normalization
// -----------------------------------------------------------------------------

/**
 * The exact token set the email Zap clamps to. `evaluate_flag` does a JSONB
 * membership test against clients.abnormal_status_rules.abnormal_statuses, so a
 * token outside this set silently never flags.
 */
export const ALLOWED_STATUSES: ReadonlySet<string> = new Set([
  "PENDING", "AUTHORIZED", "PARTIALLY_PAID", "PAID", "PARTIALLY_REFUNDED",
  "REFUNDED", "VOIDED", "UNFULFILLED", "PARTIALLY_FULFILLED", "FULFILLED",
  "RESTOCKED", "ON_HOLD", "SCHEDULED", "IN_PROGRESS", "OPEN",
]);

const FINANCIAL_OVERRIDE = new Set(["REFUNDED", "VOIDED", "PARTIALLY_REFUNDED"]);
// A fulfillment-level problem outranks a routine fulfillment status.
const FULFILLMENT_PROBLEM = new Set(["ON_HOLD", "RESTOCKED"]);

const up = (v: unknown): string => String(v ?? "").toUpperCase().trim();

/**
 * Collapse Shopify's several status signals into ONE support-relevant token.
 *
 * The email Zap does this with a Gemini call plus a deterministic fallback. We
 * do NOT call an LLM here: this runs mid-call, where every added round trip is
 * dead air on the line, and the rule is fully expressible in code. The
 * precedence below is exactly what that Zap's prompt asks the model for —
 * "prefer a refund/void/hold/restock signal over a routine fulfillment signal
 * when both apply" — so voice and email agree without voice paying the latency.
 */
export function normalizeStatus(
  financial: unknown,
  fulfillment: unknown,
  fulfillments?: ShopifyFulfillment[] | null,
): string | null {
  const fin = up(financial);
  const ful = up(fulfillment);

  // 1. Money-side problems outrank everything.
  if (FINANCIAL_OVERRIDE.has(fin)) return fin;

  // 2. A fulfillment sitting on hold or restocked is a problem the routine
  //    displayFulfillmentStatus can hide.
  for (const f of Array.isArray(fulfillments) ? fulfillments : []) {
    const s = up(f?.status);
    const d = up(f?.displayStatus);
    if (FULFILLMENT_PROBLEM.has(s)) return s;
    if (FULFILLMENT_PROBLEM.has(d)) return d;
  }

  // 3. Routine fulfillment status, then financial, clamped to the allowed set.
  if (ful && ALLOWED_STATUSES.has(ful)) return ful;
  if (fin && ALLOWED_STATUSES.has(fin)) return fin;
  return ful || fin || null;
}

/** Back-compat alias — the deterministic two-enum collapse on its own. */
export function shopifyDisplayStatus(
  financial: string | null | undefined,
  fulfillment: string | null | undefined,
): string | null {
  return normalizeStatus(financial, fulfillment, null);
}

// -----------------------------------------------------------------------------
// Caller verification (required on the public web widget)
// -----------------------------------------------------------------------------

export type VerifyInput = { email?: string | null; zip?: string | null };
export type VerifyResult = { ok: boolean; reason: "ok" | "missing" | "mismatch" };

const normEmail = (v: unknown): string => String(v ?? "").trim().toLowerCase();
/** US ZIP+4 and "94110-1234" both reduce to the first 5 digits. */
const normZip = (v: unknown): string =>
  String(v ?? "").replace(/\D/g, "").slice(0, 5);

/**
 * Does the caller know something only the buyer would?
 *
 * On the phone there's caller ID and social friction. On a PUBLIC web widget an
 * order lookup is otherwise an unauthenticated API over the order book —
 * anyone can walk 1001, 1002, 1003 and read back names and contents. This is
 * the gate that stops that, so the web path must not return a single order
 * field until it passes.
 */
export function verifyCaller(
  node: Record<string, any> | null | undefined,
  input: VerifyInput,
): VerifyResult {
  const email = normEmail(input.email);
  const zip = normZip(input.zip);
  if (!email && !zip) return { ok: false, reason: "missing" };

  const orderEmails = [node?.customer?.email, node?.email].map(normEmail).filter(Boolean);
  const orderZips = [node?.shippingAddress?.zip, node?.billingAddress?.zip]
    .map(normZip)
    .filter(Boolean);

  if (email && orderEmails.includes(email)) return { ok: true, reason: "ok" };
  // A 5-digit ZIP is weak on its own but strong combined with knowing the order
  // number; it's the fallback for callers who bought as a guest.
  if (zip && zip.length === 5 && orderZips.includes(zip)) return { ok: true, reason: "ok" };
  return { ok: false, reason: "mismatch" };
}

// -----------------------------------------------------------------------------
// Shopify -> normalized
// -----------------------------------------------------------------------------

type ShopifyFulfillment = {
  status?: string | null;
  displayStatus?: string | null;
  createdAt?: string | null;
  estimatedDeliveryAt?: string | null;
  trackingInfo?: { number?: string | null; company?: string | null; url?: string | null }[];
};

/**
 * An order can have several fulfillments (split shipments). Prefer the most
 * recent one that actually carries a tracking number — that's the one the
 * caller is asking about.
 *
 * DIFFERS FROM THE ZAP (which takes fulfillments[0]) — deliberate: [0] returns
 * no tracking whenever the first fulfillment happens not to have any. Worth
 * backporting.
 */
export function pickFulfillment(
  fulfillments: ShopifyFulfillment[] | null | undefined,
): ShopifyFulfillment | null {
  const list = Array.isArray(fulfillments) ? fulfillments : [];
  if (!list.length) return null;
  const withTracking = list.filter(
    (f) => Array.isArray(f.trackingInfo) && f.trackingInfo.some((t) => t?.number),
  );
  const pool = withTracking.length ? withTracking : list;
  return [...pool].sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  })[0] ?? null;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function mapShopifyOrder(node: Record<string, any>): NormalizedOrder {
  const fulfillment = pickFulfillment(node.fulfillments);
  const tracking = Array.isArray(fulfillment?.trackingInfo)
    ? fulfillment!.trackingInfo!.find((t) => t?.number) ?? null
    : null;

  const money =
    node.currentTotalPriceSet?.shopMoney ?? node.totalPriceSet?.shopMoney ?? null;

  // Zap-aligned line item shape: {name, quantity, price} from `title` +
  // originalUnitPriceSet. Both channels write this same array.
  const lineItems: LineItemLite[] = Array.isArray(node.lineItems?.edges)
    ? node.lineItems.edges
        .map((e: any) => e?.node)
        .filter(Boolean)
        .map((n: any) => ({
          name: n.title ?? n.name,
          quantity: n.quantity,
          price: parseFloat(n.originalUnitPriceSet?.shopMoney?.amount) || 0,
        }))
    : [];

  const customerName =
    [node.customer?.firstName, node.customer?.lastName].filter(Boolean).join(" ") ||
    [node.shippingAddress?.firstName, node.shippingAddress?.lastName]
      .filter(Boolean)
      .join(" ") ||
    null;

  return {
    store_status: normalizeStatus(
      node.displayFinancialStatus,
      node.displayFulfillmentStatus,
      node.fulfillments,
    ),
    customer_name: customerName,
    // Zap precedence: customer.email first, then the order-level email.
    customer_email: node.customer?.email ?? node.email ?? null,
    currency: money?.currencyCode ?? "USD",
    order_total: parseFloat(money?.amount) || 0,
    order_placed_at: toIso(node.createdAt),
    line_items: lineItems,
    tracking_number: tracking?.number ?? null,
    carrier: tracking?.company ?? null,
    // Zap-aligned: the fulfillment's own `status`, not displayStatus.
    shipping_status: fulfillment?.status ?? null,
    shipped_at: toIso(fulfillment?.createdAt),
    estimated_delivery: toIso(fulfillment?.estimatedDeliveryAt),
    raw_store: node,
    // The Zap stores {} here; we keep the chosen fulfillment because it's the
    // only record of WHICH shipment a spoken answer came from.
    raw_shipping: (fulfillment as Record<string, unknown>) ?? {},
  };
}

// -----------------------------------------------------------------------------
// WooCommerce -> normalized
// -----------------------------------------------------------------------------

export function mapWooOrder(
  o: Record<string, any>,
  tracking: Record<string, any> | null,
): NormalizedOrder {
  const lineItems: LineItemLite[] = Array.isArray(o.line_items)
    ? o.line_items.map((li: any) => ({ name: li.name, quantity: li.quantity }))
    : [];

  return {
    store_status: o.status ?? null,
    customer_name:
      [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(" ") || null,
    customer_email: o.billing?.email ?? null,
    currency: o.currency ?? null,
    order_total: o.total ? Number(o.total) : null,
    order_placed_at: toIso(o.date_created),
    line_items: lineItems,
    tracking_number: tracking?.trackingNumber ?? null,
    carrier: tracking?.carrierCode ?? null,
    shipping_status: tracking?.shipmentStatus ?? null,
    shipped_at: toIso(tracking?.shipDate),
    estimated_delivery: null,
    raw_store: o,
    raw_shipping: tracking ?? {},
  };
}

// -----------------------------------------------------------------------------
// Credentials
// -----------------------------------------------------------------------------

/** Vault secrets are stored as JSON strings. A malformed one must not throw. */
export function parseCreds<T extends Record<string, unknown>>(
  raw: unknown,
): Partial<T> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
}

export function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

export type ShopifyCreds = { access_token?: string; base_url?: string };

/**
 * Resolve Shopify credentials out of get_client_integration_secrets.
 *
 * GOTCHA: that RPC (migration 0002) predates Shopify support. It reads
 * `clients.store_credentials_ref` — the generic store credential — but returns
 * it under the JSON key **"woocommerce"** whatever the platform. So a Shopify
 * token arrives at `secrets.woocommerce`, not `secrets.shopify`. Accept all
 * three names so this works on the CURRENT database with no migration.
 */
export function pickShopifyCreds(
  secrets: Record<string, unknown> | null | undefined,
): ShopifyCreds {
  if (!secrets) return {};
  const raw = secrets.shopify ?? secrets.store ?? secrets.woocommerce;
  return parseCreds<ShopifyCreds>(raw);
}

/**
 * Shopify GraphQL answers 200 even for query errors, and signals rate limiting
 * inside the body. Anything here means "don't trust the payload" — the caller
 * escalates rather than guessing, per the never-fabricate rule.
 */
export function shopifyErrorFrom(body: Record<string, any> | null): string | null {
  if (!body) return "empty response";
  if (Array.isArray(body.errors) && body.errors.length) {
    const codes = body.errors
      .map((e: any) => e?.extensions?.code ?? e?.message)
      .filter(Boolean);
    return codes.length ? String(codes.join(", ")) : "graphql error";
  }
  return null;
}

/**
 * Pinned to match the production email Zap. Both channels hit the same store
 * and write the same orders_cache row, so they must not drift across API
 * versions. Bump them together, never one alone.
 */
export const SHOPIFY_API_VERSION = "2026-04";

export function shopifyGraphqlUrl(baseUrl: string): string {
  return `${stripTrailingSlash(baseUrl)}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
}

/**
 * The order query. Field-for-field the Zap's, plus:
 *   - first: 5 (not 1) so pickExactOrder can reject a token-match near-miss
 *   - shippingAddress.zip / billingAddress.zip for caller verification
 *   - fulfillments.displayStatus alongside status, for normalizeStatus
 */
export const SHOPIFY_ORDER_QUERY = `
query VoiceOrderLookup($q: String!) {
  orders(first: 5, query: $q) {
    edges {
      node {
        name
        createdAt
        email
        displayFinancialStatus
        displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        customer { firstName lastName email }
        shippingAddress { firstName lastName zip city province }
        billingAddress { zip }
        lineItems(first: 50) {
          edges { node { title quantity originalUnitPriceSet { shopMoney { amount } } } }
        }
        fulfillments(first: 5) {
          status
          displayStatus
          createdAt
          estimatedDeliveryAt
          trackingInfo { number company url }
        }
      }
    }
  }
}`.trim();

/**
 * Shop legal policies — refund, shipping, privacy, terms. Run this ONCE per
 * store (see scripts/fetch-shopify-policies.mjs), condense the result, and save
 * it to clients.settings.policies. Do NOT call it per conversation: the bodies
 * are full HTML pages, far too long for a voice system prompt, and they change
 * a few times a year at most.
 */
export const SHOPIFY_POLICIES_QUERY = `
query ShopPolicies {
  shop {
    name
    shopPolicies { type title body url }
  }
}`.trim();
