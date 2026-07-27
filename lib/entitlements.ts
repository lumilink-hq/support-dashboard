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

export type FeatureMeta = {
  key: Feature;
  label: string;
  tagline: string;
  blurb: string;
  bullets: string[];
  price: string; // display copy only; real price lives with the processor
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
      "After-hours & missed-call capture",
      "Real-time availability and booking",
      "Emergency triage and warm transfer",
      "Reschedule & cancel by phone",
    ],
    price: "from $299/mo",
    areas: ["/appointments", "/leads", "/services"],
  },
  {
    key: "email",
    label: "Email support",
    tagline: "Draft and send replies automatically",
    blurb:
      "Incoming support email is triaged, drafted, and answered with your order and shipping data — with a human review queue for anything unusual.",
    bullets: [
      "Automatic triage & drafting",
      "Order + shipping lookups",
      "Human review queue",
    ],
    price: "from $199/mo",
    areas: ["/conversations", "/review-queue"],
  },
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
export function checkoutUrl(feature: Feature): string | null {
  const v = process.env[`CHECKOUT_URL_${feature.toUpperCase()}`];
  return v && v.trim() ? v.trim() : null;
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
