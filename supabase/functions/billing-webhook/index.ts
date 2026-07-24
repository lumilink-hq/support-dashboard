// =============================================================================
// billing-webhook — receives payment-processor webhooks and turns a paid plan
// into an entitlement (which the dashboard reads to unlock a page).
//
// PROCESSOR IS NOT DECIDED YET. This function is deliberately processor-agnostic:
//   1. An adapter (per processor) VERIFIES the signature and PARSES the raw body
//      into a single CanonicalEvent shape.
//   2. Everything downstream (client/feature resolution, idempotency, entitlement
//      writes) is processor-independent and lives in the apply_billing_event RPC.
//
// To wire a real processor later you only touch the adapter's verify()/parse()
// and add rows to billing_price_map — no schema change, no downstream change.
//
// A 'generic' adapter is included so the whole loop is testable TODAY by POSTing
// a normalized JSON body, before any processor is chosen.
//
// Contract with the processor's dashboard when you do pick one:
//   * Put the tenant + feature on the checkout so we can route without guessing:
//     metadata = { client_id: "<uuid>", feature: "email" | "voice" }.
//     (Fallback: map the price id via billing_price_map; see resolveFeature.)
//
// Security: never log the raw body or any secret. Verify signature BEFORE trust.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
// Per-processor signing secret, JSON: {"stripe":"whsec_…","square":"…","generic":"…"}
const rawWebhookSecrets = Deno.env.get("BILLING_WEBHOOK_SECRETS") ?? "{}";

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");

const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) {
  throw new Error("Missing service role key: SUPABASE_SECRET_KEYS['default']");
}
const WEBHOOK_SECRETS = JSON.parse(rawWebhookSecrets) as Record<string, string>;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---- Canonical shape every adapter must produce ----------------------------
type Feature = "email" | "voice";
type CanonicalType =
  | "subscription_activated"
  | "subscription_renewed"
  | "payment_failed"
  | "subscription_canceled"
  | "ignored";

interface CanonicalEvent {
  externalEventId: string;      // processor's unique event id (idempotency key)
  type: CanonicalType;
  clientId?: string | null;     // from checkout metadata, if present
  feature?: Feature | null;     // from metadata, else resolved via price map
  externalPriceId?: string | null;
  subscriptionRef?: string | null;
  currentPeriodEnd?: string | null; // ISO
}

interface Adapter {
  // Return true only if the signature is valid. Throwing is treated as invalid.
  verify(rawBody: string, headers: Headers, secret: string | undefined): Promise<boolean>;
  // Return null for events we don't care about.
  parse(rawBody: string): CanonicalEvent | null;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---- Adapters --------------------------------------------------------------
//
// NOTE: verify() bodies are PLACEHOLDERS until a processor is chosen. Each one
// documents the real check to drop in. The shared-token placeholder lets you
// exercise the pipeline end-to-end without a real signing secret.

/** Constant-time-ish shared-token check. Placeholder ONLY — replace with the
 *  processor's real HMAC verification below. */
function sharedTokenOk(headers: Headers, secret: string | undefined): boolean {
  if (!secret) return false;
  const got = headers.get("x-webhook-token") ?? "";
  if (got.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= got.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

const adapters: Record<string, Adapter> = {
  // --- generic: for local/E2E testing before a processor exists -------------
  // Expects a body already in (almost) canonical form:
  // { id, type, client_id, feature, price_id?, subscription_ref?, current_period_end? }
  generic: {
    async verify(_raw, headers, secret) {
      return sharedTokenOk(headers, secret);
    },
    parse(raw) {
      const b = JSON.parse(raw);
      const typeMap: Record<string, CanonicalType> = {
        subscription_activated: "subscription_activated",
        subscription_renewed: "subscription_renewed",
        payment_failed: "payment_failed",
        subscription_canceled: "subscription_canceled",
      };
      return {
        externalEventId: String(b.id),
        type: typeMap[b.type] ?? "ignored",
        clientId: b.client_id ?? null,
        feature: (b.feature as Feature) ?? null,
        externalPriceId: b.price_id ?? null,
        subscriptionRef: b.subscription_ref ?? null,
        currentPeriodEnd: b.current_period_end ?? null,
      };
    },
  },

  // --- stripe: skeleton. Fill in when chosen. ------------------------------
  stripe: {
    async verify(_raw, _headers, secret) {
      // TODO(processor): real check is Stripe's signature scheme —
      //   const sig = headers.get("stripe-signature");
      //   await stripe.webhooks.constructEventAsync(rawBody, sig, secret);
      // Until then, refuse rather than pretend: no silent trust.
      return secret ? sharedTokenOk(_headers, secret) : false;
    },
    parse(raw) {
      // TODO(processor): map Stripe event.type + data.object into canonical.
      //   checkout.session.completed / customer.subscription.created -> subscription_activated
      //   invoice.paid            -> subscription_renewed
      //   invoice.payment_failed  -> payment_failed
      //   customer.subscription.deleted -> subscription_canceled
      //   clientId  = data.object.metadata.client_id
      //   feature   = data.object.metadata.feature  (or price id -> billing_price_map)
      //   priceId   = data.object.items?.data[0]?.price?.id
      const e = JSON.parse(raw);
      return { externalEventId: String(e.id), type: "ignored" };
    },
  },

  // --- square: skeleton. Fill in when chosen. ------------------------------
  square: {
    async verify(_raw, _headers, secret) {
      // TODO(processor): Square signs with HMAC-SHA256 over (notificationUrl + body)
      // in the 'x-square-hmacsha256-signature' header. Compute and compare.
      return secret ? sharedTokenOk(_headers, secret) : false;
    },
    parse(raw) {
      // TODO(processor): map Square subscription/invoice events into canonical.
      const e = JSON.parse(raw);
      return { externalEventId: String(e.event_id ?? e.id), type: "ignored" };
    },
  },
};

// Pick processor from ?processor= or x-billing-processor, default generic.
function pickProcessor(url: URL, headers: Headers): string {
  return (
    url.searchParams.get("processor") ??
    headers.get("x-billing-processor") ??
    Deno.env.get("BILLING_PROCESSOR") ??
    "generic"
  ).toLowerCase();
}

// feature: prefer explicit metadata; else look the price id up in billing_price_map.
async function resolveFeature(ev: CanonicalEvent, processor: string): Promise<Feature | null> {
  if (ev.feature) return ev.feature;
  if (!ev.externalPriceId) return null;
  const { data } = await supabase
    .from("billing_price_map")
    .select("feature")
    .eq("processor", processor)
    .eq("external_price_id", ev.externalPriceId)
    .eq("is_active", true)
    .maybeSingle();
  return (data?.feature as Feature) ?? null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const processor = pickProcessor(url, req.headers);
  const adapter = adapters[processor];
  if (!adapter) return json({ error: `Unknown processor '${processor}'` }, 400);

  // Raw body is required for signature verification — read it as text ONCE.
  const rawBody = await req.text();

  // 1) Verify signature BEFORE trusting anything in the body.
  let verified = false;
  try {
    verified = await adapter.verify(rawBody, req.headers, WEBHOOK_SECRETS[processor]);
  } catch {
    verified = false;
  }
  if (!verified) return json({ error: "Invalid signature" }, 401);

  // 2) Parse to canonical. Don't log rawBody (may contain PII).
  let ev: CanonicalEvent | null;
  try {
    ev = adapter.parse(rawBody);
  } catch {
    return json({ error: "Unparseable body" }, 400);
  }
  if (!ev || !ev.externalEventId) return json({ error: "No event id" }, 400);

  // Events we don't handle: ack with 200 so the processor stops retrying.
  if (ev.type === "ignored") {
    return json({ status: "ignored", event_id: ev.externalEventId });
  }

  // 3) Resolve feature (metadata or price map) and hand off to the RPC, which
  //    owns idempotency + all entitlement state transitions.
  const feature = await resolveFeature(ev, processor);

  const { data, error } = await supabase.rpc("apply_billing_event", {
    p_processor: processor,
    p_external_event_id: ev.externalEventId,
    p_event_type: ev.type,
    p_client_id: ev.clientId ?? null,
    p_feature: feature,
    p_subscription_ref: ev.subscriptionRef ?? null,
    p_current_period_end: ev.currentPeriodEnd ?? null,
    p_payload: {}, // keep it lean; billing_events stores what we pass — no PII/secrets
  });

  if (error) {
    // Let the processor retry on a genuine server error.
    return json({ error: error.message }, 500);
  }

  // 'unmapped' still returns 200: it's a config gap (missing client_id/price map),
  // not something a retry fixes — it's parked in billing_events for reconciliation.
  return json(data ?? { status: "ok" });
});
