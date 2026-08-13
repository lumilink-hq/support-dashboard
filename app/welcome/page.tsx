// "/welcome" — where Stripe drops a customer after they pay.
//
// SET THIS AS THE PAYMENT LINK'S REDIRECT. Without it Stripe shows its own
// hosted "thanks for your payment" page, which is the last thing a new customer
// sees from us at the exact moment they are most engaged — and it tells them
// nothing about what happens next.
//
// THE THING THIS PAGE HAS TO SURVIVE: the redirect fires the instant the card
// clears, and the ENTITLEMENT ARRIVES BY WEBHOOK, asynchronously. There is no
// guarantee `checkout.session.completed` has been processed by the time this
// renders — usually it has, sometimes it hasn't, and on a bad day it parked as
// `unmapped`. So this page NEVER says "your plan is not active". It says
// payment received and setup underway, and reflects the entitlement once it
// exists. A customer who has just paid must never be shown a page implying
// their money went nowhere.
//
// Gated, not public: they signed up before paying, so they have a session. If
// it expired, route-access sends them to /login?next=/welcome and back here.

import type { Metadata } from "next";
import Link from "next/link";
import { availableAddons } from "@/lib/addons";
import {
  blockingRemaining,
  readOnboarding,
  type BusinessType,
} from "@/lib/onboarding";
import { getCurrentClientId } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Welcome To LumiLink",
  robots: { index: false, follow: false },
};

const STEPS = [
  {
    n: "1",
    title: "Tell Us About Your Business",
    body: "Your hours, your services and prices, and how you want Lumi to sound. Ten minutes, and it's the only part we need you for.",
  },
  {
    n: "2",
    title: "We Build And Test It",
    body: "We provision your number, load what the agent needs to know, and run it against real scenarios. You hear it before your customers do.",
  },
  {
    n: "3",
    title: "Your Line Goes Live",
    body: "Every call lands in your dashboard with a transcript, so you can read exactly what Lumi told your customer.",
  },
];

export default async function WelcomePage() {
  // Best-effort. Nothing on this page depends on it — a customer who has paid
  // sees the same reassurance either way.
  let firstIncompleteHref = "/onboarding";
  let setupOutstanding = true;
  try {
    const clientId = await getCurrentClientId();
    if (clientId) {
      const supabase = await createClient();
      const { data } = await supabase
        .from("clients")
        .select("business_type, settings")
        .eq("id", clientId)
        .maybeSingle();
      const settings = (data?.settings ?? {}) as Record<string, unknown>;
      const businessType = (data?.business_type ?? null) as BusinessType | null;
      const blocking = blockingRemaining(readOnboarding(settings), businessType);
      setupOutstanding = blocking.length > 0;
      if (blocking[0]) firstIncompleteHref = `/onboarding?step=${blocking[0].key}`;
    }
  } catch {
    // Fall through to the defaults. Never fail this page.
  }

  const addons = availableAddons();

  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      {/* ------------------------------------------------------------------ */}
      {/* Confirmation                                                       */}
      {/* ------------------------------------------------------------------ */}
      <p className="text-xs font-semibold uppercase tracking-widest text-green-700">
        Payment Received
      </p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight text-gray-900">
        You&rsquo;re In. Now We Build It.
      </h1>
      <p className="mt-4 max-w-2xl text-lg leading-relaxed text-gray-600">
        Setup is on us and it starts now. There&rsquo;s one short step on your
        side — everything after that is ours.
      </p>

      <div className="mt-8">
        <Link
          href={firstIncompleteHref}
          className="inline-block rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white hover:bg-gray-800"
        >
          {setupOutstanding ? "Start Setup" : "Go To Your Dashboard"}
        </Link>
        {setupOutstanding ? (
          <p className="mt-3 text-sm text-gray-500">
            Takes about ten minutes. You can stop and come back to it.
          </p>
        ) : null}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* What happens next                                                  */}
      {/* ------------------------------------------------------------------ */}
      <section className="mt-16 border-t border-gray-200 pt-12">
        <h2 className="text-xl font-semibold text-gray-900">
          What Happens Next
        </h2>
        <div className="mt-8 grid gap-8 md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n}>
              <span className="grid h-8 w-8 place-items-center rounded-full bg-gray-900 text-sm font-semibold text-white">
                {s.n}
              </span>
              <h3 className="mt-4 text-base font-semibold text-gray-900">
                {s.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Finalise your plan — the add-on ask that belongs AFTER the sale.    */}
      {/*                                                                    */}
      {/* Deliberately placed below "what happens next": the customer has     */}
      {/* just paid, and leading with another purchase reads as a shakedown.  */}
      {/* Framed as building out something they already own, and every item   */}
      {/* is skippable without a dead end — the page has no "no thanks"       */}
      {/* button because nothing here is a gate.                              */}
      {/* ------------------------------------------------------------------ */}
      {addons.length > 0 ? (
        <section className="mt-16 border-t border-gray-200 pt-12">
          <h2 className="text-xl font-semibold text-gray-900">
            Finalise Your Plan
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-gray-600">
            Optional, and none of it is needed to go live. Most people add these
            later once they can see what their calls actually look like — which
            is a good reason to wait, not a reason to hide them.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {addons.map((a) => (
              <div
                key={a.key}
                className="flex flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-sm"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-base font-semibold text-gray-900">
                    {a.name}
                  </h3>
                  <p className="shrink-0 text-sm font-medium text-gray-900">
                    ${a.monthlyUsd}
                    <span className="text-gray-500">/mo</span>
                  </p>
                </div>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-gray-600">
                  {a.blurb}
                </p>
                <a
                  href={a.url}
                  className="mt-5 block rounded-md border border-gray-300 px-4 py-2 text-center text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Add To Plan
                </a>
              </div>
            ))}
          </div>

          <p className="mt-6 text-sm text-gray-500">
            Not sure? Leave it. You can add any of these from{" "}
            <Link href="/billing" className="underline hover:text-gray-900">
              Plans &amp; Billing
            </Link>{" "}
            whenever you like, and we&rsquo;ll set it up for you.
          </p>
        </section>
      ) : null}
    </div>
  );
}
