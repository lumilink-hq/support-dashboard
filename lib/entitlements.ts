// Entitlements / plan-gating helpers for the dashboard. Reads the `entitlements`
// table (0008) under the caller's RLS so a tenant only ever sees its own plan.
// The dashboard NEVER writes entitlements — grants come from the billing webhook.

import { createClient } from "@/lib/supabase/server";

export type Feature = "email" | "voice" | "seo";
export type EntitlementStatus = "pending" | "active" | "past_due" | "canceled";

export type EntitlementRow = {
  feature: Feature;
  status: EntitlementStatus;
  source: string;
  current_period_end: string | null;
  activated_at: string | null;
  canceled_at: string | null;
  /** Units of the feature paid for (0044) — location count for 'seo'. Null
   * for quantity-always-1 features (voice, email). */
  seat_count: number | null;
};

// UI state for a feature the tenant may or may not hold. Absence of a row = locked.
export type FeatureState = "locked" | "setup" | "active" | "past_due" | "canceled";

// -----------------------------------------------------------------------------
// COMMERCIAL TRUTH — mirrors the CFO workbook "LumiLink Financial Hub" v2.0
// (as of 2026-07-29). The workbook is the source of truth: if these constants
// and the workbook disagree, the workbook wins and this file is the bug.
//
// ALL THREE TIERS ARE SELF-SERVE as of 0031. Growth ($279 + $499 / 250 min) and
// Scale ($449 + $799 / 600 min) used to be sales-assisted, because the price map
// was feature-level: every plan granted the same 'voice' entitlement and
// provisioning applied Starter's 100 minutes whichever tier was bought. Selling
// Scale self-serve then meant taking $449 for 600 minutes and delivering 100.
//
// 0031 built the tier layer — plan_tiers holds the allowance, the price map
// names the tier, the entitlement records it, provisioning applies it. So the
// links can be published.
//
// THESE NUMBERS ARE MIRRORED IN THE DATABASE (plan_tiers, migration 0031) and
// they MUST agree. This file is DISPLAY truth — what the pricing page quotes.
// plan_tiers is ENFORCEMENT truth — what a paying customer is actually given.
// When they diverge, a customer is quoted one allowance and provisioned another,
// and nothing errors. 0031 §7b is the query that checks it.
// -----------------------------------------------------------------------------

/**
 * SETUP FEE CHANGED 2026-08-11: $299/$499/$799 → a flat **$49.99** on all three
 * tiers. Workbook updated first; this file follows it.
 *
 * The old figures are recorded here on purpose. They appear in earlier docs, in
 * Stripe's existing setup prices, and in the CFO model's onboarding-economics
 * cell, so anyone finding a $299 in this repo needs to know it is history
 * rather than a number to restore.
 *
 * NOTHING SYNCS THIS TO STRIPE. Stripe prices are immutable — an amount cannot
 * be edited — so the change requires NEW setup prices and a swap on each
 * Payment Link. Changing this constant alone updates what the pricing page
 * SAYS while the invoice keeps charging the old fee. See
 * docs/STRIPE-TIERS-RUNBOOK.md §2a.
 */
// SETUP FEE REMOVED 2026-08-13. Setup is free and advertised as the
// differentiator: we do the work, the customer doesn't lift a finger.
//
// The constant survives at 0 rather than being deleted. Every card, plan row and
// FAQ already reads from it, so reinstating a fee is a one-line change instead of
// an archaeology exercise — and `setupFeeUsd > 0` is the condition the UI now
// branches on, so nothing renders "+ $0 one-time setup".
//
// HISTORY: $299/$499/$799 -> a flat $49.99 (2026-08-11) -> $0 (2026-08-13).
// Nothing in Stripe needs removing: the one-time price objects were never
// created, so no Payment Link is carrying a setup line to strip.
export const SETUP_FEE_USD = 0;

export const STARTER_PLAN = {
  label: "Starter",
  monthlyUsd: 180,
  setupFeeUsd: SETUP_FEE_USD,
  includedMinutes: 100,
  /** Policy, all tiers: soft warning → confirm → transfer/ticket/hang-up. */
  maxCallMinutes: 2,
  numbers: 1,
  careHoursPerMonth: 2,
} as const;

/** Automatic overages — not optional features. Must be disclosed before checkout. */
/**
 * OVERAGE POLICY CHANGED 2026-08-13: the allowance is now a HARD CAP.
 *
 * We do not bill per-minute overage. When a client reaches their allowance they
 * upgrade; they are never surprised by a usage charge they did not choose.
 *
 * WHY THIS IS BARELY A CODE CHANGE: the hard stop already exists. Layer 1 in
 * voice-personalization refuses a call that begins over the cap — that is the
 * cheapest place to stop one — and layer 3 in voice-order-lookup wraps up a call
 * that crosses mid-conversation. What changes is that nothing is invoiced
 * afterwards, and the site stops quoting a per-minute rate that made customers
 * nervous about their own phone ringing.
 *
 * The rates are KEPT, not deleted: /billing still needs them to explain what a
 * plan is worth, and if metered overage ever returns this is where it lives.
 * Nothing on a marketing page may quote perVoiceMinuteUsd.
 */
export const OVERAGE = {
  /** Not billed. Retained for internal costing and any future metered plan. */
  perVoiceMinuteUsd: 0.3,
  perCareHourUsd: 85,
  /** The policy the customer actually experiences. */
  policy: "hard_cap" as const,
} as const;

/**
 * Observed average call length, used ONLY to translate a minute allowance into
 * the call count we advertise.
 *
 * WHY THIS EXISTS (2026-08-12). We now position plans in CALLS, because "100
 * minutes" is a number no contractor or store owner can act on and "about 65
 * calls" is one they can compare against the calls they already miss. Nothing
 * about the SYSTEM changes: plan_tiers.included_minutes is still the allowance,
 * set_plan_tier_caps still applies minutes, record_call_usage still counts
 * minutes, and overage is still billed per minute. This is the marketing unit,
 * not the metered one.
 *
 * The number itself: the calls on file run well under the ceiling (one live
 * transcript at 45s), so 1.5 is a deliberately conservative middle. Because
 * max_call_secs is 105s, a call can never exceed 1.75 minutes — which is what
 * makes a call count safe to quote at all. Divide by 1.75 instead of this
 * constant and you get the floor a customer cannot beat.
 *
 * REVISIT WHEN REAL USAGE ARRIVES. Seven calls in a fortnight is not a sample.
 */
export const AVG_CALL_MINUTES = 1.5;

/**
 * The advertised call count for a minute allowance.
 *
 * DERIVED, NEVER TYPED. The minute caps are changing shortly; every page that
 * quotes a call count must move with them automatically, or we recreate the
 * exact drift this file exists to prevent. Rounded down to a multiple of five
 * so the marketing number is never larger than the arithmetic.
 */
export function advertisedCalls(includedMinutes: number): number {
  return Math.floor(includedMinutes / AVG_CALL_MINUTES / 5) * 5;
}

/**
 * The call count a customer CANNOT beat, at the enforced ceiling. Use this
 * wherever the claim has to be defensible rather than typical — contracts,
 * comparison tables, anything a customer could hold you to.
 */
export function guaranteedCalls(includedMinutes: number): number {
  return Math.floor(includedMinutes / STARTER_PLAN.maxCallMinutes / 5) * 5;
}

/**
 * A tier's stable machine key. Matches plan_tiers.tier in the database and the
 * `plan_tier` metadata value on the Stripe Payment Link. Changing one of these
 * strings without changing all three breaks the chain silently.
 */
export type PlanTierKey = "starter" | "growth" | "scale";

/**
 * The public plan ladder, shared by the landing page and /plans so the two can
 * never quote different numbers.
 *
 * `selfServe` marks a tier that has a Payment Link and can be bought without
 * talking to anyone. All three are self-serve since 0031 built the tier layer.
 *
 * `mostPopular` is PRESENTATION ONLY and is deliberately a separate flag. It
 * used to be inferred from `selfServe` — the badge and the dark border were
 * rendered by `tier.selfServe ? ... : ...` — which was fine when exactly one
 * tier was purchasable and meaningless the moment all three were. Conflating
 * "you can buy this" with "this is the one we recommend" would have put the
 * badge on all three cards.
 */
export type PlanTier = {
  key: PlanTierKey;
  label: string;
  monthlyUsd: number;
  setupFeeUsd: number;
  includedMinutes: number;
  highlights: string[];
  selfServe: boolean;
  mostPopular: boolean;
  /**
   * The Stripe Price this tier's Checkout Session is created against — read
   * from env so rotating a price is "update one var, redeploy," not a new
   * Payment Link and a billing_price_map insert. `null` means checkout isn't
   * wired for this tier yet; callers must treat that the same as `!selfServe`.
   */
  stripePriceId: string | null;
};

export const PLAN_TIERS: PlanTier[] = [
  {
    key: "starter",
    label: STARTER_PLAN.label,
    monthlyUsd: STARTER_PLAN.monthlyUsd,
    setupFeeUsd: STARTER_PLAN.setupFeeUsd,
    includedMinutes: STARTER_PLAN.includedMinutes,
    stripePriceId: process.env.STRIPE_PRICE_VOICE_STARTER ?? null,
    // Calls first, minutes in brackets. The bracket is not decoration: the
    // dashboard meter, the overage line and the invoice are all in minutes, so
    // a customer who has only ever been told "calls" meets a unit they have
    // never seen at exactly the wrong moment.
    highlights: [
      `About 90 calls a month (${STARTER_PLAN.includedMinutes} minutes)`,
      `${STARTER_PLAN.numbers} local phone number`,
      "24/7 answering and booking",
      "Website knowledge sync",
      "Callback ticket portal",
      `${STARTER_PLAN.careHoursPerMonth} hours of platform care per month`,
    ],
    selfServe: true,
    mostPopular: false,
  },
  {
    key: "growth",
    label: "Growth",
    monthlyUsd: 280,
    setupFeeUsd: SETUP_FEE_USD,
    includedMinutes: 250,
    stripePriceId: process.env.STRIPE_PRICE_VOICE_GROWTH ?? null,
    highlights: [
      `About 175 calls a month (250 minutes)`,
      "Advanced transfers",
      "4 hours of platform care per month",
      "Everything in Starter",
    ],
    selfServe: true,
    mostPopular: true,
  },
  {
    key: "scale",
    label: "Scale",
    monthlyUsd: 450,
    setupFeeUsd: SETUP_FEE_USD,
    includedMinutes: 600,
    stripePriceId: process.env.STRIPE_PRICE_VOICE_SCALE ?? null,
    highlights: [
      `About 300 calls a month (600 minutes)`,
      "2 local phone numbers",
      "Advanced routing",
      "8 hours of platform care per month",
    ],
    selfServe: true,
    mostPopular: false,
  },
];

/**
 * The white-label / Enterprise card shown alongside PLAN_TIERS on every
 * pricing surface (the homepage, both /solutions pages, and /plans).
 *
 * Deliberately NOT a PlanTier and NOT in PLAN_TIERS. There is no price, no
 * Payment Link and no plan_tier row — this is quoted and provisioned by hand,
 * so it can never be self-served. Keeping it out of PLAN_TIERS matters
 * beyond styling: /billing derives "From $X/mo" via
 * `Math.min(...PLAN_TIERS.map(t => t.monthlyUsd))` and the advertised minute
 * range via `PLAN_TIERS[0]` / `PLAN_TIERS[PLAN_TIERS.length - 1]`. An
 * Enterprise entry with no real monthlyUsd would corrupt both.
 */
export const ENTERPRISE_TIER = {
  label: "Enterprise",
  blurb:
    "White-label branding, custom limits, and a dedicated line to us. Priced per organisation.",
  highlights: [
    "White-label branding for your customers",
    "Custom minute allowances and phone numbers",
    "Dedicated onboarding and support",
    "Everything in Scale",
  ],
} as const;

// enterpriseContactHref() (a mailto: link) lived here until 2026-08-31, when
// every caller — /plans and PricingGrid's Enterprise card in
// components/marketing/blocks.tsx — switched to contactHref() in blocks.tsx,
// which sends someone to /contact instead of asking them to draft their own
// email. Removed rather than left as dead code once nothing called it.

export type FeatureMeta = {
  key: Feature;
  label: string;
  tagline: string;
  blurb: string;
  bullets: string[];
  /**
   * Display copy only; the real price lives with the processor.
   * `null` means the feature is NOT sold separately — it's included with the
   * plan, so the UI shows no price and no checkout button.
   */
  price: string | null;
  /** One-time fee shown alongside the recurring price, when there is one. */
  setupFee: string | null;
  areas: string[]; // dashboard routes this feature unlocks
};

export const FEATURES: FeatureMeta[] = [
  {
    key: "voice",
    label: "Voice & scheduling",
    tagline: "Answer every call, book every job",
    blurb:
      "Lumi answers your phone, quotes from your price list, checks real availability, books jobs, captures leads, and reschedules — around the clock.",
    bullets: [
      `${STARTER_PLAN.includedMinutes} included minutes/mo · ${STARTER_PLAN.numbers} local number`,
      "24/7 answering, after-hours & missed-call capture",
      "Real-time availability and booking",
      "Website knowledge sync included — no connector fee",
      "Callback ticket portal so nothing disappears",
      `Calls capped at ${STARTER_PLAN.maxCallMinutes} min, then transfer or callback ticket`,
    ],
    price: `$${STARTER_PLAN.monthlyUsd}/mo`,
    setupFee: `$${STARTER_PLAN.setupFeeUsd} one-time setup`,
    areas: ["/appointments", "/leads", "/services"],
  },
  // EMAIL IS WITHDRAWN FOR NOW.
  //
  // The CFO model removed email pricing entirely, and the channel is being cut
  // while voice is the focus. Its card is gone from /billing and its settings
  // are hidden, so nothing offers customers a channel we are not running.
  //
  // The PLUMBING STAYS: feature_t still has 'email', the entitlements table can
  // still hold an email row, and billing-webhook can still resolve one. Removing
  // any of that would be a destructive migration for a feature described as
  // paused. This array only drives what the dashboard renders.
  //
  // To bring it back: restore the entry below, un-hide the two Settings
  // sections, and put the Email tab back on /conversations.
  //
  // SEO IS THE SAME SITUATION, for a different reason (2026-09-16). feature_t
  // and Feature carry 'seo' so entitlements/has_feature/getEntitlements work
  // end to end (see 0044_seo_billing_seats.sql), but this array is what
  // /billing renders a checkout card FROM — and every "sellable" card here
  // routes to /plans, the VOICE tier picker (see the `cheapest` / "why this no
  // longer links straight to Stripe" comment below). SEO has no tiers — it's
  // one flat per-location price, quantity on checkout — so it needs its own
  // picker (a location-count input, built alongside module 11's onboarding
  // wizard) before a card can point anywhere correct. Add it here once that
  // page exists; until then this array staying two entries long is the
  // correct state, not an oversight.
  //
  // {
  //   key: "email",
  //   label: "Email support",
  //   tagline: "Draft and send replies automatically",
  //   blurb: "Incoming support email is triaged, drafted, and answered with
  //           your order and shipping data, with a human review queue for
  //           anything unusual.",
  //   bullets: ["Automatic triage & drafting", "Order + shipping lookups",
  //             "Human review queue"],
  //   price: null,
  //   setupFee: null,
  //   areas: ["/conversations", "/review-queue"],
  // },
];

export function featureMeta(feature: Feature): FeatureMeta {
  return FEATURES.find((f) => f.key === feature) ?? FEATURES[0];
}

export function featureState(row: EntitlementRow | undefined): FeatureState {
  if (!row) return "locked";
  switch (row.status) {
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "pending":
      return "setup";
    case "canceled":
      return "canceled";
    default:
      return "locked";
  }
}

// A feature is usable (page unlocked) when active or in the past_due grace period.
export function isUsable(state: FeatureState): boolean {
  return state === "active" || state === "past_due";
}

// Whether page-level gating is enforced. Default OFF so existing tenants (who have
// no entitlement rows yet) keep full access until billing is actually rolled out.
// Flip ENFORCE_ENTITLEMENTS=1 once every live client has been granted their plan.
export function entitlementsEnforced(): boolean {
  return process.env.ENFORCE_ENTITLEMENTS === "1";
}

// checkoutUrl / tierCheckoutUrl / stampClientRef (static Payment Link URLs,
// CHECKOUT_URL_* env vars) are RETIRED as of the move to direct Stripe API
// calls — see lib/services/billing.ts's createCheckoutSessionForClient and
// components/billing/checkout-button.tsx. client_reference_id is now set
// server-side at Checkout Session creation instead of stamped onto a URL.

// The caller's own client_id. RLS scopes the
// row, so this can only ever return the signed-in user's tenant.
export async function getCurrentClientId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("users")
    .select("client_id")
    .eq("id", user.id)
    .maybeSingle();
  return (data?.client_id as string | undefined) ?? null;
}

// Shared by the three billing Route Handlers so each doesn't repeat the same
// "signed in, and known to a tenant" check. Not a new abstraction — just a
// dedupe of what every caller already did inline.
export async function requireClientId(): Promise<string | null> {
  return getCurrentClientId();
}

/** Reverse lookup: which tier (if any) a Stripe Price id belongs to. Used by
 * the webhook to resolve a renewal event that carries no plan_tier metadata
 * (only the very first checkout.session.completed sets it). Returns null on
 * no match rather than throwing — an unrecognised price degrades to "no
 * tier", same tolerance apply_billing_event already has for a bad plan_tier
 * string. */
export function planTierForStripePriceId(priceId: string): PlanTierKey | null {
  return PLAN_TIERS.find((t) => t.stripePriceId === priceId)?.key ?? null;
}

// All of the caller's entitlements, keyed by feature (missing = locked).
export async function getEntitlements(): Promise<
  Partial<Record<Feature, EntitlementRow>>
> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("entitlements")
    .select(
      "feature, status, source, current_period_end, activated_at, canceled_at, seat_count",
    );
  const map: Partial<Record<Feature, EntitlementRow>> = {};
  for (const r of (data ?? []) as EntitlementRow[]) map[r.feature] = r;
  return map;
}

// Current-month voice usage for the caller's own tenant.
//
// Reads the `voice_usage_current` view from 0012, which is declared
// `security_invoker` so the RLS on clients/voice_usage_events applies to the
// querying user — a tenant can only ever resolve its own row. Returns null when
// the client has no voice usage row yet (e.g. a brand-new workspace).
export type VoiceUsage = {
  calls: number;
  minutes_used: number;
  /** null = explicitly unlimited (-1 in caps) or unresolvable. */
  minutes_cap: number | null;
  avg_call_minutes: number | null;
};

export async function getVoiceUsage(): Promise<VoiceUsage | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("voice_usage_current")
    .select("calls, minutes_used, minutes_cap, avg_call_minutes")
    .maybeSingle();
  return (data as VoiceUsage | null) ?? null;
}

// Minutes billed at the overage rate once the allowance is consumed, and what
// they'd cost. Returns zeros when there's no cap or the client is under it.
export function overageEstimate(usage: VoiceUsage | null): {
  overMinutes: number;
  estimatedUsd: number;
} {
  const cap = usage?.minutes_cap ?? null;
  if (!usage || cap === null || cap < 0) return { overMinutes: 0, estimatedUsd: 0 };
  const over = Math.max(usage.minutes_used - cap, 0);
  return {
    overMinutes: Math.round(over * 100) / 100,
    estimatedUsd: Math.round(over * OVERAGE.perVoiceMinuteUsd * 100) / 100,
  };
}

// Page-level gate. When enforcement is off, nothing is locked. When on, a feature
// is locked unless the tenant holds a usable entitlement for it.
export async function featureGate(
  feature: Feature,
): Promise<{ locked: boolean; state: FeatureState }> {
  if (!entitlementsEnforced()) return { locked: false, state: "active" };
  const ent = await getEntitlements();
  const state = featureState(ent[feature]);
  return { locked: !isUsable(state), state };
}
