// The SEO product line's prices, as data. Mirrors lib/entitlements.ts's
// PLAN_TIERS and lib/addons.ts's ADDONS — same reasoning: this is what
// /billing, /pricing and /products/seo quote, and it must not disagree with
// what Stripe actually charges.
//
// SOURCE: "LUMILINK SEO STRIPE PRODUCT CATALOG" (2026-09-25), which replaced
// the single $1,500/location price. The products already exist in Stripe;
// each Price id is read from env, same reasoning as PlanTier.stripePriceId:
// rotating a price is "update one var, redeploy," not a code change. A plan
// whose var is unset is simply not offered at checkout.
//
// THE SELF-SERVE PLANS. A client holds ONE SEO subscription (entitlement
// feature 'seo'), on exactly one of:
//   - website: $1,995/mo flat. One website, no Google Business Profile.
//   - local:   $495/mo per location, billed as QUANTITY.
//   - bundle:  $2,400/mo flat for one website + one location, plus the
//              $400/mo "Additional SEO Location" price (QUANTITY = locations
//              beyond the first) on the same subscription.
//
// NOT SELF-SERVE:
//   - PACKS store share ($900/mo per store, 4 stores): a private product the
//     stores pay through a Stripe Payment Link with custom fields. Its price is
//     listed here only so a subscription carrying it is recognised as SEO.
//   - Enterprise: custom, sold through a Stripe Quote. No price, no link.
//
// entitlements.seat_count is the number of Google Business Profile LOCATIONS
// being paid for (seoLocationsFromItems below): 0 on website, the quantity on
// local, 1 + add-on quantity on bundle.

export type SeoPlanKey = "website" | "local" | "bundle";

export type SeoPlan = {
  key: SeoPlanKey;
  name: string;
  headline: string;
  /** Flat monthly price, or the per-location price when perLocation. */
  monthlyUsd: number;
  perLocation: boolean;
  /** Locations the base price covers (bundle: 1). Ignored when perLocation. */
  includedLocations: number;
  /** Whether the plan covers the website (SEO + AI search) at all. */
  includesWebsite: boolean;
  stripePriceId: string | null;
  includes: string[];
  footnote?: string;
};

// Plan bullets for /pricing, /products/seo and /billing. They claim only what
// is BUILT (components/marketing/seo.tsx's rule): the catalog's Google Business
// Profile items (profile optimization, Google Posts, review replies) wait on
// Google's API approval, so they're a "coming soon" footnote, not a bullet.
// The Stripe product descriptions carry the catalog's full wording.
const LOCAL_INCLUDES = [
  "Weekly rank tracking in the local map pack",
  "A geo grid showing where each location ranks",
  "Local competitor tracking",
  "Location-level monthly reporting",
];

export const SEO_PLANS: SeoPlan[] = [
  {
    key: "website",
    name: "Website SEO + AI Search",
    headline: "Grow your visibility across Google and AI-powered search.",
    monthlyUsd: 1995,
    perLocation: false,
    includedLocations: 0,
    includesWebsite: true,
    stripePriceId: process.env.STRIPE_PRICE_SEO_WEBSITE ?? null,
    includes: [
      "Weekly site and technical audits",
      "Search Console and indexing checks",
      "Keyword rank tracking and up to five competitors",
      "Fixes and SEO articles drafted for your approval",
      "Backlink monitoring",
      "AI search visibility, at no extra charge",
      "Monthly report",
    ],
    footnote: "One website.",
  },
  {
    key: "local",
    name: "Local SEO",
    headline: "Improve local visibility for each Google Business Profile location.",
    monthlyUsd: 495,
    perLocation: true,
    includedLocations: 0,
    includesWebsite: false,
    stripePriceId: process.env.STRIPE_PRICE_SEO_LOCAL ?? null,
    includes: LOCAL_INCLUDES,
    footnote: "Google Business Profile optimization, posts and review replies are coming soon.",
  },
  {
    key: "bundle",
    name: "Full SEO + AI Search",
    headline: "Complete website, local and AI-search visibility in one package.",
    monthlyUsd: 2400,
    perLocation: false,
    includedLocations: 1,
    includesWebsite: true,
    stripePriceId: process.env.STRIPE_PRICE_SEO_BUNDLE ?? null,
    includes: [
      "Everything in Website SEO + AI Search",
      "Everything in Local SEO for one location",
      "More locations at $400/mo each",
      "One combined monthly report",
    ],
    footnote: "Saves $90 a month against buying both separately.",
  },
];

/** Additional locations on the bundle only ("LumiLink Additional SEO Location"). */
export const SEO_EXTRA_LOCATION = {
  monthlyUsd: 400,
  stripePriceId: process.env.STRIPE_PRICE_SEO_EXTRA_LOCATION ?? null,
};

/** Private PACKS product: one store's share. Not sold through the app. */
export const SEO_PACKS_STORE = {
  monthlyUsd: 900,
  stripePriceId: process.env.STRIPE_PRICE_SEO_PACKS_STORE ?? null,
};

export function seoPlanByKey(key: SeoPlanKey): SeoPlan {
  const plan = SEO_PLANS.find((p) => p.key === key);
  if (!plan) throw new Error(`Unknown SEO plan: ${key}`);
  return plan;
}

/** Plans that can be bought right now (their Stripe price is configured). */
export function availableSeoPlans(): SeoPlan[] {
  return SEO_PLANS.filter(
    (p) => p.stripePriceId && (p.key !== "bundle" || SEO_EXTRA_LOCATION.stripePriceId),
  );
}

export function isSeoCheckoutConfigured(): boolean {
  return availableSeoPlans().length > 0;
}

/** Locations a plan bills for when the client has `locationCount` of them. */
export function seoBilledLocations(key: SeoPlanKey, locationCount: number): number {
  const n = Math.max(Math.floor(locationCount), 0);
  if (key === "website") return 0;
  if (key === "local") return Math.max(n, 1);
  return Math.max(n, 1); // bundle: always at least its included location
}

export function seoMonthlyUsd(key: SeoPlanKey, locationCount: number): number {
  const plan = seoPlanByKey(key);
  const locations = seoBilledLocations(key, locationCount);
  if (plan.perLocation) return plan.monthlyUsd * locations;
  const extra = Math.max(locations - plan.includedLocations, 0);
  return plan.monthlyUsd + extra * SEO_EXTRA_LOCATION.monthlyUsd;
}

/** Stripe line items for a new SEO subscription. */
export function seoCheckoutLineItems(
  key: SeoPlanKey,
  locationCount: number,
): { price: string; quantity: number }[] {
  const plan = seoPlanByKey(key);
  if (!plan.stripePriceId) throw new Error(`No Stripe price is configured for ${plan.name}.`);
  const locations = seoBilledLocations(key, locationCount);

  if (key === "local") return [{ price: plan.stripePriceId, quantity: locations }];
  const items = [{ price: plan.stripePriceId, quantity: 1 }];
  const extra = Math.max(locations - plan.includedLocations, 0);
  if (extra > 0) {
    if (!SEO_EXTRA_LOCATION.stripePriceId) {
      throw new Error("No Stripe price is configured for additional locations.");
    }
    items.push({ price: SEO_EXTRA_LOCATION.stripePriceId, quantity: extra });
  }
  return items;
}

/** Which self-serve plan a subscription's items are on, or null (PACKS, unknown). */
export function seoPlanFromItems(items: { priceId: string }[]): SeoPlanKey | null {
  for (const plan of SEO_PLANS) {
    if (plan.stripePriceId && items.some((i) => i.priceId === plan.stripePriceId)) return plan.key;
  }
  return null;
}

/**
 * Locations a subscription pays for, from its items. null when none of its
 * items is an SEO price (so apply_billing_event keeps the existing count).
 */
export function seoLocationsFromItems(
  items: { priceId: string; quantity: number | null | undefined }[],
): number | null {
  let found = false;
  let locations = 0;
  for (const item of items) {
    const qty = item.quantity ?? 1;
    const id = item.priceId;
    if (!id) continue;
    if (id === seoPlanByKey("website").stripePriceId) {
      found = true;
    } else if (id === seoPlanByKey("local").stripePriceId) {
      found = true;
      locations += qty;
    } else if (id === seoPlanByKey("bundle").stripePriceId) {
      found = true;
      locations += seoPlanByKey("bundle").includedLocations * qty;
    } else if (id === SEO_EXTRA_LOCATION.stripePriceId || id === SEO_PACKS_STORE.stripePriceId) {
      found = true;
      locations += qty;
    }
  }
  return found ? locations : null;
}

/** Whether any item is one of the SEO prices above. */
export function isSeoPriceId(priceId: string): boolean {
  return seoLocationsFromItems([{ priceId, quantity: 1 }]) !== null;
}
