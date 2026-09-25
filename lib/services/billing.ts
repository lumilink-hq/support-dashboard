// lib/services/billing.ts — direct Stripe API calls, replacing static Payment
// Links. Mirrors the sibling Construction CRM project's lib/services/billing.ts.
//
// WHAT THIS DOES NOT CHANGE. entitlements, apply_billing_event (0008/0031),
// and the provision-feature worker (buys a Twilio number, configures
// ElevenLabs) all keep working exactly as before — syncClientFromStripeSubscription
// and markClientSubscriptionCanceled below still call apply_billing_event,
// same as the old Supabase Edge Function webhook did. Only the EVENT SOURCE
// changes: because we set client_id and plan_tier ourselves at Checkout-
// creation time (below), Stripe copies that metadata onto the resulting
// Subscription, so one customer.subscription.created event carries both —
// no more price-map lookups or metadata-guessing chain.
//
// SERVICE-ROLE CLIENT, CONFINED HERE. See lib/supabase/service.ts's own
// comment. Nothing outside this file should import createServiceClient.

import Stripe from "stripe";
import { addonForStripePriceId, ADDONS } from "@/lib/addons";
import {
  PLAN_TIERS,
  planTierForStripePriceId,
  type Feature,
  type PlanTierKey,
} from "@/lib/entitlements";
import {
  SEO_EXTRA_LOCATION,
  seoCheckoutLineItems,
  seoLocationsFromItems,
  seoPlanByKey,
  seoPlanFromItems,
  type SeoPlanKey,
} from "@/lib/seo-pricing";
import { createServiceClient } from "@/lib/supabase/service";
import { stripeClient } from "@/lib/stripe";

// Subscriptions created before this file resolved `feature` from metadata
// (everything prior to 2026-09-16) carry no `feature` key at all — every one
// of them is a voice subscription, so that's the correct default rather than
// an unmapped/dropped event.
const DEFAULT_FEATURE: Feature = "voice";

function featureFromSubscription(subscription: Stripe.Subscription): Feature {
  const raw = subscription.metadata.feature;
  return raw === "seo" || raw === "voice" || raw === "email" ? raw : DEFAULT_FEATURE;
}

export class BillingError extends Error {}

type ClientRow = {
  id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

async function getClientRow(clientId: string): Promise<ClientRow> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id, stripe_customer_id, stripe_subscription_id")
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw new BillingError(error.message);
  if (!data) throw new BillingError("Client not found");
  return data as ClientRow;
}

// clients.stripe_subscription_id (0041) is specifically the voice+addons
// BUNDLE subscription — "ONE subscription id to look up everything this
// client is subscribed to" per that migration's own comment, because addons
// ride the same subscription as the plan. SEO is a SEPARATE product with its
// own subscription (a client can buy SEO without voice, or both, each on its
// own invoice/cycle), so it cannot reuse that column without clobbering
// voice's subscription id the moment an SEO event fires. entitlements already
// carries external_subscription_ref per (client, feature) — that's SEO's
// source of truth instead.
async function getSeoSubscriptionId(clientId: string): Promise<string | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("entitlements")
    .select("external_subscription_ref")
    .eq("client_id", clientId)
    .eq("feature", "seo")
    .maybeSingle();
  return (data?.external_subscription_ref as string | null) ?? null;
}

// -----------------------------------------------------------------------------
// Checkout — creates a Stripe Checkout Session for a NEW plan subscription.
// A client with an existing customer id reuses it; Stripe creates one lazily
// otherwise. client_reference_id AND subscription_data.metadata both carry
// client_id (belt and suspenders: the Session carries the first, the
// Subscription it creates carries the second — the webhook only ever sees the
// Subscription on renewals, never the Session again).
// -----------------------------------------------------------------------------
export async function createCheckoutSessionForClient(input: {
  clientId: string;
  tier: PlanTierKey;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const tier = PLAN_TIERS.find((t) => t.key === input.tier);
  if (!tier?.stripePriceId) {
    throw new BillingError(`No Stripe price is configured for the ${input.tier} tier yet.`);
  }

  const client = await getClientRow(input.clientId);
  const stripe = stripeClient();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: tier.stripePriceId, quantity: 1 }],
    customer: client.stripe_customer_id ?? undefined,
    client_reference_id: client.id,
    subscription_data: {
      metadata: { client_id: client.id, plan_tier: input.tier, feature: "voice" },
    },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });

  if (!session.url) throw new BillingError("Stripe did not return a Checkout URL");
  return session.url;
}

// -----------------------------------------------------------------------------
// SEO checkout — module 12 (plan.md), repriced 2026-09-25 to the SEO product
// catalog (lib/seo-pricing.ts): one of three plans, with the location count
// as quantity where the plan bills per location. Mirrors
// createCheckoutSessionForClient's shape (same customer/client_reference_id/
// metadata pattern) rather than sharing its signature, because an SEO plan is
// not a PlanTierKey.
// -----------------------------------------------------------------------------
export async function createSeoCheckoutSessionForClient(input: {
  clientId: string;
  plan: SeoPlanKey;
  locationCount: number;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  if (!Number.isInteger(input.locationCount) || input.locationCount < 0) {
    throw new BillingError("locationCount must be a whole number.");
  }

  let lineItems: { price: string; quantity: number }[];
  try {
    lineItems = seoCheckoutLineItems(input.plan, input.locationCount);
  } catch (e) {
    throw new BillingError(e instanceof Error ? e.message : String(e));
  }

  const client = await getClientRow(input.clientId);
  const stripe = stripeClient();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: lineItems,
    customer: client.stripe_customer_id ?? undefined,
    client_reference_id: client.id,
    subscription_data: {
      description: seoPlanByKey(input.plan).headline,
      metadata: { client_id: client.id, feature: "seo", seo_plan: input.plan },
    },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });

  if (!session.url) throw new BillingError("Stripe did not return a Checkout URL");
  return session.url;
}

/** The client's SEO plan and billed location count, read live from Stripe. */
export async function seoSubscriptionForClient(
  clientId: string,
): Promise<{ plan: SeoPlanKey | null; locations: number | null } | null> {
  const seoSubscriptionId = await getSeoSubscriptionId(clientId);
  if (!seoSubscriptionId) return null;
  const subscription = await stripeClient().subscriptions.retrieve(seoSubscriptionId);
  const items = subscription.items.data.map((i) => ({ priceId: i.price.id, quantity: i.quantity }));
  return { plan: seoPlanFromItems(items), locations: seoLocationsFromItems(items) };
}

// -----------------------------------------------------------------------------
// reconcileSeoSeatCount — proration when a location is added or removed
// (plan.md module 12). No caller yet: it's for a future "add/remove location"
// action, after it writes/deletes the seo_locations row. It only talks to
// Stripe and does not read seo_locations, so it has no opinion on what counts
// as an active location.
//
// Per plan: Local SEO sets its item's quantity to the count; the bundle keeps
// its one included location and puts the rest on the "Additional SEO
// Location" item (created, updated or deleted as needed). Website SEO covers
// no locations, so a location change there is refused: that's a plan change,
// done in the Stripe portal or by us.
//
// Idempotent: if Stripe already matches, this is a no-op. proration_behavior
// is left at Stripe's default ('create_prorations'), so a platform-wide
// proration policy change is one Stripe Dashboard setting, not a code change.
// -----------------------------------------------------------------------------
export async function reconcileSeoSeatCount(input: {
  clientId: string;
  targetLocationCount: number;
}): Promise<{ changed: boolean; previousQuantity: number | null; quantity: number }> {
  if (!Number.isInteger(input.targetLocationCount) || input.targetLocationCount < 1) {
    throw new BillingError("targetLocationCount must be a positive integer.");
  }

  const seoSubscriptionId = await getSeoSubscriptionId(input.clientId);
  if (!seoSubscriptionId) {
    throw new BillingError("Client has no SEO subscription to reconcile — subscribe first.");
  }

  const stripe = stripeClient();
  const subscription = await stripe.subscriptions.retrieve(seoSubscriptionId);
  const items = subscription.items.data;
  const plan = seoPlanFromItems(items.map((i) => ({ priceId: i.price.id })));
  const previousQuantity = seoLocationsFromItems(
    items.map((i) => ({ priceId: i.price.id, quantity: i.quantity })),
  );

  if (plan === "local") {
    const item = items.find((i) => i.price.id === seoPlanByKey("local").stripePriceId)!;
    if (item.quantity === input.targetLocationCount) {
      return { changed: false, previousQuantity, quantity: input.targetLocationCount };
    }
    await stripe.subscriptionItems.update(item.id, { quantity: input.targetLocationCount });
    return { changed: true, previousQuantity, quantity: input.targetLocationCount };
  }

  if (plan === "bundle") {
    const extraPriceId = SEO_EXTRA_LOCATION.stripePriceId;
    if (!extraPriceId) throw new BillingError("No Stripe price is configured for additional locations.");
    const wantExtra = input.targetLocationCount - seoPlanByKey("bundle").includedLocations;
    const extraItem = items.find((i) => i.price.id === extraPriceId);
    const haveExtra = extraItem?.quantity ?? 0;
    if (haveExtra === wantExtra) {
      return { changed: false, previousQuantity, quantity: input.targetLocationCount };
    }
    if (!extraItem) {
      await stripe.subscriptionItems.create({
        subscription: seoSubscriptionId,
        price: extraPriceId,
        quantity: wantExtra,
      });
    } else if (wantExtra === 0) {
      await stripe.subscriptionItems.del(extraItem.id);
    } else {
      await stripe.subscriptionItems.update(extraItem.id, { quantity: wantExtra });
    }
    return { changed: true, previousQuantity, quantity: input.targetLocationCount };
  }

  if (plan === "website") {
    throw new BillingError("Website SEO doesn't include locations. Switch to Full SEO to add them.");
  }
  throw new BillingError("Client's SEO subscription isn't on a self-serve plan; change it in Stripe.");
}

// -----------------------------------------------------------------------------
// Billing Portal — card updates, invoice history, self-serve cancellation.
// Requires a stripe_customer_id, i.e. at least one prior checkout.
// -----------------------------------------------------------------------------
export async function createBillingPortalSessionForClient(input: {
  clientId: string;
  returnUrl: string;
}): Promise<string> {
  const client = await getClientRow(input.clientId);
  if (!client.stripe_customer_id) {
    throw new BillingError("No Stripe customer yet — subscribe to a plan first.");
  }

  const stripe = stripeClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: client.stripe_customer_id,
    return_url: input.returnUrl,
  });
  return session.url;
}

// Whether /billing should show the "Manage billing" (Stripe Portal) button —
// gated on stripe_customer_id alone, independent of subscription status, so
// even a canceled customer can still reach the portal for old invoices.
export async function hasStripeCustomerForClient(clientId: string): Promise<boolean> {
  const client = await getClientRow(clientId);
  return Boolean(client.stripe_customer_id);
}

// -----------------------------------------------------------------------------
// Add-ons — read LIVE from Stripe, no local mirror. client_addons (0039/0040)
// is retired precisely because a local copy of Stripe's state can drift; this
// asks Stripe directly instead.
// -----------------------------------------------------------------------------
export async function activeAddonsForClient(
  clientId: string,
): Promise<{ key: string; monthlyUsd: number }[]> {
  const client = await getClientRow(clientId);
  if (!client.stripe_subscription_id) return [];

  const stripe = stripeClient();
  const subscription = await stripe.subscriptions.retrieve(client.stripe_subscription_id);

  return subscription.items.data
    .map((item) => addonForStripePriceId(item.price.id))
    .filter((a): a is (typeof ADDONS)[number] => a !== null)
    .map((a) => ({ key: a.key, monthlyUsd: a.monthlyUsd }));
}

async function findAddonSubscriptionItem(
  subscriptionId: string,
  priceId: string,
): Promise<Stripe.SubscriptionItem | null> {
  const subscription = await stripeClient().subscriptions.retrieve(subscriptionId);
  return subscription.items.data.find((item) => item.price.id === priceId) ?? null;
}

// Adds one add-on to the client's existing subscription. Every LumiLink
// add-on is quantity-1 (own it or don't) — unlike the sibling project's
// usage-based add-ons, nothing here needs a quantity stepper. Treats "already
// present" as success, not an error: a double-click or a retried request must
// never create a second item at the same price and double-bill.
export async function addAddonToClient(input: {
  clientId: string;
  addonKey: string;
}): Promise<void> {
  const addon = ADDONS.find((a) => a.key === input.addonKey);
  if (!addon?.stripePriceId) {
    throw new BillingError("That add-on isn't available for self-serve purchase.");
  }

  const client = await getClientRow(input.clientId);
  if (!client.stripe_subscription_id) {
    throw new BillingError("Subscribe to a plan first.");
  }

  const stripe = stripeClient();
  const existing = await findAddonSubscriptionItem(client.stripe_subscription_id, addon.stripePriceId);
  if (existing) return; // already on — idempotent no-op, not an error.

  await stripe.subscriptionItems.create({
    subscription: client.stripe_subscription_id,
    price: addon.stripePriceId,
    quantity: 1,
  });
}

export async function removeAddonFromClient(input: {
  clientId: string;
  addonKey: string;
}): Promise<void> {
  const addon = ADDONS.find((a) => a.key === input.addonKey);
  if (!addon?.stripePriceId) {
    throw new BillingError("That add-on isn't available for self-serve purchase.");
  }

  const client = await getClientRow(input.clientId);
  if (!client.stripe_subscription_id) {
    throw new BillingError("Subscribe to a plan first.");
  }

  const existing = await findAddonSubscriptionItem(client.stripe_subscription_id, addon.stripePriceId);
  if (!existing) return; // already off — idempotent no-op, not an error.

  await stripeClient().subscriptionItems.del(existing.id);
}

// -----------------------------------------------------------------------------
// Webhook-driven sync. Called by app/api/webhooks/stripe/route.ts for
// customer.subscription.created/updated and .deleted respectively. Both keep
// entitlements/provisioning working exactly as before by ending in a call to
// the existing apply_billing_event RPC.
// -----------------------------------------------------------------------------
export async function syncClientFromStripeSubscription(
  subscription: Stripe.Subscription,
  externalEventId: string,
): Promise<void> {
  const clientId = subscription.metadata.client_id;
  if (!clientId) {
    console.warn(`Stripe subscription ${subscription.id} has no client_id metadata — skipping sync`);
    return;
  }

  const feature = featureFromSubscription(subscription);

  // Metadata first (set at Checkout-creation time — the reason this whole
  // function doesn't need a price-map lookup chain). Falls back to scanning
  // items for a renewal event that might not carry it. Meaningless for 'seo'
  // (no tiers there), so planTierForStripePriceId simply finds nothing and
  // this resolves to null, which apply_billing_event already treats as
  // "no tier known" — not an error.
  const planTier =
    (subscription.metadata.plan_tier as PlanTierKey | undefined) ??
    subscription.items.data
      .map((item) => planTierForStripePriceId(item.price.id))
      .find((t): t is PlanTierKey => t !== null) ??
    null;

  // Seat count = Google Business Profile locations paid for
  // (seoLocationsFromItems, lib/seo-pricing.ts). For voice/email (always
  // quantity 1) this resolves to 1 and lands harmlessly on a column
  // apply_billing_event treats as meaningless for those features.
  const seatCount =
    feature === "seo"
      ? seoLocationsFromItems(
          subscription.items.data.map((item) => ({ priceId: item.price.id, quantity: item.quantity })),
        )
      : (subscription.items.data[0]?.quantity ?? null);

  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  // Stripe API versions from 2025-03-31 onward moved current_period_end off
  // the Subscription object onto each SubscriptionItem. Try both shapes
  // rather than assume one — verified against a real test-mode event before
  // shipping (see the migration plan's verification section).
  const currentPeriodEnd =
    (subscription as unknown as { current_period_end?: number }).current_period_end ??
    subscription.items.data[0]?.current_period_end ??
    null;

  const supabase = createServiceClient();

  // clients.stripe_subscription_id/status is the voice+addons BUNDLE
  // subscription specifically (see getSeoSubscriptionId's comment above) —
  // an SEO event must still record the (shared) customer id, since that part
  // really is client-wide, but must NOT overwrite the bundle subscription
  // id/status with SEO's own subscription. SEO's own id/status already lives
  // on entitlements.external_subscription_ref/current_period_end via the
  // apply_billing_event call below.
  const clientUpdate: Record<string, string | null> = { stripe_customer_id: customerId };
  if (feature === "voice") {
    clientUpdate.stripe_subscription_id = subscription.id;
    clientUpdate.stripe_subscription_status = subscription.status;
  }
  const { error: updateError } = await supabase
    .from("clients")
    .update(clientUpdate)
    .eq("id", clientId);
  if (updateError) {
    console.error(`Failed to update clients for ${clientId}:`, updateError.message);
  }

  const { error: rpcError } = await supabase.rpc("apply_billing_event", {
    p_processor: "stripe",
    p_external_event_id: externalEventId,
    p_event_type: subscription.status === "past_due" ? "payment_failed" : "subscription_activated",
    p_client_id: clientId,
    p_feature: feature,
    p_subscription_ref: subscription.id,
    p_current_period_end: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
    p_payload: { source: "stripe_direct_api", status: subscription.status },
    p_plan_tier: planTier,
    p_seat_count: seatCount,
  });
  if (rpcError) {
    console.error(`apply_billing_event failed for ${clientId}:`, rpcError.message);
  }
}

// Doesn't clear stripe_subscription_id or downgrade plan_tier — a canceled
// subscription still ran its current period out in Stripe's own model, and
// deciding what a client falls back to is a real product decision, not
// implied by this event alone. Same call as the old webhook made.
export async function markClientSubscriptionCanceled(
  subscription: Stripe.Subscription,
  externalEventId: string,
): Promise<void> {
  const clientId = subscription.metadata.client_id;
  if (!clientId) return;

  const feature = featureFromSubscription(subscription);
  const supabase = createServiceClient();
  if (feature === "voice") {
    await supabase
      .from("clients")
      .update({ stripe_subscription_status: subscription.status })
      .eq("id", clientId);
  }

  const { error } = await supabase.rpc("apply_billing_event", {
    p_processor: "stripe",
    p_external_event_id: externalEventId,
    p_event_type: "subscription_canceled",
    p_client_id: clientId,
    p_feature: feature,
    p_subscription_ref: subscription.id,
    p_current_period_end: null,
    p_payload: { source: "stripe_direct_api", status: subscription.status },
    p_plan_tier: null,
    p_seat_count: null,
  });
  if (error) {
    console.error(`apply_billing_event (cancel) failed for ${clientId}:`, error.message);
  }
}
