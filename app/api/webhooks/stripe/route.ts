// Stripe webhook — replaces supabase/functions/billing-webhook for the events
// this app actually needs. Deliberately handles only the three subscription
// lifecycle events: checkout.session.completed carries no price and is
// redundant with customer.subscription.created, which fires alongside it and
// carries everything sync needs (mirrors the sibling Construction CRM
// project's app/api/webhooks/stripe/route.ts).
//
// No idempotency table here — apply_billing_event (called inside
// syncClientFromStripeSubscription/markClientSubscriptionCanceled) is already
// idempotent, keyed on (processor, external_event_id), which is why this
// route passes Stripe's own event.id through rather than inventing one.

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import {
  markClientSubscriptionCanceled,
  syncClientFromStripeSubscription,
} from "@/lib/services/billing";
import { stripeClient } from "@/lib/stripe";

export async function POST(request: Request) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  const signature = request.headers.get("stripe-signature") ?? "";
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (e) {
    console.error("Stripe signature verification failed:", String(e));
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await syncClientFromStripeSubscription(
          event.data.object as Stripe.Subscription,
          event.id,
        );
        break;
      case "customer.subscription.deleted":
        await markClientSubscriptionCanceled(
          event.data.object as Stripe.Subscription,
          event.id,
        );
        break;
      default:
        break;
    }
  } catch (e) {
    console.error(`Stripe webhook handler failed for ${event.type}:`, String(e));
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
