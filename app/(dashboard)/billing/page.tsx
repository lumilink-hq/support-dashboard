import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import {
  FEATURES,
  OVERAGE,
  PLAN_TIERS,
  STARTER_PLAN,
  entitlementsEnforced,
  featureState,
  getEntitlements,
  getVoiceUsage,
  overageEstimate,
  type FeatureState,
  type VoiceUsage,
} from "@/lib/entitlements";

// Minutes used vs the plan allowance, with what the overage would cost. A client
// on a metered plan should see this BEFORE the $0.30/min kicks in, not on the
// invoice afterwards.
function UsageMeter({ usage }: { usage: VoiceUsage }) {
  const cap = usage.minutes_cap;
  const unlimited = cap === null || cap < 0;
  const pct = unlimited
    ? 0
    : Math.min(Math.round((usage.minutes_used / Math.max(cap, 1)) * 100), 100);
  const { overMinutes, estimatedUsd } = overageEstimate(usage);
  const bar = pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-green-600";

  return (
    <div className="mt-4 border-t border-gray-100 pt-3">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-gray-500">This month</span>
        <span className="font-medium text-gray-900">
          {usage.minutes_used} {unlimited ? "min" : `/ ${cap} min`}
        </span>
      </div>

      {!unlimited ? (
        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Voice minutes used this month"
        >
          <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
        </div>
      ) : null}

      <p className="mt-2 text-xs text-gray-400">
        {usage.calls} {usage.calls === 1 ? "call" : "calls"}
        {usage.avg_call_minutes !== null
          ? ` · ${usage.avg_call_minutes} min average`
          : null}
      </p>

      {overMinutes > 0 ? (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {overMinutes} min over your allowance &mdash; about $
          {estimatedUsd.toFixed(2)} in overage at ${OVERAGE.perVoiceMinuteUsd.toFixed(2)}/min.
        </p>
      ) : null}
    </div>
  );
}

const PILL: Record<FeatureState, string> = {
  active: "bg-green-50 text-green-700",
  past_due: "bg-amber-50 text-amber-700",
  setup: "bg-blue-50 text-blue-700",
  canceled: "bg-gray-100 text-gray-500",
  locked: "bg-gray-100 text-gray-500",
};

const PILL_LABEL: Record<FeatureState, string> = {
  active: "Active",
  past_due: "Past due",
  setup: "Setting up",
  canceled: "Canceled",
  locked: "Not on your plan",
};

export default async function BillingPage() {
  // client_reference_id is stamped on /plans now, where the tier is chosen, so
  // this page no longer needs the tenant id to build a checkout URL.
  const [ent, usage] = await Promise.all([getEntitlements(), getVoiceUsage()]);

  return (
    <div className="max-w-4xl">
      <h1 className="text-lg font-semibold text-gray-900">Plans &amp; billing</h1>
      <p className="mt-1 text-sm text-gray-500">
        Turn features on for your workspace. Unlock a plan and it&rsquo;s set up
        automatically.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {FEATURES.map((f) => {
          const row = ent[f.key];
          const state = featureState(row);
          // A feature that isn't sold separately never shows a checkout button.
          const sellable = f.price !== null;

          // WHY THIS NO LONGER LINKS STRAIGHT TO STRIPE.
          //
          // This button used to be checkoutUrl('voice', clientId) — one URL,
          // pointing at the Starter Payment Link, because Starter was the only
          // tier anyone could buy. Now that Growth and Scale are self-serve,
          // there are three links and this card has no way to ask which one the
          // customer wants. Keeping the direct link would mean a customer who
          // came here for Scale is charged $179 and provisioned 100 minutes,
          // with a correct-looking receipt.
          //
          // /plans is where the choice is made, and it stamps
          // client_reference_id on whichever tier they pick — so routing
          // through it loses nothing. The pre-flight in docs/STRIPE-GO-LIVE.md
          // §5 ("copy the link address of the Unlock button") now applies to
          // the buttons on /plans instead.
          const cheapest = Math.min(...PLAN_TIERS.map((t) => t.monthlyUsd));

          return (
            <div
              key={f.key}
              className="flex flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-gray-900">
                    {f.label}
                  </h2>
                  <p className="text-sm text-gray-500">{f.tagline}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${PILL[state]}`}
                >
                  {PILL_LABEL[state]}
                </span>
              </div>

              <p className="mt-3 text-sm text-gray-600">{f.blurb}</p>

              <ul className="mt-3 space-y-1.5">
                {f.bullets.map((b) => (
                  <li
                    key={b}
                    className="flex items-start gap-2 text-sm text-gray-700"
                  >
                    <span aria-hidden className="mt-0.5 text-green-600">
                      ✓
                    </span>
                    {b}
                  </li>
                ))}
              </ul>

              {f.key === "voice" && usage ? <UsageMeter usage={usage} /> : null}

              <div className="mt-4 flex-1" />

              {state === "active" || state === "past_due" ? (
                <div className="border-t border-gray-100 pt-3 text-sm">
                  {state === "past_due" ? (
                    <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      There&rsquo;s a payment issue &mdash; please update your
                      billing to avoid losing access.
                    </p>
                  ) : null}
                  <p className="text-gray-500">
                    {row?.current_period_end
                      ? `Renews ${formatDateTime(row.current_period_end)}`
                      : "Active on your workspace."}
                  </p>
                </div>
              ) : state === "setup" ? (
                <div className="border-t border-gray-100 pt-3">
                  <button
                    disabled
                    className="w-full cursor-default rounded-md bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700"
                  >
                    Setting up your plan&hellip;
                  </button>
                  <p className="mt-2 text-xs text-gray-400">
                    Payment received. We&rsquo;re provisioning this now &mdash;
                    it unlocks automatically, usually within a few minutes.
                  </p>
                </div>
              ) : !sellable ? (
                <div className="border-t border-gray-100 pt-3">
                  <p className="text-sm font-medium text-gray-900">
                    Included with your plan
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    Not billed separately. Talk to us to switch it on for your
                    workspace.
                  </p>
                </div>
              ) : (
                <div className="border-t border-gray-100 pt-3">
                  <p className="text-sm font-medium text-gray-900">
                    From ${cheapest}/mo
                  </p>
                  <p className="text-xs text-gray-500">
                    {PLAN_TIERS.length} plans, from{" "}
                    {PLAN_TIERS[0].includedMinutes} to{" "}
                    {PLAN_TIERS[PLAN_TIERS.length - 1].includedMinutes} minutes
                    a month
                  </p>
                  <Link
                    href="/plans"
                    className="mt-3 block w-full rounded-md bg-gray-900 px-4 py-2 text-center text-sm font-medium text-white hover:bg-gray-800"
                  >
                    {state === "canceled" ? "Reactivate a plan" : "Choose a plan"}
                  </Link>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/*
        Overage terms must be visible BEFORE checkout, not only in the invoice.
        Undisclosed usage billing on a $179 plan is how chargebacks happen.
      */}
      <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <h2 className="text-sm font-medium text-gray-900">
          How usage is billed
        </h2>
        <ul className="mt-2 space-y-1 text-xs text-gray-600">
          <li>
            Voice minutes above your plan allowance are billed at $
            {OVERAGE.perVoiceMinuteUsd.toFixed(2)} per minute.
          </li>
          <li>
            Platform care beyond the included pool is billed at $
            {OVERAGE.perCareHourUsd}/hour.
          </li>
          <li>
            AI calls are capped at {STARTER_PLAN.maxCallMinutes} minutes. Past
            that, Lumi offers a transfer or logs a callback ticket &mdash; it
            never leaves a caller in a loop.
          </li>
          <li>Setup fees are one-time and charged when you start.</li>
        </ul>
      </div>

      {!entitlementsEnforced() ? (
        <p className="mt-6 text-xs text-gray-400">
          Feature access is currently open for all workspaces during rollout.
        </p>
      ) : null}
    </div>
  );
}
