// =============================================================================
// Onboarding wizard — step definitions and progress state.
//
// Progress lives in `clients.settings.onboarding` as JSONB, not in a table.
// 0001 describes `settings` as the place "onboarding can map a form straight
// in", and a dedicated table would need a migration every time the wizard
// changes shape — which, for a wizard, is every week for a while.
//
// RESUMABLE BY CONSTRUCTION. People abandon forms and come back, especially one
// that asks for a price list. The wizard reads this and lands on the first step
// that is not done.
// =============================================================================

import type { PlanTierKey } from "@/lib/entitlements";

export type BusinessType = "service" | "ecommerce";

export type StepKey =
  | "basics"
  | "website"
  | "services"
  | "store"
  | "number"
  | "behaviour"
  | "done";

export type StepState = {
  done?: boolean;
  skipped?: boolean;
  at?: string;
};

export type OnboardingState = {
  started_at?: string;
  completed_at?: string | null;
  steps?: Partial<Record<StepKey, StepState>>;
};

export type StepDef = {
  key: StepKey;
  title: string;
  /** One line under the heading. Says what this step is for, not what it is. */
  blurb: string;
  /**
   * Which archetypes see this step. The whole point of asking at signup: a
   * service client shown the store step will either skip it in confusion or,
   * worse, fill it in — and `provisionVoice` refuses to provision a client with
   * `store_platform` set but no credentials, parking them at needs_human for a
   * feature they do not use.
   */
  appliesTo: BusinessType[];
  /**
   * Blocking steps gate go-live. A client who skips one sits on
   * "Setting up your plan…" — so the list is deliberately short, and each entry
   * has a reason the client would accept if asked.
   */
  blocking: boolean;
  /** Steps the client cannot complete themselves yet. Shown, not asked. */
  informational?: boolean;
};

export const STEPS: StepDef[] = [
  {
    key: "basics",
    title: "Business basics",
    blurb: "Your timezone and opening hours, so bookings land when you're open.",
    appliesTo: ["service", "ecommerce"],
    // Without hours the availability engine offers slots while they are shut,
    // and the customer finds out by turning up to a locked door.
    blocking: true,
  },
  {
    key: "website",
    title: "Your website",
    blurb: "We read your public pages so Lumi knows your business before its first call.",
    appliesTo: ["service", "ecommerce"],
    blocking: false,
  },
  {
    key: "services",
    title: "Services and prices",
    blurb: "What you do and what it costs. This is what Lumi quotes from.",
    appliesTo: ["service"],
    // "How much" is the most common question on the line. An agent with no
    // price list cannot answer the thing people actually call to ask.
    blocking: true,
  },
  {
    key: "store",
    title: "Connect your store",
    blurb: "So Lumi can answer questions about orders.",
    appliesTo: ["ecommerce"],
    blocking: false,
    // Deferred: there is nowhere safe to put an API key yet. See the step body.
    informational: true,
  },
  {
    key: "number",
    title: "Your phone number",
    blurb: "The number your customers will call.",
    appliesTo: ["service", "ecommerce"],
    blocking: true,
    // Numbers are bought by hand on Twilio today, so this step reports status
    // rather than collecting anything.
    informational: true,
  },
  {
    key: "behaviour",
    title: "How Lumi should sound",
    blurb: "Its greeting, and anything it should always or never say.",
    appliesTo: ["service", "ecommerce"],
    blocking: false,
  },
];

/** The steps this client actually sees, in order. */
export function stepsFor(businessType: BusinessType | null): StepDef[] {
  // An unknown archetype (a pre-0034 client, or a SQL-seeded one) gets every
  // step rather than none. Showing one extra question beats hiding the price
  // list from an HVAC company and leaving their agent unable to quote.
  if (!businessType) return STEPS;
  return STEPS.filter((s) => s.appliesTo.includes(businessType));
}

export function readOnboarding(settings: unknown): OnboardingState {
  const s = (settings ?? {}) as Record<string, unknown>;
  const o = (s.onboarding ?? {}) as OnboardingState;
  return { started_at: o.started_at, completed_at: o.completed_at ?? null, steps: o.steps ?? {} };
}

export function isStepDone(state: OnboardingState, key: StepKey): boolean {
  const s = state.steps?.[key];
  return Boolean(s?.done || s?.skipped);
}

/**
 * Where to land someone who opens /onboarding: the first step they have not
 * finished. Returns null when everything applicable is done.
 */
export function firstIncompleteStep(
  state: OnboardingState,
  businessType: BusinessType | null,
): StepKey | null {
  for (const step of stepsFor(businessType)) {
    if (!isStepDone(state, step.key)) return step.key;
  }
  return null;
}

export function progress(
  state: OnboardingState,
  businessType: BusinessType | null,
): { done: number; total: number; percent: number } {
  const steps = stepsFor(businessType);
  const done = steps.filter((s) => isStepDone(state, s.key)).length;
  return {
    done,
    total: steps.length,
    percent: steps.length === 0 ? 100 : Math.round((done / steps.length) * 100),
  };
}

/**
 * Blocking steps still outstanding — what actually stands between this client
 * and a phone that rings. Drives the "you're not live yet, here's why" panel,
 * which exists so nobody sits on "Setting up your plan…" without being told the
 * cause.
 */
export function blockingRemaining(
  state: OnboardingState,
  businessType: BusinessType | null,
): StepDef[] {
  return stepsFor(businessType).filter(
    (s) => s.blocking && !isStepDone(state, s.key),
  );
}

/** Merge one step's completion into the settings blob, preserving siblings. */
export function withStepDone(
  settings: Record<string, unknown> | null,
  key: StepKey,
  opts: { skipped?: boolean } = {},
): Record<string, unknown> {
  const base = settings ?? {};
  const current = readOnboarding(base);
  const now = new Date().toISOString();

  return {
    ...base,
    onboarding: {
      ...current,
      started_at: current.started_at ?? now,
      steps: {
        ...(current.steps ?? {}),
        [key]: { done: !opts.skipped, skipped: Boolean(opts.skipped), at: now },
      },
    },
  };
}

/** Human label for a tier, for the wizard header. */
export function tierLabel(tier: PlanTierKey | string | null): string {
  if (!tier) return "your plan";
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export const WEEKDAYS = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
] as const;

/**
 * A short, sane timezone list. Deliberately not the full IANA set — a
 * 400-entry dropdown gets scrolled past and left on whatever was first, and a
 * wrong timezone books real customers into hours the business is shut. "Other"
 * is handled by an operator rather than by making everyone scroll.
 */
export const COMMON_TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Phoenix",
  "America/Chicago",
  "America/New_York",
  "America/Anchorage",
  "Pacific/Honolulu",
] as const;
