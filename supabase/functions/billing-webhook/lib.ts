// =============================================================================
// billing-webhook/lib.ts — canonical event shape + the Stripe adapter's pure
// logic (signature verification and event parsing).
//
// Split from index.ts for the same reason voice-call-logger and
// voice-order-lookup are split: index.ts owns Deno.serve, env and the Supabase
// client, none of which a test can construct. Everything here is a pure
// function over strings, so scripts/test-billing-webhook.ts can exercise the
// signature check and every event mapping without a network, a database, or a
// Stripe account.
//
// This is money code and the failure modes are asymmetric: a rejected good
// event is a retry, an accepted forged event grants a paid plan to a stranger.
// When in doubt this file refuses.
// =============================================================================

export type Feature = "email" | "voice";

export type CanonicalType =
  | "subscription_activated"
  | "subscription_renewed"
  | "payment_failed"
  | "subscription_canceled"
  | "ignored";

export interface CanonicalEvent {
  externalEventId: string; // processor's unique event id (idempotency key)
  type: CanonicalType;
  clientId?: string | null; // from checkout metadata, if present
  feature?: Feature | null; // from metadata, else resolved via price map
  /** First price id found — kept for diagnostics and logging. */
  externalPriceId?: string | null;
  /**
   * EVERY price id on the event. An invoice carrying a one-time setup fee has
   * more than one line and the setup line can come first, so the price map has
   * to be searched against all of them, not just the first.
   */
  externalPriceIds?: string[];
  subscriptionRef?: string | null;
  currentPeriodEnd?: string | null; // ISO
  /**
   * Stripe's own test/live flag. Recorded so a diagnostic query can tell real
   * money from a test purchase — the two share one endpoint, one function and
   * one billing_events table, and without this the only way to tell them apart
   * is squinting at the account suffix buried in an event id.
   */
  livemode?: boolean | null;
}

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export interface WebhookSecretConfig {
  /** Per-processor secrets. Several per processor is normal — see below. */
  map: Record<string, string[]>;
  /** Bare secret(s), used for any processor with no explicit entry. */
  fallback: string[];
  /** Set when the value was meant to be JSON and wasn't. Never thrown. */
  configError: string | null;
}

/** Accepts "a", "a,b", or ["a","b"] and normalises to a clean string array. */
function toSecretList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : String(v ?? "").split(",");
  return raw
    .map((s) => String(s).trim())
    .filter((s) => s !== "");
}

/**
 * Read BILLING_WEBHOOK_SECRETS. Every form below works:
 *
 *   whsec_live                              one secret, any processor
 *   whsec_live,whsec_test                   several, any processor
 *   {"stripe":"whsec_live"}                 per-processor
 *   {"stripe":["whsec_live","whsec_test"]}  per-processor, several
 *
 * WHY SEVERAL PER PROCESSOR. Stripe's test and live modes are separate
 * endpoints with separate signing secrets, and both point at this one function.
 * Holding a single secret means enabling live silently breaks the test endpoint
 * — every test delivery starts returning 401 the moment you cut over, which
 * removes your ability to verify anything at exactly the moment you most want
 * it. Accepting a list lets both run side by side through the cutover, and
 * covers Stripe's own secret rotation for free.
 *
 * WHY BOTH SHAPES. Pasting the bare `whsec_…` Stripe shows you is the obvious
 * move; the map only matters with more than one processor. Accepting only the
 * map once turned a config typo into a dead function: JSON.parse threw during
 * module import, so every delivery 5xx'd before any handler ran and the log
 * said "Unexpected token 'w'" rather than anything about configuration.
 *
 * WHY IT NEVER THROWS. A bad value must not take the endpoint down. The problem
 * is recorded and reported per-request with an actionable message instead.
 */
export function parseWebhookSecrets(raw: string | undefined): WebhookSecretConfig {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { map: {}, fallback: [], configError: null };

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const map: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          map[k] = toSecretList(v);
        }
        return { map, fallback: [], configError: null };
      }
      return {
        map: {},
        fallback: [],
        configError: "BILLING_WEBHOOK_SECRETS parsed as JSON but is not an object.",
      };
    } catch {
      return {
        map: {},
        fallback: [],
        configError:
          "BILLING_WEBHOOK_SECRETS starts with '{' but is not valid JSON. " +
          'Use {"stripe":"whsec_..."} or just the bare whsec_... value.',
      };
    }
  }

  // Bare secret(s). Applied to whichever processor handles the request, so they
  // work regardless of ?processor= without anyone knowing the map shape.
  return { map: {}, fallback: toSecretList(trimmed), configError: null };
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

/** Length-independent constant-time compare of two hex strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  // Compare lengths without early-exiting on content. Different lengths can
  // never match, but we still walk the longer string so the timing profile
  // doesn't leak where the mismatch was.
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Unix seconds -> ISO string. Returns null for anything non-numeric. */
export function unixToIso(secs: unknown): string | null {
  const n = typeof secs === "string" ? Number(secs) : secs;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/** First defined, non-empty string in the list, else null. */
function firstString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Signature verification
//
// Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256 keyed on the endpoint
// secret (the whole "whsec_..." string, used verbatim), and sends it as:
//     Stripe-Signature: t=1614556800,v1=<hex>,v1=<hex>,v0=<legacy>
//
// Multiple v1 values appear while an endpoint secret is being rotated, so any
// one matching is a pass. v0 is a legacy scheme and is ignored.
//
// Hand-rolled on Web Crypto rather than pulling in npm:stripe: the SDK is a
// large dependency for one HMAC in an edge function, and the ElevenLabs
// webhooks in this repo already verify their signatures the same way.
// -----------------------------------------------------------------------------

export interface StripeSigHeader {
  timestamp: number | null;
  v1: string[];
}

export function parseStripeSignatureHeader(header: string | null): StripeSigHeader {
  const out: StripeSigHeader = { timestamp: null, v1: [] };
  if (!header) return out;

  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") {
      const n = Number(value);
      out.timestamp = Number.isFinite(n) ? n : null;
    } else if (key === "v1") {
      if (value) out.v1.push(value);
    }
  }
  return out;
}

export interface VerifyOptions {
  /** Reject signatures older than this. Stripe's own default is 300s. */
  toleranceSecs?: number;
  /** Unix seconds. Injectable so tests don't depend on the wall clock. */
  nowSecs?: number;
}

/**
 * True only when the signature is valid AND recent.
 *
 * The timestamp check is not ceremony: without it, anyone who captures one
 * valid webhook can replay it forever. `apply_billing_event` would dedupe an
 * identical event id, but a replayed `subscription_renewed` after a cancellation
 * is exactly the kind of thing that shouldn't reach the RPC at all.
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined,
  opts: VerifyOptions = {},
): Promise<boolean> {
  if (!secret) return false;

  const { timestamp, v1 } = parseStripeSignatureHeader(signatureHeader);
  if (timestamp === null || v1.length === 0) return false;

  const tolerance = opts.toleranceSecs ?? 300;
  const now = opts.nowSecs ?? Math.floor(Date.now() / 1000);
  // Guard both directions. A far-future timestamp is as suspicious as a stale
  // one and would otherwise sail through an `age > tolerance` check.
  if (Math.abs(now - timestamp) > tolerance) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${timestamp}.${rawBody}`),
  );
  const expected = toHex(mac);

  // Compare against every offered v1 (secret rotation sends more than one).
  // Deliberately no early return: check them all so timing doesn't reveal
  // which position matched.
  let matched = false;
  for (const candidate of v1) {
    if (timingSafeEqualHex(expected, candidate.toLowerCase())) matched = true;
  }
  return matched;
}

// -----------------------------------------------------------------------------
// Event parsing
// -----------------------------------------------------------------------------

const TYPE_MAP: Record<string, CanonicalType> = {
  "checkout.session.completed": "subscription_activated",
  "customer.subscription.created": "subscription_activated",
  "invoice.paid": "subscription_renewed",
  "invoice.payment_succeeded": "subscription_renewed",
  "invoice.payment_failed": "payment_failed",
  "customer.subscription.deleted": "subscription_canceled",
};

function asFeature(v: unknown): Feature | null {
  return v === "email" || v === "voice" ? v : null;
}

/**
 * Metadata can sit in several places depending on the object. A Payment Link
 * copies its metadata onto the subscription; invoices carry the subscription's
 * copy under `subscription_details`. Merge them, most specific last.
 */
function collectMetadata(obj: Record<string, any>): Record<string, unknown> {
  return {
    ...(obj?.subscription_details?.metadata ?? {}),
    ...(obj?.metadata ?? {}),
  };
}

/**
 * EVERY price id on the object, in the order found.
 *
 * WHY ALL OF THEM, not just the first. An invoice for a Payment Link that
 * carries a one-time setup fee has more than one line, and the setup line can
 * come first:
 *
 *   lines.data[0] -> price_…  $299 one-time setup   (NOT in billing_price_map)
 *   lines.data[1] -> price_…  $179/mo subscription  (the one that maps)
 *
 * Reading only lines.data[0] therefore resolved the SETUP price, found nothing
 * in the map, and parked a perfectly good renewal as 'unmapped'. Observed in
 * production: invoice.paid arriving with price_1TyfP1… (the $299) instead of
 * price_1TyfDd… (the $179).
 *
 * Stripe has also moved invoice line pricing between API versions, so each
 * known path is tried rather than assuming the account's version.
 */
export function extractPriceIds(obj: Record<string, any>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim() !== "" && !out.includes(v)) out.push(v);
  };

  // Subscription items first: on a subscription object these are the recurring
  // prices, which is what we actually want to match.
  for (const item of obj?.items?.data ?? []) {
    push(item?.price?.id);
    push(item?.plan?.id);
  }
  for (const line of obj?.lines?.data ?? []) {
    push(line?.price?.id);
    push(line?.pricing?.price_details?.price);
    push(line?.plan?.id);
  }
  push(obj?.price?.id);
  push(obj?.plan?.id);

  return out;
}

function extractSubscriptionRef(obj: Record<string, any>): string | null {
  return firstString(
    typeof obj?.subscription === "string" ? obj.subscription : null,
    obj?.subscription?.id,
    obj?.parent?.subscription_details?.subscription,
    // On a subscription object the id IS the subscription ref.
    obj?.object === "subscription" ? obj?.id : null,
  );
}

function extractPeriodEnd(obj: Record<string, any>): string | null {
  const item = obj?.items?.data?.[0];
  const line = obj?.lines?.data?.[0];
  return (
    unixToIso(obj?.current_period_end) ??
    unixToIso(item?.current_period_end) ??
    unixToIso(line?.period?.end) ??
    unixToIso(obj?.period_end) ??
    null
  );
}

/**
 * Map a raw Stripe event body into the canonical shape, or `ignored`.
 *
 * Tenant routing, in priority order:
 *   1. metadata.client_id          — set on a Checkout Session we created
 *   2. client_reference_id         — what a Payment Link can carry via the URL
 * When neither is present the event still flows through with a null clientId;
 * apply_billing_event parks it as 'unmapped' for reconciliation. That is the
 * intended behaviour: an unroutable payment must never be guessed onto a
 * tenant, because granting a paid plan to the wrong workspace is worse than
 * granting it late.
 */
export function parseStripeEvent(rawBody: string): CanonicalEvent | null {
  const e = JSON.parse(rawBody);
  const id = firstString(e?.id);
  if (!id) return null;

  const stripeType = typeof e?.type === "string" ? e.type : "";
  const obj = (e?.data?.object ?? {}) as Record<string, any>;

  let type = TYPE_MAP[stripeType] ?? "ignored";

  // A completed Checkout Session in `payment` mode is a one-off purchase, not a
  // subscription starting. Granting a recurring entitlement from it would hand
  // someone a plan they never subscribed to.
  if (stripeType === "checkout.session.completed" && obj?.mode === "payment") {
    type = "ignored";
  }

  const livemode = typeof e?.livemode === "boolean" ? e.livemode : null;

  if (type === "ignored") return { externalEventId: id, type: "ignored", livemode };

  const meta = collectMetadata(obj);
  const priceIds = extractPriceIds(obj);

  return {
    externalEventId: id,
    type,
    livemode,
    clientId: firstString(meta.client_id, obj?.client_reference_id),
    feature: asFeature(meta.feature),
    externalPriceId: priceIds[0] ?? null,
    externalPriceIds: priceIds,
    subscriptionRef: extractSubscriptionRef(obj),
    currentPeriodEnd: extractPeriodEnd(obj),
  };
}
