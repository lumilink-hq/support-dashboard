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
 * WHY THIS EXISTS: the caller's value and the store's name can disagree in
 * either direction, and which one is which is a per-client fact.
 *
 * CORRECTION (2026-08-12). This used to state that Tsunami's Shopify names
 * orders "#1749" and that "TSU#" exists only on the confirmation email, citing
 * bare-digit rows in orders_cache. That is wrong. A direct Admin API query
 * (`name:1833`) returns `"name":"TSU#1833"` — the store's own name CARRIES the
 * prefix. The bare-digit orders_cache rows are unexplained and should be
 * treated as suspect, not as evidence: if the canonical names really are
 * prefixed, those rows are keyed wrong, and per index.ts §4b a mis-keyed
 * orders_cache row silently breaks both the dashboard's order panel and the
 * post-call escalation path.
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
 * The Shopify `query` strings worth trying, in order.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT JUST buildShopifySearchQuery:
 *
 * `order_number_prefix` was built for a store whose orders are NAMED with a
 * prefix ("TSU#1749"). Tsunami IS one — verified 2026-08-12, see
 * orderNumberCandidates above; an earlier version of this comment claimed the
 * opposite and it was wrong.
 *
 * Trying both shapes is kept regardless, because the failure it prevents is
 * symmetric: re-attaching a prefix to a store that doesn't use one asks for a
 * name that does not exist, and so does omitting one from a store that does.
 * Neither costs more than a single wasted request on a miss.
 *
 * The old flow could not recover from that: orderNumberCandidates only adds a
 * second candidate when the caller's value contains LETTERS, so a bare-digit
 * caller got exactly one query and one chance.
 *
 * So when a prefix is configured we now try BOTH shapes — prefixed first (it is
 * the more specific, and it is what the setting asks for), then bare. Which one
 * the store actually uses stops mattering, and a misconfigured prefix degrades
 * into one wasted request instead of a failed call.
 *
 * This only widens what we ASK Shopify. pickExactOrder still requires an exact
 * match against the store's real name, and it already accepts the caller's
 * digits with or without the prefix, so nothing here loosens the guard against
 * reading out a neighbouring order.
 */
export function shopifyOrderQueries(
  orderNumber: string,
  prefix?: string | null,
): string[] {
  const n = String(orderNumber ?? "").trim();
  if (!n) return [];

  const p = (prefix ?? "").trim();
  if (!p) return [buildShopifySearchQuery(n)];

  const bare = n.slice(matchedPrefixLength(n, p)) || n;
  return [...new Set([
    buildShopifySearchQuery(n, p), // name:"TSU#1756"
    `name:${bare}`,                // name:1756
  ])];
}

// -----------------------------------------------------------------------------
// Running out of time on the call
// -----------------------------------------------------------------------------

export type TimeCheck = {
  /** Seconds left before the hard cut. Null when we can't tell. */
  remaining: number | null;
  /** Start steering toward a close. */
  windDown: boolean;
  /** Answer this one thing, say goodbye, hang up. */
  finalCall: boolean;
};

/**
 * How close is this call to its hard duration limit?
 *
 * WHY THIS EXISTS: ElevenLabs enforces max call duration by TERMINATING the
 * call. There is no warning, no grace, and no goodbye — it stops mid-sentence,
 * which sounds exactly like the line dropping. A caller who has just given their
 * order number and hears silence assumes the company hung up on them.
 *
 * The existing `wrap_up` signal only covers a tenant crossing their MONTHLY cap.
 * Nothing knew about the per-call ceiling, so every call that ran long ended
 * badly by design.
 *
 * ElevenLabs exposes `system__call_duration_secs` as a system dynamic variable,
 * so the agent can pass elapsed time on every tool call and we can hand back how
 * long is left. Two thresholds rather than one, because "you have 45 seconds"
 * and "you have 10 seconds" call for different behaviour: the first means stop
 * opening new topics, the second means say goodbye now.
 *
 * Returns all-null/false when elapsed or the cap is unknown — an unknown clock
 * must never make the agent rush a call that has plenty of time left.
 */
export function checkCallTime(
  elapsedSecs: unknown,
  maxCallSecs: unknown,
  opts: { windDownAt?: number; finalCallAt?: number } = {},
): TimeCheck {
  const elapsed = Number(elapsedSecs);
  const max = Number(maxCallSecs);
  if (
    !Number.isFinite(elapsed) || elapsed < 0 ||
    !Number.isFinite(max) || max <= 0
  ) {
    return { remaining: null, windDown: false, finalCall: false };
  }

  const remaining = Math.max(Math.round(max - elapsed), 0);

  // Proportional, but CLAMPED at both ends.
  //
  // Pure percentages break in both directions: 10% of a 2-minute call is 12
  // seconds, which is not enough runway to close gracefully, while 25% of a
  // 10-minute call is two and a half minutes of the agent nagging about time
  // when there is plenty. Wrapping up takes roughly the same wall-clock effort
  // regardless of how long the call has been — a sentence and a goodbye — so
  // the window is bounded in seconds, not just scaled.
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), hi);
  const windDownAt = opts.windDownAt ?? clamp(Math.round(max * 0.25), 20, 45);
  const finalCallAt = opts.finalCallAt ?? clamp(Math.round(max * 0.10), 10, 15);

  return {
    remaining,
    windDown: remaining <= windDownAt,
    finalCall: remaining <= finalCallAt,
  };
}

/** The instruction appended to a tool response when the clock is running down. */
export function timeNotice(t: TimeCheck): string | null {
  if (t.remaining === null) return null;
  if (t.finalCall) {
    return `Only about ${t.remaining} seconds remain before this call ends automatically. ` +
      `Answer in ONE short sentence, tell the caller you have to let them go and how to reach the team, then end the call yourself. ` +
      `Do NOT let it cut off mid-sentence.`;
  }
  if (t.windDown) {
    return `About ${t.remaining} seconds remain on this call. Start steering toward a close: ` +
      `finish the current question, do not open a new topic, and offer a callback or email if more is needed.`;
  }
  return null;
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
 * The store prefixes its order names and NOBODY TOLD US — pick the one order
 * that differs from what the caller said by a leading run of letters.
 *
 * WHY THIS EXISTS (2026-08-12). `order_number_prefix` was set correctly on the
 * client row, and the store really does name orders "TSU#1833", and Shopify
 * really did return that order for `name:1833` — and the caller was still told
 * it didn't exist. The prefix never reached this function: migration 0029
 * rewrote get_client_config's jsonb_build_object and dropped the
 * order_number_prefix key, so `config?.order_number_prefix` came back undefined
 * on a correctly-configured client. With no prefix to widen by, the exact-match
 * guard rejected the very order the store had just handed over.
 *
 * The lesson is not "restore the key" (that is migration 0035) — it is that a
 * config gap should degrade into a slower lookup, never into a confidently
 * wrong "no such order". So the prefix is now an OPTIMIZATION (it targets the
 * query and matches first) rather than a correctness dependency.
 *
 * Three conditions keep this from becoming the stranger's-order bug it is
 * guarding against:
 *   1. the caller's value is ALL DIGITS — if they spelled out letters, they can
 *      match exactly;
 *   2. the leading remainder is PURELY ALPHABETIC, so "1833" never matches
 *      "21833" or "11833" — only a real word-prefix like "TSU#";
 *   3. EXACTLY ONE node qualifies. A store with both "A#1833" and "B#1833" is
 *      ambiguous, and ambiguous means not-found.
 *
 * Suffixes are still never tolerated: orderKey("#1001-A") is "1001a", which
 * does not END WITH "1001", so the original "1001-A" trap stays shut.
 */
function matchesIgnoringStorePrefix(nodeKey: string, want: string): boolean {
  if (!/^[0-9]+$/.test(want)) return false;
  if (nodeKey.length <= want.length || !nodeKey.endsWith(want)) return false;
  return /^[a-z]+$/.test(nodeKey.slice(0, nodeKey.length - want.length));
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

  // Accept the caller's digits with OR without the store's prefix, in BOTH
  // directions. Only adding the prefixed form was a half-fix: it handled a
  // caller saying "1756" against a store naming it "TSU#1756", but not a caller
  // saying "TSU1756" against a store naming it "#1756" — which is the shape
  // Tsunami actually uses, since "TSU#" appears on the confirmation email and
  // nowhere in Shopify. Widening by exactly the configured prefix keeps the
  // guard against neighbouring orders intact ("1001-A" still never matches
  // "1001").
  const wanted = new Set([want]);
  if (p) {
    if (want.startsWith(p)) wanted.add(want.slice(p.length));
    else wanted.add(p + want);
  }

  const exact = nodes.find((n) => wanted.has(orderKey(n.name)));
  if (exact) return exact;

  // Nothing matched on the configured prefix — which includes the case where
  // there ISN'T one because the config never arrived. See
  // matchesIgnoringStorePrefix: one unambiguous alphabetic-prefixed candidate
  // is the order; two are not.
  const prefixed = nodes.filter((n) =>
    matchesIgnoringStorePrefix(orderKey(n.name), want)
  );
  return prefixed.length === 1 ? prefixed[0] : null;
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

/**
 * WooCommerce's order status vocabulary, mapped onto the SAME token set the
 * Shopify path produces.
 *
 * THIS IS LOAD-BEARING, and it was the single biggest Woo/Shopify divergence.
 * `evaluate_flag` does a JSONB membership test of the stored status against
 * `abnormal_status_rules.abnormal_statuses`, and `0013` matches
 * `stale_exempt_statuses` (documented with values like 'FULFILLED') the same
 * way. Both are written in the UPPERCASE Shopify vocabulary. Passing Woo's raw
 * lowercase `processing` / `on-hold` straight through means:
 *
 *   - no abnormal-status rule can ever match, so a Woo order that IS abnormal
 *     never flags and never escalates; and
 *   - no staleness exemption can ever match, so every completed Woo order older
 *     than stale_after_hours flags as `order_over_24h` and the agent escalates a
 *     perfectly healthy "where is my order" call.
 *
 * Mapping here means one rule set works for a client on either platform.
 * The untouched Woo value is still recoverable from `raw_store.status`.
 */
export const WOO_STATUS_MAP: Readonly<Record<string, string>> = {
  pending: "PENDING", // awaiting payment
  "checkout-draft": "PENDING",
  processing: "IN_PROGRESS", // paid, being picked/packed
  "on-hold": "ON_HOLD",
  completed: "FULFILLED",
  cancelled: "VOIDED",
  canceled: "VOIDED", // Woo uses the British spelling; be forgiving
  failed: "VOIDED",
  refunded: "REFUNDED",
  trash: "VOIDED",
};

/**
 * Map a Woo status into ALLOWED_STATUSES. An unrecognized status (Woo lets
 * plugins register custom ones, e.g. `wc-awaiting-shipment`) returns null rather
 * than an invented token: null is honest and merely fails to match a rule, while
 * a wrong token could match the WRONG rule and escalate the wrong calls.
 */
export function normalizeWooStatus(status: unknown): string | null {
  const raw = String(status ?? "").trim().toLowerCase();
  if (!raw) return null;
  // Woo's REST API returns bare statuses, but the DB and some plugins use the
  // `wc-` prefix. Accept both.
  const key = raw.startsWith("wc-") ? raw.slice(3) : raw;
  const mapped = WOO_STATUS_MAP[key];
  if (mapped && ALLOWED_STATUSES.has(mapped)) return mapped;
  // A custom status that happens to already be a valid token (rare) is kept.
  const upper = key.toUpperCase().replace(/-/g, "_");
  return ALLOWED_STATUSES.has(upper) ? upper : null;
}

/**
 * Build the WooCommerce REST URL for an order lookup.
 *
 * WHY SCHEMES EXIST: `/orders/{id}` takes Woo's INTERNAL post id, which is not
 * what the customer sees whenever a sequential-order-number plugin is installed
 * (very common). The production email Zap already supports three schemes; the
 * voice path only ever implemented `id`, so on any such store every voice
 * lookup 404s while the same order resolves fine over email.
 *
 *   'id'          -> /orders/{n}                     (default; internal post id)
 *   'search'      -> /orders?search={n}              (customer-facing number)
 *   'meta:<key>'  -> /orders?meta_key=<key>&meta_value={n}
 *
 * The array-returning schemes are why the caller must handle both a bare object
 * and a list — see `pickWooOrder`.
 */
export function wooOrderUrl(
  baseUrl: string,
  orderNumber: string,
  scheme?: string | null,
): { url: string; returnsList: boolean } {
  const base = stripTrailingSlash(baseUrl);
  const s = String(scheme ?? "id").trim() || "id";
  const n = encodeURIComponent(orderNumber);

  if (s.startsWith("meta:")) {
    const metaKey = s.slice(5);
    return {
      url: `${base}/wp-json/wc/v3/orders?meta_key=${encodeURIComponent(metaKey)}&meta_value=${n}`,
      returnsList: true,
    };
  }
  if (s === "search") {
    return { url: `${base}/wp-json/wc/v3/orders?search=${n}`, returnsList: true };
  }
  return { url: `${base}/wp-json/wc/v3/orders/${n}`, returnsList: false };
}

/**
 * Choose the right order from a Woo response.
 *
 * The `search` scheme is a full-text match over the whole order — it will
 * happily return order 1002 when asked for 1001 because "1001" appears in a
 * customer note. This mirrors `pickExactOrder` on the Shopify side: prefer an
 * exact match on the customer-facing `number` (or `id`), and only fall back to
 * the sole result when there is exactly one and it was an id-style fetch.
 */
export function pickWooOrder(
  payload: unknown,
  orderNumber: string,
  prefix?: string | null,
): Record<string, any> | null {
  const list: Record<string, any>[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? [payload as Record<string, any>]
      : [];
  if (!list.length) return null;

  // Accept the caller's value with OR without the store's prefix, in either
  // direction: the caller may read "TSU#1749" off a confirmation while Woo
  // stores "1749", or the reverse. The prefix is a per-client constant, so
  // widening by exactly it does not loosen the exact-match guarantee.
  const want = orderKey(orderNumber);
  const p = orderKey(prefix ?? "");
  const wanted = new Set([want]);
  if (p) {
    if (want.startsWith(p)) wanted.add(want.slice(p.length));
    else wanted.add(p + want);
  }

  const exact = list.find((o) => {
    const candidates = [o?.number, o?.id].map(orderKey).filter(Boolean);
    return candidates.some((c) => wanted.has(c));
  });
  if (exact) return exact;

  // Same unconfigured-prefix fallback as the Shopify side. Woo lost its config
  // key to the same migration (order_number_scheme, dropped by 0029), so this
  // branch is not hypothetical here either.
  const prefixed = list.filter((o) =>
    [o?.number, o?.id]
      .map(orderKey)
      .filter(Boolean)
      .some((c) => matchesIgnoringStorePrefix(c, want))
  );
  if (prefixed.length === 1) return prefixed[0];

  // A single result from a direct /orders/{id} fetch IS the order — Woo resolved
  // the id for us, so there is nothing to disambiguate.
  if (!Array.isArray(payload) && list.length === 1) return list[0];
  return null;
}

type ShipStationShipment = {
  voided?: boolean;
  createDate?: string | null;
  trackingNumber?: string | null;
  carrierCode?: string | null;
  shipmentStatus?: string | null;
  shipDate?: string | null;
};

/**
 * Pick the shipment a caller is actually asking about.
 *
 * TWO BUGS THIS FIXES, both of which the production Zap already got right:
 *   1. VOIDED LABELS. A label that was printed and then cancelled stays in the
 *      ShipStation response. Taking `shipments[0]` blindly means the agent can
 *      read out a tracking number for a label that will never move.
 *   2. ORDERING. The response is not sorted, so `[0]` is arbitrary. On a split
 *      shipment the caller wants the most recent one that actually has tracking.
 *
 * Mirrors `pickFulfillment` on the Shopify side deliberately — the two platforms
 * should answer "which shipment?" the same way.
 */
export function pickShipment(
  shipments: ShipStationShipment[] | null | undefined,
): ShipStationShipment | null {
  const list = (Array.isArray(shipments) ? shipments : []).filter(
    (s) => s && !s.voided,
  );
  if (!list.length) return null;
  const withTracking = list.filter((s) => s.trackingNumber);
  const pool = withTracking.length ? withTracking : list;
  return [...pool].sort((a, b) => {
    const ta = a.createDate ? Date.parse(a.createDate) : 0;
    const tb = b.createDate ? Date.parse(b.createDate) : 0;
    return tb - ta;
  })[0] ?? null;
}

/**
 * Which number to hand ShipStation.
 *
 * ShipStation stores the CUSTOMER-FACING order number (Woo's `number`), not
 * Woo's internal post id. Under the default `id` scheme the voice function was
 * querying ShipStation with the post id, so on any store where those differ
 * (i.e. any store with a sequential-order-number plugin) tracking silently came
 * back empty and every WISMO call answered "no tracking yet". The Zap has always
 * used `order.number` — this brings voice in line.
 */
export function shipStationOrderNumber(
  order: Record<string, any> | null | undefined,
  fallback: string,
): string {
  const n = order?.number;
  if (n !== null && n !== undefined && String(n).trim() !== "") {
    return String(n).trim();
  }
  return fallback;
}

export function mapWooOrder(
  o: Record<string, any>,
  tracking: Record<string, any> | null,
): NormalizedOrder {
  // Zap-aligned line item shape {name, quantity, price} — the Shopify path
  // writes `price`, and both platforms upsert the SAME orders_cache row, so
  // omitting it here meant a Woo lookup silently stripped prices off a row a
  // Shopify/email lookup had populated.
  const lineItems: LineItemLite[] = Array.isArray(o.line_items)
    ? o.line_items.map((li: any) => ({
        name: li.name,
        quantity: li.quantity,
        // Woo returns money as strings, and `total` is the LINE total while
        // Shopify's originalUnitPriceSet is the UNIT price. Divide so the two
        // platforms mean the same thing by `price`.
        price: wooUnitPrice(li),
      }))
    : [];

  const shipment = tracking as ShipStationShipment | null;

  return {
    // See normalizeWooStatus — raw Woo statuses can never match a flag rule.
    store_status: normalizeWooStatus(o.status),
    customer_name:
      [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(" ") || null,
    customer_email: o.billing?.email ?? null,
    // Zap-aligned defaults: 'USD' and 0, not null. A null currency renders as
    // "142 " with no unit when the agent speaks the total.
    currency: o.currency || "USD",
    order_total: parseFloat(o.total) || 0,
    // Woo's `date_created` is store-local with NO timezone; `date_created_gmt`
    // is UTC but omits the "Z", so Date.parse would read it as local time and
    // shift the order by the server's offset — which then feeds the staleness
    // clock in evaluate_flag and can flag a fresh order as 24h old.
    order_placed_at: toIso(
      o.date_created_gmt ? `${o.date_created_gmt}Z` : o.date_created,
    ),
    line_items: lineItems,
    tracking_number: shipment?.trackingNumber ?? null,
    carrier: shipment?.carrierCode ?? null,
    // ShipStation only reports shipmentStatus on some plans; a shipment that
    // carries a tracking number has, by definition, shipped.
    shipping_status:
      shipment?.shipmentStatus ?? (shipment?.trackingNumber ? "shipped" : null),
    shipped_at: toIso(shipment?.shipDate),
    // ShipStation V1 has no delivery estimate on the shipments endpoint.
    estimated_delivery: null,
    raw_store: o,
    raw_shipping: (shipment as Record<string, unknown>) ?? {},
  };
}

/** Woo line totals are strings and cover the whole line, not one unit. */
function wooUnitPrice(li: Record<string, any>): number {
  // `price` is already per-unit on modern Woo and is the most direct signal.
  const direct = parseFloat(li?.price);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const total = parseFloat(li?.total) || 0;
  const qty = Number(li?.quantity);
  return Number.isFinite(qty) && qty > 0 ? total / qty : total;
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

/**
 * Render an order's timestamp as a date the agent can SAY, in the store's own
 * timezone.
 *
 * WHY THIS EXISTS. order_placed_at is a UTC instant. Handing the raw ISO string
 * to the model means it reads the UTC calendar date, which is a different day
 * from the caller's for every evening order west of Greenwich. An order placed
 * at 18:00 on 31 July in Los Angeles is 2026-08-01T01:00:00Z, and the agent told
 * a caller it was placed on "August 1" the day they placed it. Nothing errors;
 * the agent is simply wrong, confidently, about the one fact the caller can
 * check.
 *
 * The model cannot fix this itself — nothing in the payload tells it which
 * timezone the store keeps — so the conversion happens here and the agent is
 * given a finished string.
 *
 * @param iso  UTC ISO timestamp, or null
 * @param tz   IANA name from get_client_config.timezone. Falls back to UTC.
 * @param now  Injectable clock, so "today"/"yesterday" are testable.
 */
export function formatPlacedOn(
  iso: string | null | undefined,
  tz: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  // An invalid tz must never throw inside a live call. Same posture as
  // client_timezone(), which validates against pg_timezone_names.
  const zone = (() => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz ?? "UTC" });
      return tz ?? "UTC";
    } catch {
      return "UTC";
    }
  })();

  // Compare CALENDAR DAYS in the store's zone, not elapsed hours. An order from
  // 23:50 last night is "yesterday" even though it is 40 minutes old.
  const dayKey = (x: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(x);

  const orderDay = dayKey(d);
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000));

  if (orderDay === today) return "today";
  if (orderDay === yesterday) return "yesterday";

  // Weekday included because "Thursday the 31st" is easier to place in memory
  // than a bare date when you are hearing it rather than reading it.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(d);
}
