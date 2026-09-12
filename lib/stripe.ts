import Stripe from "stripe";

// Lazy singleton — mirrors the sibling Construction CRM project's lib/stripe.ts.
// Importing this module must never throw just because Stripe isn't configured
// yet; only a caller that actually invokes stripeClient() pays that cost, at
// request time. No apiVersion pinned — takes the installed SDK's default.
let client: Stripe | null = null;

export function stripeClient(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not set — Stripe billing isn't configured yet.");
  }
  if (!client) {
    client = new Stripe(secretKey);
  }
  return client;
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}
