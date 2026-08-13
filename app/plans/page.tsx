// "/plans" — the public acquisition page.
//
//   Homepage -> Plans -> pick Starter -> sign in -> Stripe
//   Already signed in? Straight to Stripe.
//
// WHY THIS IS PUBLIC BUT CHECKOUT IS NOT. The Stripe link has to carry
// client_reference_id, and only an authenticated request knows which tenant that
// is. Every payment made before we started appending it parked as 'unmapped'
// with nothing granted. So anyone may READ this page; the button only becomes a
// checkout link once we know who is clicking it.
//
// This is also why the marketing site can live on Wix but this page cannot: a
// CMS has no session, so a checkout button it renders can never name the buyer.
//
// /billing keeps plan MANAGEMENT for existing subscribers — usage against the
// allowance, renewal date, past-due banner. That is a dashboard concern. This
// page is for buying.

import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/shell";
import {
  OVERAGE,
  PLAN_TIERS,
  featureState,
  getCurrentClientId,
  getEntitlements,
  isUsable,
  tierCheckoutUrl,
} from "@/lib/entitlements";

export const metadata: Metadata = {
  title: "Plans and pricing | Lumilink",
  description:
    "Lumilink plans start at $179 a month with 100 included minutes. Fixed allowances, published overage rates, no fair-use clause.",
};

function Check() {
  return (
    <span aria-hidden className="mt-0.5 shrink-0 text-green-600">
      ✓
    </span>
  );
}

export default async function PlansPage() {
  // A signed-out visitor must still get the page. Supabase being unreachable
  // should cost us the personalised CTA, not the pricing page.
  let clientId: string | null = null;
  let alreadySubscribed = false;
  try {
    clientId = await getCurrentClientId();
    if (clientId) {
      const ent = await getEntitlements();
      alreadySubscribed = isUsable(featureState(ent.voice));
    }
  } catch {
    clientId = null;
  }

  const signedIn = Boolean(clientId);

  return (
    <MarketingShell>
      <section className="mx-auto max-w-6xl px-6 pb-20 pt-16">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Plans
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900">
            What you pay, and where the limits are
          </h1>
          <p className="mt-3 text-lg text-gray-600">
            Every plan has a fixed minute allowance. We&rsquo;d rather give you
            the number than call it unlimited and add a fair-use clause.
          </p>
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {PLAN_TIERS.map((tier) => {
            // Featured styling follows the RECOMMENDATION, not purchasability.
            // These were the same flag while Starter was the only tier with a
            // Payment Link; now that all three are self-serve, reusing
            // `selfServe` here would badge every card "Most popular".
            const featured = tier.mostPopular;

            // Each tier has its OWN Payment Link — the plan price and its setup
            // fee are line items on the link, so one link cannot serve three
            // plans. Resolved per card rather than once above, and an unset
            // variable disables that card's button instead of falling through
            // to another tier's link.
            const checkout = tierCheckoutUrl(tier.key, clientId);

            return (
              <div
                key={tier.label}
                className={`flex flex-col rounded-xl bg-white p-6 shadow-sm ${
                  featured
                    ? "border-2 border-gray-900"
                    : "border border-gray-200"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold text-gray-900">
                    {tier.label}
                  </h2>
                  {featured ? (
                    <span className="shrink-0 rounded-full bg-gray-900 px-2.5 py-0.5 text-xs font-medium text-white">
                      Most popular
                    </span>
                  ) : null}
                </div>

                <p className="mt-4">
                  <span className="text-4xl font-semibold tracking-tight text-gray-900">
                    ${tier.monthlyUsd}
                  </span>
                  <span className="text-sm text-gray-500">/month</span>
                </p>
                <p className="mt-1 text-sm text-gray-500">
                  {tier.setupFeeUsd > 0
                    ? `+ $${tier.setupFeeUsd} one-time setup`
                    : "Setup Is On Us — $0"}
                </p>

                <ul className="mt-6 space-y-2">
                  {tier.highlights.map((h) => (
                    <li key={h} className="flex gap-2 text-sm text-gray-700">
                      <Check />
                      {h}
                    </li>
                  ))}
                </ul>

                <div className="mt-6 flex-1" />

                {/*
                  Four states, in the order they're checked:
                    already paying   -> send them to manage it, not buy again
                    self-serve + in  -> real checkout link carrying the tenant
                    self-serve + out -> sign in first, then come back here
                    everything else  -> link not configured, button disabled

                  The last branch used to read "Talk to us" and point at
                  /signup, because Growth and Scale genuinely had no link. They
                  do now. What remains is the CONFIGURATION case: a tier whose
                  CHECKOUT_URL_VOICE_* is unset. It must stay visibly dead
                  rather than silently borrowing another tier's link — that
                  would charge a Scale buyer $179 and provision them 100
                  minutes.
                */}
                {alreadySubscribed ? (
                  <Link
                    href="/billing"
                    className="block rounded-md border border-gray-300 px-4 py-2.5 text-center text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Manage your plan
                  </Link>
                ) : tier.selfServe && signedIn && checkout ? (
                  <a
                    href={checkout}
                    className={`block rounded-md px-4 py-2.5 text-center text-sm font-medium ${
                      featured
                        ? "bg-gray-900 text-white hover:bg-gray-800"
                        : "border border-gray-300 text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    Continue to checkout
                  </a>
                ) : tier.selfServe && !signedIn ? (
                  <Link
                    href="/login?next=%2Fplans"
                    className={`block rounded-md px-4 py-2.5 text-center text-sm font-medium ${
                      featured
                        ? "bg-gray-900 text-white hover:bg-gray-800"
                        : "border border-gray-300 text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    Get started
                  </Link>
                ) : (
                  // Signed in, but this tier's CHECKOUT_URL_VOICE_* is unset.
                  <span className="block rounded-md bg-gray-200 px-4 py-2.5 text-center text-sm font-medium text-gray-500">
                    Checkout not connected yet
                  </span>
                )}

                {tier.selfServe && !signedIn ? (
                  <p className="mt-2 text-center text-xs text-gray-400">
                    You&rsquo;ll sign in first, then go to payment.
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        {/*
          Overage terms sit inside the decision, not in a terms page nobody
          opens. A metered plan whose meter is a surprise generates chargebacks,
          and one dispute costs more than the overage it was hiding collected.
        */}
        <div className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-5">
          <h2 className="text-sm font-semibold text-gray-900">
            What&rsquo;s not included
          </h2>
          <ul className="mt-2 grid gap-1.5 text-sm text-gray-600 sm:grid-cols-2">
            <li>
              Minutes above your allowance: $
              {OVERAGE.perVoiceMinuteUsd.toFixed(2)} per minute
            </li>
            <li>
              Platform care beyond your included hours: $
              {OVERAGE.perCareHourUsd} per hour
            </li>
            <li>Additional phone number: $15 per month</li>
            <li>Additional department or routing tree: $39 per month</li>
          </ul>
          <p className="mt-3 text-xs text-gray-500">
            You can see minutes used in your dashboard at any time. Setup fees
            are charged once. Enterprise pricing is quoted per organisation.
          </p>
        </div>

        <p className="mt-8 text-sm text-gray-500">
          Every plan can be started online. You can move up a tier at any time
          and we&rsquo;ll adjust your minute allowance from the next invoice.
        </p>
      </section>
    </MarketingShell>
  );
}
