// The add-on catalogue, as data.
//
// WHY THIS FILE EXISTS. Add-ons are sold in two places — /billing's "Build Out
// Your Plan" and /welcome's post-purchase "Finalise Your Plan" — and the two
// must not disagree about what exists, what it costs, or what it's called.
// Stripe owns the charge; this file owns what we SAY.
//
// EACH ADD-ON IS A LINE ITEM ON THE CLIENT'S OWN SUBSCRIPTION, not a separate
// Payment Link / separate subscription. lib/services/billing.ts's
// addAddonToClient/removeAddonFromClient call Stripe's Subscription Items API
// directly against clients.stripe_subscription_id, and activeAddonsForClient
// reads current ownership LIVE off that subscription — there is no local
// mirror table to keep in sync (client_addons, migrations 0039/0040, is
// retired; it drifted from Stripe's own state, which is the whole reason this
// file no longer works the old way).
//
// MAPPING IS NOT FULFILMENT. Every item here bills correctly and NONE of them
// provision themselves — provisionVoice buys exactly one number, nothing wires
// a second one automatically. Selling one creates manual work.
// `manualFulfilment` says so per item rather than leaving it to be discovered
// on the first sale.

export type Addon = {
  /** Stable id used everywhere else in the app to refer to this add-on. */
  key: string;
  name: string;
  monthlyUsd: number;
  /** One line, customer-facing. Says what they get, not what it is. */
  blurb: string;
  /**
   * The Stripe Price this add-on's subscription item is created against —
   * read from env, same reasoning as PlanTier.stripePriceId in
   * lib/entitlements.ts: rotating a price is "update one var, redeploy," not
   * a new Payment Link. `null` means it isn't wired for purchase yet.
   */
  stripePriceId: string | null;
  /**
   * False = do not show it for sale anywhere.
   *
   * Website Chat is the one that matters: nothing meters a browser chat
   * session. Every cap in the product counts call minutes, a text session
   * generates none, and it lives on a public slug — so it can run up a bill
   * that cannot be capped. Flip this once the message allowance, per-session
   * ceiling and per-slug rate limit exist (BUILD-PLAN-2026-08.md §H).
   */
  available: boolean;
  /** True while fulfilling this one is a human doing it by hand. */
  manualFulfilment: boolean;
};

/**
 * Order is deliberate: Website Chat, Managed Integration, Additional Phone
 * Line, matching the order customers have seen it in since the Payment Link
 * era. Keeping the sequence stable means a returning customer meets the same
 * list, not a reshuffled one.
 */
export const ADDONS: Addon[] = [
  {
    key: "website_chat",
    name: "Website Chat",
    monthlyUsd: 40,
    blurb:
      "Put the same agent on your website, so visitors get answers without picking up the phone.",
    stripePriceId: process.env.STRIPE_PRICE_ADDON_WEBSITE_CHAT ?? null,
    // Turned on 2026-09-11 by explicit decision, ahead of the message
    // allowance / per-session ceiling / per-slug rate limit in
    // BUILD-PLAN-2026-08.md §H. Nothing metering a browser chat session exists
    // yet — this accepts that cost-exposure risk rather than closing it.
    available: true,
    manualFulfilment: true,
  },
  {
    key: "managed_integration",
    name: "Managed Integration",
    monthlyUsd: 30,
    blurb:
      "Connect LumiLink to a business platform you already use, and we keep it running.",
    stripePriceId: process.env.STRIPE_PRICE_ADDON_MANAGED_INTEGRATION ?? null,
    available: true,
    manualFulfilment: true,
  },
  {
    key: "additional_phone_line",
    name: "Additional AI Phone Line",
    monthlyUsd: 20,
    blurb:
      "A second dedicated line for a department, campaign or brand, on your existing plan.",
    stripePriceId: process.env.STRIPE_PRICE_ADDON_ADDITIONAL_PHONE_LINE ?? null,
    available: true,
    manualFulfilment: true,
  },
  {
    key: "additional_location",
    name: "Additional Location",
    monthlyUsd: 30,
    blurb:
      "Another location with its own number, hours, greeting and routing.",
    stripePriceId: process.env.STRIPE_PRICE_ADDON_ADDITIONAL_LOCATION ?? null,
    available: true,
    manualFulfilment: true,
  },
  {
    key: "advanced_workflow",
    name: "Advanced Workflow",
    monthlyUsd: 50,
    blurb:
      "A managed automation so the agent can carry out one more action off the back of a conversation.",
    stripePriceId: process.env.STRIPE_PRICE_ADDON_ADVANCED_WORKFLOW ?? null,
    available: true,
    manualFulfilment: true,
  },
  {
    key: "enhanced_optimization",
    name: "Enhanced Optimization",
    monthlyUsd: 80,
    blurb:
      "Higher-touch monthly tuning: response quality, business knowledge and configuration, reviewed by us.",
    stripePriceId: process.env.STRIPE_PRICE_ADDON_ENHANCED_OPTIMIZATION ?? null,
    available: true,
    manualFulfilment: true,
  },
];

/** What a customer may actually be shown. */
export function availableAddons(): Addon[] {
  return ADDONS.filter((a) => a.available);
}

/** Reverse lookup: which add-on (if any) a Stripe Price id belongs to. Used
 * by activeAddonsForClient to map a live subscription's line items back to
 * this catalogue. Returns null on no match — an item on the subscription that
 * isn't in this list (the plan's own price, or something stale) is simply not
 * an add-on, not an error. */
export function addonForStripePriceId(priceId: string): Addon | null {
  return ADDONS.find((a) => a.stripePriceId === priceId) ?? null;
}
