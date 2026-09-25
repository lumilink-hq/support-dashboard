import Link from "next/link";
import { AddonToggle } from "@/components/billing/addon-toggle";
import { ManageBillingButton } from "@/components/billing/manage-billing-button";
import { SeoCheckoutForm } from "@/components/billing/seo-checkout-form";
import { availableAddons } from "@/lib/addons";
import { formatDateTime } from "@/lib/format";
import { readProfile } from "@/lib/onboarding";
import { createClient } from "@/lib/supabase/server";
import {
  activeAddonsForClient,
  hasStripeCustomerForClient,
  seoSubscriptionForClient,
} from "@/lib/services/billing";
import { addProductHref } from "@/lib/catalog";
import { availableSeoPlans, isSeoCheckoutConfigured, SEO_PLANS, seoPlanByKey } from "@/lib/seo-pricing";
import {
  FEATURES,
  OVERAGE,
  PLAN_TIERS,
  STARTER_PLAN,
  entitlementsEnforced,
  featureState,
  getCurrentClientId,
  getEntitlements,
  getVoiceUsage,
  overageEstimate,
  type FeatureState,
  type VoiceUsage,
} from "@/lib/entitlements";

// Minutes used vs the plan allowance. Since the allowance became a HARD CAP
// (no metered overage), the job of this meter changed: it is no longer a
// warning about a coming charge, it is a warning that the line will STOP
// ANSWERING. That is the more urgent fact, so it warns from 80%.
function UsageMeter({ usage }: { usage: VoiceUsage }) {
  const cap = usage.minutes_cap;
  const unlimited = cap === null || cap < 0;
  const pct = unlimited
    ? 0
    : Math.min(Math.round((usage.minutes_used / Math.max(cap, 1)) * 100), 100);
  const { overMinutes } = overageEstimate(usage);
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

      {/*
        HARD CAP, NOT OVERAGE (2026-08-13). This used to show an estimated
        overage charge at $0.30/min. We no longer bill for going over, so the
        useful message is the opposite one: your line has stopped answering, and
        here is how to start it again. Quoting a charge we don't levy would
        contradict /legal/terms and frighten a customer about their own phone.
      */}
      {overMinutes > 0 ? (
        <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          You&rsquo;ve used your full allowance for this month, so new calls
          aren&rsquo;t being answered. You won&rsquo;t be charged for the
          overage &mdash; move up a plan to start answering again.
        </p>
      ) : pct >= 80 && !unlimited ? (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
          You&rsquo;re at {pct}% of this month&rsquo;s allowance. At 100% the
          agent stops answering until your next period &mdash; there&rsquo;s no
          overage charge, so upgrading is the only thing that changes it.
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

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { checkout } = await searchParams;

  // Add-on ownership (below) is a live Stripe read keyed by client_id, unlike
  // getEntitlements()/getVoiceUsage() which are RLS-scoped with no parameter —
  // so clientId has to resolve first, not join the same Promise.all.
  const clientId = await getCurrentClientId();
  const supabase = await createClient();
  const [ent, usage, activeAddons, hasStripeCustomer, clientRow, seoLocationCount] = await Promise.all([
    getEntitlements(),
    getVoiceUsage(),
    clientId ? activeAddonsForClient(clientId) : Promise.resolve([]),
    clientId ? hasStripeCustomerForClient(clientId) : Promise.resolve(false),
    supabase.from("clients").select("business_type, products").maybeSingle(),
    supabase.from("seo_locations").select("id", { count: "exact", head: true }),
  ]);
  const activeAddonKeys = new Set(activeAddons.map((a) => a.key));
  const seoEntitlement = ent.seo;
  const seoState = featureState(seoEntitlement);
  // Whether the workspace has set up SEO (clients.products, 0059) or already
  // holds an SEO entitlement (e.g. one granted by hand). The section below is
  // shown to everyone; a workspace that hasn't set SEO up yet sees the plans
  // and a link to set it up rather than the checkout form, because checkout
  // quotes against the locations that setup collects.
  const isSeoClient =
    readProfile(clientRow.data).products.includes("seo") || seoState !== "locked";
  // Which plan they're on, read live from Stripe (like add-ons). null for a
  // hand-granted entitlement with no subscription, or a PACKS/enterprise one.
  const seoSub =
    clientId && (seoState === "active" || seoState === "past_due")
      ? await seoSubscriptionForClient(clientId).catch(() => null)
      : null;
  const seoPlanName = seoSub?.plan ? seoPlanByKey(seoSub.plan).name : null;

  return (
    <div className="max-w-4xl">
      <h1 className="text-lg font-semibold text-gray-900">Plans &amp; billing</h1>
      <p className="mt-1 text-sm text-gray-500">
        Turn features on for your workspace. Unlock a plan and it&rsquo;s set up
        automatically.
      </p>
      {checkout === "canceled" ? (
        <div className="mt-4 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
          Checkout canceled — nothing was charged.
        </div>
      ) : null}

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

      {/* ------------------------------------------------------------------ */}
      {/* Local SEO — deliberately NOT in the FEATURES loop above. Every card */}
      {/* there routes a "sellable" checkout through /plans, the VOICE tier   */}
      {/* picker (see that loop's own comment) — SEO has its own plans       */}
      {/* (lib/seo-pricing.ts), some with a location quantity, so it needs   */}
      {/* its own section and its own checkout route                         */}
      {/* (/api/billing/seo-checkout, module 12).                            */}
      {/* ------------------------------------------------------------------ */}
      {/* id="seo": the sidebar's "Add Local SEO" row links to /billing#seo */}
      {/* (addProductHref in lib/catalog.ts). */}
      <div id="seo" className="mt-10 max-w-md scroll-mt-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-900">SEO + AI Search</h2>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${PILL[seoState]}`}
          >
            {PILL_LABEL[seoState]}
          </span>
        </div>
        <p className="mt-1 text-sm text-gray-600">
          Website SEO, Local SEO for your Google Business Profile locations,
          or both. AI Search Optimization is included with website plans.
        </p>

        {!isSeoClient ? (
          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4 text-sm">
            <ul className="space-y-1 text-gray-700">
              {SEO_PLANS.map((p) => (
                <li key={p.key} className="flex justify-between gap-3">
                  <span>{p.name}</span>
                  <span className="text-gray-500">
                    ${p.monthlyUsd.toLocaleString()}
                    {p.perLocation ? "/location/mo" : "/mo"}
                  </span>
                </li>
              ))}
            </ul>
            <Link
              href={addProductHref("seo", readProfile(clientRow.data).products)}
              className="mt-4 block w-full rounded-md bg-gray-900 px-4 py-2 text-center text-sm font-medium text-white hover:bg-gray-800"
            >
              Set up SEO
            </Link>
            <p className="mt-2 text-xs text-gray-400">
              Add your website and locations first; you pick a plan and pay
              after that.
            </p>
          </div>
        ) : !isSeoCheckoutConfigured() ? (
          <p className="mt-4 text-sm text-gray-400">
            SEO checkout isn&rsquo;t configured on this environment yet.
          </p>
        ) : seoState === "active" || seoState === "past_due" ? (
          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4 text-sm">
            {seoState === "past_due" ? (
              <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                There&rsquo;s a payment issue — please update your billing to
                avoid losing access.
              </p>
            ) : null}
            {seoPlanName ? <p className="font-medium text-gray-900">{seoPlanName}</p> : null}
            {seoSub?.plan !== "website" ? (
              <p className="text-gray-900">
                {seoEntitlement?.seat_count ?? "—"} location
                {seoEntitlement?.seat_count === 1 ? "" : "s"}
              </p>
            ) : null}
            <p className="mt-1 text-gray-500">
              {seoEntitlement?.current_period_end
                ? `Renews ${formatDateTime(seoEntitlement.current_period_end)}`
                : "Active on your workspace."}
            </p>
            <p className="mt-2 text-xs text-gray-400">
              Add or remove locations from the dashboard — billing adjusts
              automatically, prorated.
            </p>
          </div>
        ) : seoState === "setup" ? (
          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
            <button
              disabled
              className="w-full cursor-default rounded-md bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700"
            >
              Setting up your plan&hellip;
            </button>
            <p className="mt-2 text-xs text-gray-400">
              Payment received. We&rsquo;re provisioning this now.
            </p>
          </div>
        ) : (
          <div className="mt-4">
            <SeoCheckoutForm
              plans={availableSeoPlans().map((p) => p.key)}
              initialLocationCount={seoLocationCount.count ?? 0}
            />
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Add-ons — the same catalogue the post-purchase screen shows, from   */}
      {/* lib/addons.ts, so /welcome and /billing can never offer different   */}
      {/* things at different prices. Each is a line item on the client's OWN */}
      {/* subscription (lib/services/billing.ts), added/removed directly via  */}
      {/* Stripe's API — no Payment Link, no separate subscription.           */}
      {/*                                                                    */}
      {/* availableAddons() filters out anything not safe to sell yet.       */}
      {/*                                                                    */}
      {/* OWNERSHIP is read LIVE off Stripe (activeAddonsForClient), not from */}
      {/* a local mirror — there is nothing here that can drift from what     */}
      {/* Stripe actually has.                                               */}
      {/* ------------------------------------------------------------------ */}
      {availableAddons().length > 0 ? (
        <div className="mt-10">
          <h2 className="text-base font-semibold text-gray-900">
            Build Out Your Plan
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Optional extras, billed on the same subscription. We set each one up
            for you.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {availableAddons().map((a) => {
              const active = activeAddonKeys.has(a.key);

              return (
                <div
                  key={a.key}
                  className="flex flex-col rounded-lg border border-gray-200 bg-white p-4"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-sm font-semibold text-gray-900">
                      {a.name}
                    </h3>
                    {active ? (
                      <span className="shrink-0 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                        Active
                      </span>
                    ) : (
                      <p className="shrink-0 text-sm font-medium text-gray-900">
                        ${a.monthlyUsd}
                        <span className="text-gray-500">/mo</span>
                      </p>
                    )}
                  </div>
                  <p className="mt-1 flex-1 text-xs leading-relaxed text-gray-600">
                    {a.blurb}
                  </p>
                  <div className="mt-4">
                    <AddonToggle addonKey={a.key} active={active} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {hasStripeCustomer ? (
        <div className="mt-10">
          <ManageBillingButton />
          <p className="mt-2 text-xs text-gray-500">
            Update your card, view invoices, or cancel your plan.
          </p>
        </div>
      ) : null}

      {/*
        HOW USAGE WORKS. Rewritten 2026-08-13 when overage billing was dropped
        for a hard cap. The previous version quoted $0.30/min and a one-time
        setup fee — both now false, and this is the page a customer reads to
        understand what they will be charged. A billing page that contradicts
        /legal/terms is worse than one that says nothing.
      */}
      <div className="mt-10 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <h2 className="text-sm font-medium text-gray-900">How Usage Works</h2>
        <ul className="mt-2 space-y-1 text-xs text-gray-600">
          <li>
            <strong>Your allowance is a cap, not a meter.</strong>{" "}
            We don&rsquo;t bill you for going over it. Reach it and the agent
            stops answering until your next billing period, or until you move up
            a plan.
          </li>
          <li>
            <strong>Setup is free</strong> &mdash; there is no one-time charge on
            any plan.
          </li>
          <li>
            {`AI calls are capped at ${STARTER_PLAN.maxCallMinutes} minutes.`}{" "}
            Past that, Lumi offers a transfer or logs a callback ticket &mdash;
            it never leaves a caller in a loop.
          </li>
          <li>
            Platform care beyond your included hours is quoted before any work
            starts, never billed automatically.
          </li>
          <li>
            Cancel anytime. We don&rsquo;t pro-rate the month you&rsquo;re
            already in. See{" "}
            <Link href="/legal/terms" className="underline hover:text-gray-900">
              Terms Of Service
            </Link>
            .
          </li>
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
