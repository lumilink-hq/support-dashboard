// The add-on catalogue, as data.
//
// WHY THIS FILE EXISTS. Add-ons are sold in two places — Stripe's "recommended
// products" on each plan link, and the post-purchase "Finalise Your Plan"
// screen — and the two must not disagree about what exists, what it costs, or
// what it's called. Stripe owns the charge; this file owns what we SAY.
//
// EACH ADD-ON HAS ITS OWN PAYMENT LINK. That is what makes the post-purchase
// screen buildable today with no new billing code: "add this" is a link, and
// the existing webhook + billing_price_map handle the rest. The price rows are
// mapped in scripts/seed-addon-price-map.sql with kind='addon' and an
// addon_key, which is what stops a $39 line being mistaken for a plan tier.
//
// MAPPING IS NOT FULFILMENT. Every item here bills correctly and NONE of them
// provision themselves — there is no client_addons table and provisionVoice
// buys exactly one number. Selling one creates manual work. `manualFulfilment`
// says so per item rather than leaving it to be discovered on the first sale.

export type Addon = {
  /** Matches billing_price_map.addon_key. The join between money and meaning. */
  key: string;
  name: string;
  monthlyUsd: number;
  /** One line, customer-facing. Says what they get, not what it is. */
  blurb: string;
  /** Stripe Payment Link. Env override so a link can be swapped without a deploy. */
  url: string;
  /**
   * False = do not show it for sale anywhere.
   *
   * Website Chat is the one that matters: nothing meters a browser chat
   * session. Every cap in the product counts call minutes, a text session
   * generates none, and it lives on a public slug — so it can run up a bill
   * that cannot be capped. Its price row is mapped `is_active = false` for the
   * same reason. Flip both together, once the message allowance, per-session
   * ceiling and per-slug rate limit exist (BUILD-PLAN-2026-08.md §H).
   */
  available: boolean;
  /** True while fulfilling this one is a human doing it by hand. */
  manualFulfilment: boolean;
};

/**
 * Order is deliberate and matches the recommended-product order on the Stripe
 * links: Website Chat, Managed Integration, Additional Phone Line. Keeping the
 * two sequences identical means a customer who saw them at checkout meets them
 * again in the same order, which reads as one product rather than two lists.
 */
export const ADDONS: Addon[] = [
  {
    key: "website_chat",
    name: "Website Chat",
    monthlyUsd: 39,
    blurb:
      "Put the same agent on your website, so visitors get answers without picking up the phone.",
    url:
      process.env.NEXT_PUBLIC_ADDON_URL_WEBSITE_CHAT ??
      "https://buy.stripe.com/cNi5kw0b07HM9Q2bHx0VO07",
    available: false, // see the note on `available` above
    manualFulfilment: true,
  },
  {
    key: "managed_integration",
    name: "Managed Integration",
    monthlyUsd: 29,
    blurb:
      "Connect LumiLink to a business platform you already use, and we keep it running.",
    url:
      process.env.NEXT_PUBLIC_ADDON_URL_MANAGED_INTEGRATION ??
      "https://buy.stripe.com/5kQcMY1f4e6aaU6dPF0VO05",
    available: true,
    manualFulfilment: true,
  },
  {
    key: "additional_phone_line",
    name: "Additional AI Phone Line",
    monthlyUsd: 19,
    blurb:
      "A second dedicated line for a department, campaign or brand, on your existing plan.",
    url:
      process.env.NEXT_PUBLIC_ADDON_URL_PHONE_LINE ??
      "https://buy.stripe.com/14A4gs6zoaTY6DQbHx0VO09",
    available: true,
    manualFulfilment: true,
  },
  {
    key: "additional_location",
    name: "Additional Location",
    monthlyUsd: 29,
    blurb:
      "Another location with its own number, hours, greeting and routing.",
    url:
      process.env.NEXT_PUBLIC_ADDON_URL_LOCATION ??
      "https://buy.stripe.com/14A3cobTIfae6DQh1R0VO08",
    available: true,
    manualFulfilment: true,
  },
  {
    key: "advanced_workflow",
    name: "Advanced Workflow",
    monthlyUsd: 49,
    blurb:
      "A managed automation so the agent can carry out one more action off the back of a conversation.",
    url:
      process.env.NEXT_PUBLIC_ADDON_URL_ADVANCED_WORKFLOW ??
      "https://buy.stripe.com/5kQfZae1QaTYfamfXN0VO06",
    available: true,
    manualFulfilment: true,
  },
  {
    key: "enhanced_optimization",
    name: "Enhanced Optimization",
    monthlyUsd: 79,
    blurb:
      "Higher-touch monthly tuning: response quality, business knowledge and configuration, reviewed by us.",
    url:
      process.env.NEXT_PUBLIC_ADDON_URL_ENHANCED_OPTIMIZATION ??
      "https://buy.stripe.com/28EeV62j8fae9Q226X0VO04",
    available: true,
    manualFulfilment: true,
  },
];

/** What a customer may actually be shown. */
export function availableAddons(): Addon[] {
  return ADDONS.filter((a) => a.available);
}
