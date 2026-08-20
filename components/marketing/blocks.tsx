// Shared marketing building blocks.
//
// WHY THIS FILE EXISTS. There are now three public pages — the landing page and
// one per vertical (/solutions/ecommerce, /solutions/service) — and all three
// quote prices, list plans and answer the same money questions. Three copies of
// a pricing table is three chances to advertise a number the billing page
// disagrees with, which is the single cheapest way to lose money on a website.
//
// So: layout primitives and every block that touches a PRICE live here once.
// Vertical-specific copy lives in the page components. Nothing in this file
// hardcodes a number — PLAN_TIERS, STARTER_PLAN and OVERAGE all come from
// lib/entitlements.ts, which mirrors the CFO workbook.

import Link from "next/link";
import {
  guaranteedCalls,
  OVERAGE,
  PLAN_TIERS,
  STARTER_PLAN,
} from "@/lib/entitlements";
import { isSignedIn } from "@/components/marketing/shell";

/**
 * Where every primary CTA points: straight at account creation.
 *
 * The old comment here said "swap to a Cal.com/Calendly URL once booking is set
 * up". That is not the plan — we don't run discovery calls, and the buttons
 * that said "Book a discovery call" were pointing here the whole time, so the
 * label was describing a step that never existed. Renamed from DEMO_CTA to
 * SIGNUP_CTA so nothing re-adopts the booking idea from the name alone.
 */
export const SIGNUP_CTA = "/signup";

/**
 * Where a plan card should send THIS visitor.
 *
 * Signed out, the answer is signup — that's the change requested on 2026-08-13,
 * and it removes a hop for the only people who see these cards and can't check
 * out yet. `next=/plans` brings them back to the tier they were looking at.
 *
 * Signed IN, it stays /plans. A pricing card cannot become a checkout button:
 * the Stripe link has to carry client_reference_id, and only /plans reads the
 * session to supply it. Sending an existing customer to a signup form instead
 * of checkout would be a worse hop than the one we just removed.
 */
export async function planCtaHref(): Promise<string> {
  return (await isSignedIn()) ? "/plans" : "/signup?next=%2Fplans";
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function Section({
  id,
  className = "",
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`scroll-mt-16 ${className}`}>
      <div className="mx-auto max-w-6xl px-6">{children}</div>
    </section>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
      {children}
    </p>
  );
}

export function Check() {
  return (
    <span aria-hidden className="mt-0.5 shrink-0 text-green-600">
      ✓
    </span>
  );
}

/** Three-across numbered pillars. */
export function Pillars({
  items,
}: {
  items: { n: string; title: string; body: string }[];
}) {
  return (
    <div className="mt-10 grid gap-10 md:grid-cols-3">
      {items.map((p) => (
        <div key={p.n}>
          <p className="text-sm font-semibold text-gray-400">{p.n}</p>
          <h3 className="mt-2 text-lg font-semibold text-gray-900">{p.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-600">{p.body}</p>
        </div>
      ))}
    </div>
  );
}

/** Tick-listed capability grid. */
export function CapabilityGrid({
  items,
}: {
  items: { title: string; body: string }[];
}) {
  return (
    <div className="mt-12 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((c) => (
        <div key={c.title} className="flex gap-3">
          <Check />
          <div>
            <h3 className="text-sm font-semibold text-gray-900">{c.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-gray-600">{c.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blocks that quote money — the reason this file exists
// ---------------------------------------------------------------------------

/**
 * The plan ladder.
 *
 * STILL DISPLAY ONLY. No card here is ever a checkout link: the Stripe URL has
 * to carry `client_reference_id`, and only /plans reads the session to supply
 * it. A checkout button on a page that doesn't know who is clicking it is how a
 * payment ends up unroutable — see STRIPE-GO-LIVE.md §1.
 *
 * What changed 2026-08-13: the button no longer hardcodes /plans. It asks
 * planCtaHref, which sends a signed-out visitor to signup first. That makes
 * this an async server component — fine everywhere it's used (all three
 * marketing pages are server components), but it does mean this block can't be
 * dropped into a "use client" tree without being refactored back to a prop.
 */
export async function PricingGrid({
  heading = "What You Pay, And Where The Limits Are",
  blurb = "Every plan comes with a set number of calls and no setup fee. When you outgrow one, you move up a plan — we never bill you for going over.",
}: {
  heading?: string;
  blurb?: string;
}) {
  const ctaHref = await planCtaHref();

  return (
    <Section id="pricing" className="py-20">
      <div className="max-w-2xl">
        <Eyebrow>Pricing</Eyebrow>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
          {heading}
        </h2>
        <p className="mt-3 text-gray-600">{blurb}</p>
      </div>

      <div className="mt-12 grid gap-6 lg:grid-cols-3">
        {PLAN_TIERS.map((tier) => (
          <div
            key={tier.label}
            className={`flex flex-col rounded-xl bg-white p-6 shadow-sm ${
              tier.mostPopular
                ? "border-2 border-gray-900"
                : "border border-gray-200"
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-gray-900">
                {tier.label}
              </h3>
              {tier.mostPopular ? (
                <span className="shrink-0 rounded-full bg-gray-900 px-2.5 py-0.5 text-xs font-medium text-white">
                  Most Popular
                </span>
              ) : null}
            </div>

            <p className="mt-4">
              <span className="text-4xl font-semibold tracking-tight text-gray-900">
                ${tier.monthlyUsd}
              </span>
              <span className="text-sm text-gray-500">/month</span>
            </p>
            <p className="mt-1 text-sm font-medium text-green-700">
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

            <Link
              href={ctaHref}
              className={`block rounded-md px-4 py-2.5 text-center text-sm font-medium ${
                tier.mostPopular
                  ? "bg-gray-900 text-white hover:bg-gray-800"
                  : "border border-gray-300 text-gray-700 hover:bg-gray-50"
              }`}
            >
              Get Started
            </Link>
          </div>
        ))}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* What's not included — HIDDEN. Moved here from landing.tsx when the  */}
      {/* pricing block was shared, so it stays attached to the prices.       */}
      {/*                                                                    */}
      {/* Worth knowing what this removes: no marketing page states the       */}
      {/* $0.30/min overage anywhere except the FAQ. /billing still carries   */}
      {/* the full disclosure, and that is the page a customer sees before    */}
      {/* checkout, so the pre-purchase disclosure survives. If a Stripe      */}
      {/* Payment Link is ever linked straight from a marketing page,         */}
      {/* bypassing /billing, put this block back FIRST.                      */}
      {/* ------------------------------------------------------------------ */}
      {/*
      <div className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-5">
        <h3 className="text-sm font-semibold text-gray-900">
          What&rsquo;s not included
        </h3>
        <ul className="mt-2 grid gap-1.5 text-sm text-gray-600 sm:grid-cols-2">
          <li>
            Minutes above your allowance: ${OVERAGE.perVoiceMinuteUsd.toFixed(2)} per minute
          </li>
          <li>
            Platform care beyond your included hours: ${OVERAGE.perCareHourUsd} per hour
          </li>
          <li>Additional AI phone line: $19 per month</li>
          <li>Additional location: $29 per month</li>
          <li>Advanced workflow: $49 per month</li>
          <li>Managed integration: $29 per month</li>
        </ul>
        <p className="mt-3 text-xs text-gray-500">
          Minutes used are visible in your dashboard at all times. Setup fees
          are charged once. Enterprise pricing is quoted per organisation.
        </p>
      </div>
      */}
    </Section>
  );
}

/**
 * The call-length policy, stated up front rather than buried in terms.
 *
 * Kept on every vertical page deliberately: it is the limit customers actually
 * hit, and publishing it is cheaper than having it discovered.
 */
export function CallLengthPolicy({ closing }: { closing: string }) {
  return (
    <Section className="pb-20">
      <div className="rounded-2xl bg-gray-900 px-8 py-12 text-white md:px-12">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Automate The Repetitive. Escalate What Matters.
          </p>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">
            Fast Answers. Real People When It Counts.
          </h2>
          <p className="mt-4 leading-relaxed text-gray-300">
            {`Most calls are the same handful of questions, and Lumi settles them in under ${STARTER_PLAN.maxCallMinutes} minutes`}{" "}
            — which is exactly how long your customer wants to spend on the
            phone. Anything that needs judgement goes to a person instead of
            going in circles.
          </p>
          <p className="mt-3 leading-relaxed text-gray-300">{closing}</p>
        </div>
      </div>
    </Section>
  );
}

/**
 * FAQ list. Always rendered with id="faq" so the shell's "#faq" nav anchor
 * resolves on every page that uses it — an anchor that scrolls nowhere reads as
 * a broken site, and there are three pages in that nav now.
 */
export function FaqList({
  items,
  heading = "What People Ask Before Signing Up",
}: {
  items: { q: string; a: string }[];
  heading?: string;
}) {
  return (
    <Section id="faq" className="border-t border-gray-200 bg-gray-50 py-20">
      <Eyebrow>Questions</Eyebrow>
      <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
        {heading}
      </h2>

      <dl className="mt-10 grid gap-x-12 gap-y-8 md:grid-cols-2">
        {items.map((f) => (
          <div key={f.q}>
            <dt className="text-sm font-semibold text-gray-900">{f.q}</dt>
            <dd className="mt-2 text-sm leading-relaxed text-gray-600">{f.a}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export function ClosingCta({
  heading,
  body,
  // Was "Book A Discovery Call". We don't run discovery calls, and this link
  // has always gone to /signup — the label was inventing a step.
  cta = "Create Your Account",
}: {
  heading: string;
  body: string;
  cta?: string;
}) {
  return (
    <Section className="py-20">
      <div className="rounded-2xl border border-gray-200 bg-white px-8 py-14 text-center shadow-sm md:px-12">
        <h2 className="text-3xl font-semibold tracking-tight text-gray-900">
          {heading}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-gray-600">{body}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href={SIGNUP_CTA}
            className="rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white hover:bg-gray-800"
          >
            {cta}
          </Link>
          <Link
            href="/login"
            className="rounded-md border border-gray-300 px-6 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Sign in
          </Link>
        </div>
      </div>
    </Section>
  );
}

/** The overage line, shared so no page can quote a different rate. */
// HARD CAP, NOT METERED OVERAGE (2026-08-13). Deliberately says what does NOT
// happen: an unexpected usage charge is the fear that stops a small business
// putting a phone number in front of an AI, and the answer to it is "we can't
// bill you for that, because we don't bill for it at all".
//
// Still bridges the two units. We SELL calls and we METER minutes, and the one
// moment a customer meets the second unit must not be a surprise.
export const OVERAGE_ANSWER = `We don't. There's no per-minute charge and no surprise bill — your plan is a cap, not a meter. Starter covers ${guaranteedCalls(
  STARTER_PLAN.includedMinutes,
)} calls a month (${
  STARTER_PLAN.includedMinutes
} minutes of talk time), and you can see what you've used in your dashboard at any point. If you're regularly reaching it, that's a good problem — move up a plan and we'll handle the switch.`;
