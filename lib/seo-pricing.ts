// The SEO product's price, as data. Mirrors lib/entitlements.ts's PLAN_TIERS
// and lib/addons.ts's ADDONS — same reasoning: this is what /billing (and the
// SEO onboarding flow, module 11) quote, and it must not disagree with what
// Stripe actually charges.
//
// UNLIKE VOICE, THERE IS NO TIER LADDER HERE. SEO is one flat per-location
// price — $1,500/location/month (plan.md §1) — billed as QUANTITY on a single
// Stripe subscription item, not a choice between Starter/Growth/Scale prices.
// createSeoCheckoutSessionForClient (lib/services/billing.ts) sets that
// quantity to the client's location count at signup; reconcileSeoSeatCount
// updates it, with proration, whenever the location count changes afterward.

export const SEO_PRICE_PER_LOCATION_USD = 1500;

/**
 * The single Stripe Price this product bills against, quantity = location
 * count. Read from env, same reasoning as PlanTier.stripePriceId: rotating a
 * price is "update one var, redeploy," not a new migration. `null` means SEO
 * checkout isn't wired yet.
 */
export const SEO_STRIPE_PRICE_ID = process.env.STRIPE_PRICE_SEO_LOCATION ?? null;

export function isSeoCheckoutConfigured(): boolean {
  return Boolean(SEO_STRIPE_PRICE_ID);
}

export function seoMonthlyUsd(locationCount: number): number {
  return SEO_PRICE_PER_LOCATION_USD * Math.max(locationCount, 0);
}
