// Entitlements / plan-gating helpers for the dashboard. Reads the `entitlements`
// table (0008) under the caller's RLS so a tenant only ever sees its own plan.
// The dashboard NEVER writes entitlements — grants come from the billing webhook.

import { createClient } from "@/lib/supabase/server";

export type Feature = "email" | "voice";
export type EntitlementStatus = "pending" | "active" | "past_due" | "canceled";

export type EntitlementRow = {
  feature: Feature;
  status: EntitlementStatus;
  source: string;
  current_period_end: string | null;
  activated_at: string | null;
  canceled_at: string | null;
};

// UI state for a feature the tenant may or may not hold. Absence of a row = locked.
export type FeatureState = "locked" | "setup" | "active" | "past_due" | "canceled";

// -----------------------------------------------------------------------------
// COMMERCIAL TRUTH — mirrors the CFO workbook "LumiLink Financial Hub" v2.0
// (as of 2026-07-29). The workbook is the source of truth: if these constants
// and the workbook disagree, the workbook wins and this file is the bug.
//
// Only Starter is self-serve today. Growth ($279 + $499 / 250 min) and Scale
// ($449 + $799 / 600 min) are sales-assisted: close manually, grant the
// entitlement, set the client's voice cap by hand. The tier schema is
// deliberately deferred — see docs/landing-page-plan.md §5.
// -----------------------------------------------------------------------------

export const STARTER_PLAN = {
  label: "Starter",
  monthlyUsd: 179,
  setupFeeUsd: 299,
  includedMinutes: 100,
  /** Policy, all tiers: soft warning → confirm → transfer/ticket/hang-up. */
  maxCallMinutes: 2,
  numbers: 1,
  careHoursPerMonth: 2,
} as const;

/** Automatic overages — not optional features. Must be disclosed before checkout. */
export const OVERAGE = {
  perVoiceMinuteUsd: 0.3,
  perCareHourUsd: 85,
} as const;

/**
 * The public plan ladder, shared by the landing page and /plans so the two can
 * never quote different numbers.
 *
 * `selfServe` marks the only tier with a Payment Link. Growth and Scale are
 * sales-assisted until the tier layer exists: billing_price_map is feature-level,
 * so buying Scale today would grant the same 'voice' entitlement as Starter and
 * provisioning would apply Starter's 100-minute allowance. Publishing a link for
 * them before that is fixed sells 600 minutes and delivers 100.
 */
export type PlanTier = {
  label: string;
  monthlyUsd: number;
  setupFeeUsd: number;
  includedMinutes: number;
  highlights: string[];
  selfServe: boolean;
};

export const PLAN_TIERS: PlanTier[] = [
  {
    label: STARTER_PLAN.label,
    monthlyUsd: STARTER_PLAN.monthlyUsd,
    setupFeeUsd: STARTER_PLAN.setupFeeUsd,
    includedMinutes: STARTER_PLAN.includedMinutes,
    highlights: [
      `${STARTER_PLAN.includedMinutes} included minutes per month`,
      `${STARTER_PLAN.numbers} local phone number`,
      "24/7 answering and booking",
      "Website knowledge sync",
      "Callback ticket portal",
      `${STARTER_PLAN.careHoursPerMonth} hours of platform care per month`,
    ],
    selfServe: true,
  },
  {
    label: "Growth",
    monthlyUsd: 279,
    setupFeeUsd: 499,
    includedMinutes: 250,
    highlights: [
      "250 included minutes per month",
      "Advanced transfers",
      "4 hours of platform care per month",
      "Everything in Starter",
    ],
    selfServe: false,
  },
  {
    label: "Scale",
    monthlyUsd: 449,
    setupFeeUsd: 799,
    includedMinutes: 600,
    highlights: [
      "600 included minutes per month",
      "2 local phone numbers",
      "Advanced routing",
      "8 hours of platform care per month",
    ],
    selfServe: false,
  },
];

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

// Hosted-checkout URL for a feature, if a processor has been wired. Kept in config
// so choosing a processor later is configuration, not code:
//   CHECKOUT_URL_VOICE, CHECKOUT_URL_EMAIL
//
// When `clientId` is supplied we append Stripe's `client_reference_id`, which
// Stripe echoes back on checkout.session.completed. That is what lets the
// webhook route the grant to the right tenant: a bare Payment Link carries no
// identity, so without it the event arrives unroutable and parks as 'unmapped'
// awaiting a manual grant. The dashboard already knows who is signed in, so
// there is no reason to make anyone reconcile that by hand.
//
// A landing-page visitor has no account yet and therefore no client id. Those
// purchases are expected to park — see parseStripeEvent's note on why an
// unroutable payment must never be guessed onto a tenant.
export function checkoutUrl(
  feature: Feature,
  clientId?: string | null,
): string | null {
  const v = process.env[`CHECKOUT_URL_${feature.toUpperCase()}`];
  const base = v && v.trim() ? v.trim() : null;
  if (!base || !clientId) return base;

  try {
    const url = new URL(base);
    url.searchParams.set("client_reference_id", clientId);
    return url.toString();
  } catch {
    // A malformed CHECKOUT_URL_* shouldn't take the billing page down; fall
    // back to the raw value and let the manual-grant path handle routing.
    return base;
  }
}

// The caller's own client_id, for stamping onto a checkout URL. RLS scopes the
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

// All of the caller's entitlements, keyed by feature (missing = locked).
export async function getEntitlements(): Promise<
  Partial<Record<Feature, EntitlementRow>>
> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("entitlements")
    .select(
      "feature, status, source, current_period_end, activated_at, canceled_at",
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
