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
import {
  type CanonicalEvent,
  type CanonicalType,
  type Feature,
  parseStripeEvent,
  parseWebhookSecrets,
  verifyStripeSignature,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
// Signing secret(s). Accepts EITHER form — see parseWebhookSecrets:
//   {"stripe":"whsec_…","square":"…"}   per-processor map
//   whsec_…                             a single secret, used for any processor
const rawWebhookSecrets = Deno.env.get("BILLING_WEBHOOK_SECRETS") ?? "{}";

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");

const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) {
  throw new Error("Missing service role key: SUPABASE_SECRET_KEYS['default']");
}

const {
  map: WEBHOOK_SECRETS,
  fallback: WEBHOOK_SECRET_FALLBACK,
  configError: WEBHOOK_SECRET_CONFIG_ERROR,
} = parseWebhookSecrets(rawWebhookSecrets);

if (WEBHOOK_SECRET_CONFIG_ERROR) {
  // Logged once at boot as well as per-request: whichever log the operator
  // reaches for first, the message is there.
  console.error(WEBHOOK_SECRET_CONFIG_ERROR);
}

/**
 * Signing secrets to try for a processor: its explicit map entry, else the bare
 * value(s). More than one is normal — Stripe's test and live endpoints have
 * different secrets and both point here, so during a cutover both must verify.
 */
function secretsFor(processor: string): string[] {
  const explicit = WEBHOOK_SECRETS[processor];
  return explicit?.length ? explicit : WEBHOOK_SECRET_FALLBACK;
}

// How far a Stripe signature timestamp may drift before we refuse it. Stripe's
// own default is 300s. Raise it only if the function is genuinely slow to be
// invoked; a wide window is a replay window.
const STRIPE_TOLERANCE_SECS = Number(
  Deno.env.get("STRIPE_WEBHOOK_TOLERANCE_SECS") ?? 300,
);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---- Canonical shape every adapter must produce ----------------------------
// CanonicalEvent, CanonicalType and Feature now live in ./lib.ts (imported
// above) alongside the Stripe adapter's pure logic, so scripts can unit test
// signature verification and event mapping without Deno.serve, env or a
// database. See scripts/test-billing-webhook.ts.

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

  // --- stripe: IMPLEMENTED -------------------------------------------------
  // Both halves live in ./lib.ts. Signature verification is a real HMAC-SHA256
  // over `${t}.${rawBody}` against the endpoint secret, with a replay window;
  // parsing maps Stripe's event types onto the canonical four.
  //
  // Setup: BILLING_WEBHOOK_SECRETS must contain {"stripe":"whsec_..."} — the
  // endpoint's signing secret from the Stripe dashboard, NOT an API key. Route
  // traffic here with ?processor=stripe on the endpoint URL, or by setting
  // BILLING_PROCESSOR=stripe.
  stripe: {
    async verify(raw, headers, secret) {
      return await verifyStripeSignature(
        raw,
        headers.get("stripe-signature"),
        secret,
        { toleranceSecs: STRIPE_TOLERANCE_SECS },
      );
    },
    parse(raw) {
      return parseStripeEvent(raw);
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

// feature: prefer explicit metadata; else look the price ids up in
// billing_price_map.
//
// Searches EVERY price id on the event, not just the first. An invoice for a
// plan with a one-time setup fee has two lines, and the setup line can come
// first — matching only that one finds nothing and parks a good renewal.
async function resolveFeature(ev: CanonicalEvent, processor: string): Promise<Feature | null> {
  if (ev.feature) return ev.feature;

  const ids = priceIdsOf(ev);
  if (ids.length === 0) return null;

  const { data } = await supabase
    .from("billing_price_map")
    .select("feature")
    .eq("processor", processor)
    .in("external_price_id", ids)
    .eq("is_active", true)
    .limit(1);
  return (data?.[0]?.feature as Feature) ?? null;
}

/** Every price id the event offered, first-populated wins. */
function priceIdsOf(ev: CanonicalEvent): string[] {
  return ev.externalPriceIds?.length
    ? ev.externalPriceIds
    : ev.externalPriceId
      ? [ev.externalPriceId]
      : [];
}

// WHICH PLAN they bought, not just which feature.
//
// This is the whole point of 0031. billing_price_map used to answer only
// "voice", so provision-feature had no way to tell a $449 Scale purchase from a
// $179 Starter one and applied the entry allowance of 100 minutes to both. A
// Scale customer got a sixth of the minutes they paid for, silently — no error,
// no log, HTTP 200 all the way down.
//
// TWO FILTERS, both load-bearing:
//
//   kind = 'plan'   Add-on prices (extra number, extra department) will live in
//                   this same table and will also map to feature 'voice'. They
//                   are billed on the SAME subscription, so their ids arrive on
//                   the same event as the plan's. Without this filter an add-on
//                   row could be the one that matches and "which tier?" would be
//                   answered by a $15 line item.
//
//   highest wins    A tie is possible in one real case: a subscription carrying
//                   two plan prices, which happens mid-upgrade when Stripe
//                   prorates the old and the new price onto one invoice. Taking
//                   the HIGHER allowance is the deliberate choice — the customer
//                   is moving to the tier they just paid for, and 0031's caps
//                   are raise-only anyway, so resolving to the lower one would
//                   do nothing and leave them under-provisioned.
//
// The max is computed HERE rather than with .order().limit(1). PostgREST's
// `order` on an embedded resource sorts the EMBEDDED rows, not the parent rows,
// so ordering by plan_tiers.included_minutes and taking the first row would have
// returned an arbitrary price-map row while looking entirely correct. The result
// set is at most a handful of rows; sorting it in memory removes the trap.
//
// Returns null when nothing matches. Null is a real answer: manual grants and
// cancellations legitimately carry no tier, and apply_billing_event's coalesce
// keeps whatever tier is already on the entitlement rather than erasing it.
async function resolvePlanTier(
  ev: CanonicalEvent,
  processor: string,
): Promise<string | null> {
  // METADATA FIRST, and this ordering is the whole reason self-serve Growth
  // works at all.
  //
  // Only `checkout.session.completed` can create a grant — it is the one event
  // carrying `client_reference_id`. It also carries NO PRICE. So on the single
  // event where the tier must be known, there is nothing for the price map to
  // match, and that same event kicks provisioning. Price-map-only resolution
  // therefore means: entitlement created with a null tier, provisioning reads
  // null, applies 100 minutes, and a $279 customer silently receives Starter's
  // allowance. The link's `plan_tier` metadata is the only source available at
  // that moment.
  //
  // The price map still answers for renewals and upgrades, where the invoice
  // does carry prices — and there it is the better source, because it lives
  // beside the price rather than on a link someone might rebuild.
  if (ev.planTier) return ev.planTier;

  const ids = priceIdsOf(ev);
  if (ids.length === 0) return null;

  const { data, error } = await supabase
    .from("billing_price_map")
    .select("plan_tier, plan_tiers!inner(included_minutes)")
    .eq("processor", processor)
    .eq("kind", "plan")
    .in("external_price_id", ids)
    .eq("is_active", true);

  if (error || !data?.length) return null;

  type Row = { plan_tier: string | null; plan_tiers?: { included_minutes?: number } | null };
  let best: Row | null = null;
  for (const row of data as unknown as Row[]) {
    if (!row.plan_tier) continue;
    const mins = row.plan_tiers?.included_minutes ?? -1;
    const bestMins = best?.plan_tiers?.included_minutes ?? -1;
    if (!best || mins > bestMins) best = row;
  }
  return best?.plan_tier ?? null;
}

// The tier for a subscription we already track. Needed for the same reason
// resolveBySubscription exists: a renewal or a recovery may arrive with prices
// we can map, but a cancellation carries none at all. Reading the tier back off
// the entitlement keeps it stable across those events instead of letting it
// flicker to null and back.
async function tierBySubscription(
  subscriptionRef: string | null | undefined,
): Promise<string | null> {
  if (!subscriptionRef) return null;
  const { data } = await supabase
    .from("entitlements")
    .select("plan_tier")
    .eq("external_subscription_ref", subscriptionRef)
    .maybeSingle();
  return (data?.plan_tier as string) ?? null;
}

// Fall back to the subscription we ALREADY track when an event doesn't name a
// tenant or feature.
//
// WHY THIS IS REQUIRED, not a nicety. apply_billing_event parks anything that
// arrives without BOTH a client_id and a feature. With a hosted Payment Link
// those two facts never travel together after the first event:
//
//   checkout.session.completed    client_reference_id, but no price on the payload
//   customer.subscription.created price (-> feature), but client_reference_id
//                                 does NOT propagate to the subscription
//   invoice.paid       (renewals) no client_reference_id anywhere, ever
//   customer.subscription.deleted no client_reference_id anywhere, ever
//
// Without this lookup a renewal would never extend the period and — much worse
// — a CANCELLATION would park as 'unmapped', leaving a customer who cancelled
// with a live entitlement and a provisioned phone number.
//
// The subscription ref is a safe key: it was written by us, on the grant, from
// Stripe's own payload. maybeSingle() returns null if somehow more than one row
// matches, so an ambiguous ref parks rather than guessing a tenant.
async function resolveBySubscription(
  subscriptionRef: string | null | undefined,
): Promise<{ clientId: string | null; feature: Feature | null }> {
  if (!subscriptionRef) return { clientId: null, feature: null };
  const { data } = await supabase
    .from("entitlements")
    .select("client_id, feature")
    .eq("external_subscription_ref", subscriptionRef)
    .maybeSingle();
  return {
    clientId: (data?.client_id as string) ?? null,
    feature: (data?.feature as Feature) ?? null,
  };
}

// Nudge the provisioning worker to drain its queue. Never throws, never blocks
// the webhook response.
//
// EdgeRuntime.waitUntil keeps the request alive for the background call after
// we've responded; without it the isolate can be torn down mid-flight and the
// kick is silently lost. Falls back to a floating promise where it isn't
// available. Either way, failure here only delays provisioning until the next
// event or cron run — it must never turn a successful grant into a 500, because
// Stripe would then retry an event we already applied.
function kickProvisioning(): void {
  const url = `${SUPABASE_URL}/functions/v1/provision-feature`;
  const p = fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Harmless when the function is deployed --no-verify-jwt, required if it
      // ever isn't.
      Authorization: `Bearer ${SERVICE_ROLE_SECRET}`,
    },
    body: "{}",
  })
    .then((r) => {
      if (!r.ok) console.error(`provision-feature kick returned ${r.status}`);
    })
    .catch((e) => console.error("provision-feature kick failed:", String(e)));

  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (typeof rt?.waitUntil === "function") rt.waitUntil(p);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const processor = pickProcessor(url, req.headers);
  const adapter = adapters[processor];
  if (!adapter) return json({ error: `Unknown processor '${processor}'` }, 400);

  // A malformed BILLING_WEBHOOK_SECRETS is a configuration fault, not a bad
  // request. Say so explicitly: reporting it as "Invalid signature" would send
  // whoever is debugging to rotate a secret that was never the problem.
  if (WEBHOOK_SECRET_CONFIG_ERROR) {
    console.error(WEBHOOK_SECRET_CONFIG_ERROR);
    return json({ error: WEBHOOK_SECRET_CONFIG_ERROR }, 500);
  }

  const secrets = secretsFor(processor);
  if (secrets.length === 0) {
    const msg =
      `No signing secret for processor '${processor}'. Set BILLING_WEBHOOK_SECRETS ` +
      `to the bare whsec_... value, or to {"${processor}":"whsec_..."}.`;
    console.error(msg);
    return json({ error: msg }, 500);
  }

  // Raw body is required for signature verification — read it as text ONCE.
  const rawBody = await req.text();

  // 1) Verify signature BEFORE trusting anything in the body.
  //    Every configured secret is tried: test and live endpoints have different
  //    ones, and both legitimately deliver here during a cutover.
  let verified = false;
  for (const secret of secrets) {
    try {
      if (await adapter.verify(rawBody, req.headers, secret)) {
        verified = true;
        break;
      }
    } catch {
      // Treat a throwing verifier as a failed match and try the next secret.
    }
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

  // 3) Resolve WHO and WHAT, then hand off to the RPC, which owns idempotency
  //    and all entitlement state transitions.
  //
  //    Order matters: the event's own metadata wins, then the price map, and
  //    only then the subscription we already track. Never the reverse — an
  //    explicit client_id on the payload must always beat an inferred one.
  let clientId = ev.clientId ?? null;
  let feature = await resolveFeature(ev, processor);
  let planTier = await resolvePlanTier(ev, processor);

  if (!clientId || !feature) {
    const known = await resolveBySubscription(ev.subscriptionRef);
    clientId = clientId ?? known.clientId;
    feature = feature ?? known.feature;
  }

  // Same precedence rule as above: what the event itself carries beats what we
  // infer. Only reach for the stored tier when this event names no plan price —
  // a cancel, or the checkout.session.completed that opens a purchase.
  if (!planTier) {
    planTier = await tierBySubscription(ev.subscriptionRef);
  }

  // Minimal diagnostics, so an 'unmapped' row says WHY it was unmapped.
  //
  // This used to be `{}`, which made the most common failure undebuggable: the
  // event parked, the row recorded null client_id and null feature, and nothing
  // recorded whether the price id was unknown, the metadata was missing, or the
  // buyer simply had no account. Every field below is a Stripe object id or a
  // boolean — no email, no name, no card data, no raw body.
  const diagnostics = {
    // Stripe's test/live flag. Both modes deliver to this one endpoint, so
    // without it there is no way to filter a diagnostic query down to real
    // money — and a table full of test-era noise makes a genuine live failure
    // impossible to spot.
    livemode: ev.livemode ?? null,
    external_price_id: ev.externalPriceId ?? null,
    // All of them: an invoice with a setup fee carries more than one, and
    // knowing which were offered is the difference between "price map gap" and
    // "we only looked at the wrong line".
    external_price_ids: ev.externalPriceIds ?? [],
    subscription_ref: ev.subscriptionRef ?? null,
    // Did the event itself name a tenant, or did we infer it from a known
    // subscription? Distinguishes "link opened anonymously" from "price map gap".
    client_id_source: ev.clientId
      ? "event"
      : clientId
        ? "subscription_lookup"
        : "none",
    feature_source: ev.feature
      ? "metadata"
      : feature
        ? "price_map_or_subscription"
        : "none",
    // WHICH PLAN, recorded on every event. A null here on a paid activation is
    // the signature of the under-delivery bug 0031 fixed: the grant lands, the
    // customer is charged for Growth, and provisioning has nothing to tell it
    // apart from Starter. Worth being able to query for after the fact.
    plan_tier: planTier,
    // Where it came from, because the two sources fail differently and the
    // distinction is invisible afterwards. 'metadata' on a
    // checkout.session.completed is the healthy case. 'price_map' there is
    // impossible (that event carries no price), so 'none' on an activation
    // means the link is missing its plan_tier metadata — findable with one
    // query across billing_events instead of one customer at a time.
    plan_tier_source: ev.planTier
      ? "metadata"
      : planTier
        ? "price_map_or_subscription"
        : "none",
  };

  const { data, error } = await supabase.rpc("apply_billing_event", {
    p_processor: processor,
    p_external_event_id: ev.externalEventId,
    p_event_type: ev.type,
    p_client_id: clientId,
    p_feature: feature,
    p_subscription_ref: ev.subscriptionRef ?? null,
    p_current_period_end: ev.currentPeriodEnd ?? null,
    p_payload: diagnostics,
    p_plan_tier: planTier,
  });

  // A grant leaves the entitlement 'pending' and a task 'queued'. Nothing
  // drains that queue on its own, so without this the customer pays and sits on
  // "Setting up your plan…" until a human remembers to poke the function.
  //
  // Fire-and-forget on purpose. Provisioning buys a Twilio number and calls
  // ElevenLabs; that can outlast Stripe's delivery timeout, and a webhook that
  // times out gets RETRIED — re-running a grant we already applied. The queue
  // is idempotent and retried on its own schedule, so the correct thing here is
  // to kick it and return immediately, never to wait for it or fail on it.
  if (!error && (data as { status?: string } | null)?.status === "applied") {
    kickProvisioning();
  }

  if (error) {
    // Let the processor retry on a genuine server error.
    return json({ error: error.message }, 500);
  }

  // 'unmapped' still returns 200: it's a config gap (missing client_id/price map),
  // not something a retry fixes — it's parked in billing_events for reconciliation.
  return json(data ?? { status: "ok" });
});
