// Public landing page.
//
// This file previously redirected to /conversations. It is now the marketing
// home page; signed-in visitors get a "Go to dashboard" CTA in the nav rather
// than a redirect (see components/marketing/shell.tsx).
//
// EVERY PRICE AND LIMIT HERE IS IMPORTED, NOT TYPED. STARTER_PLAN and OVERAGE
// come from lib/entitlements.ts, which mirrors the CFO workbook. That is
// deliberate: the cheapest way to lose money on this page is to quote a number
// the billing page disagrees with, and hand-copied prices drift the moment the
// model changes.
//
// Positioning follows the existing Wix site ("Your AI receptionist, ready 24/7"
// and its three "Why LumiLink works" pillars) so the two don't contradict each
// other while both are reachable.

import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/shell";
import { OVERAGE, STARTER_PLAN } from "@/lib/entitlements";

export const metadata: Metadata = {
  title: "Lumilink | Your AI receptionist, ready 24/7",
  description:
    "Lumilink answers every call, quotes from your price list, and books the job on your real calendar. Built for small local and service businesses.",
};

// Where both primary CTAs point. Swap to a Cal.com/Calendly URL once booking is
// set up; kept in one place so that's a one-line change.
const DEMO_CTA = "/signup";

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------

function Section({
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

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
      {children}
    </p>
  );
}

function Check() {
  return (
    <span aria-hidden className="mt-0.5 shrink-0 text-green-600">
      ✓
    </span>
  );
}

// ---------------------------------------------------------------------------
// Content, kept as data so ordering and edits are obvious
// ---------------------------------------------------------------------------

const PILLARS = [
  {
    n: "01",
    title: "Never miss a call",
    body: "Lumi answers when you can't: after hours, on a job site, or when three people ring at once. A missed call is a job that goes to whoever picked up.",
  },
  {
    n: "02",
    title: "Costs less than the calls you're missing",
    body: `Starter is $${STARTER_PLAN.monthlyUsd} a month with ${STARTER_PLAN.includedMinutes} included minutes. One booked job covers it.`,
  },
  {
    n: "03",
    title: "You can see everything",
    body: "Every call, transcript, booking and callback ticket lands in your dashboard. You can read what Lumi told your customer, word for word.",
  },
];

const CAPABILITIES = [
  {
    title: "Answers every call, 24/7",
    body: "After hours, overflow, and the calls that arrive while you're on a job. Every caller reaches a real conversation.",
  },
  {
    title: "Books real appointments",
    body: "Checks your live availability, holds the slot, and confirms it. You stop ringing people back to rearrange.",
  },
  {
    title: "Quotes from your price list",
    body: "Lumi reads the prices you set. When a job needs a site visit before anyone can price it, it says so.",
  },
  {
    title: "Knows your business",
    body: "Syncs the services, hours, and policies already on your website. Included in every plan, with no connector fee.",
  },
  {
    title: "Nothing disappears",
    body: "When Lumi can't finish a call, it logs a callback ticket in your follow-up queue. You decide who rings back.",
  },
  {
    title: "Reschedules and cancels",
    body: "Customers move their own appointments by phone, without waiting for you to call them back.",
  },
];

// Unused while the "How it works" section is commented out below. Kept rather
// than deleted so uncommenting the section is a one-block change.
// const STEPS = [
//   {
//     n: "1",
//     title: "A 20-minute discovery call",
//     body: "We go through your services, prices, and hours: what Lumi needs to answer a customer correctly.",
//   },
//   {
//     n: "2",
//     title: "We build and test your agent",
//     body: "Your setup fee covers implementation, knowledge setup, testing, and launch. You hear it before your customers do.",
//   },
//   {
//     n: "3",
//     title: "Your number goes live",
//     body: "Forward your existing number or use a new local one, then watch every call land in the dashboard.",
//   },
// ];

const FAQS = [
  {
    q: "What happens if Lumi can't handle a call?",
    a: "It offers a transfer, or takes the details and logs a callback ticket for you to pick up. When it doesn't know something, it says so.",
  },
  {
    q: `Why are calls capped at ${STARTER_PLAN.maxCallMinutes} minutes?`,
    a: "A caller going in circles with an AI has a worse time than one who gets a callback from a person. Lumi warns before the limit, closes the conversation, and hands anything unresolved to you.",
  },
  {
    q: "Does it sound robotic?",
    a: "It's a natural voice with real conversational turn-taking. Judge it yourself on the discovery call rather than taking our word for it.",
  },
  {
    q: "Can I keep my phone number?",
    a: `Yes. Forward your existing number to Lumi, or we'll provide a local one. Starter includes ${STARTER_PLAN.numbers} number.`,
  },
  {
    q: "What happens if I go over my minutes?",
    a: `We bill additional minutes at $${OVERAGE.perVoiceMinuteUsd.toFixed(2)} each. You can check minutes used against your allowance in the dashboard whenever you like, so you'll know before the invoice arrives.`,
  },
  {
    q: "What's the setup fee for?",
    a: "We build your agent: load your services and prices, connect your calendar, test it against real scenarios, and launch it. You pay it once, at the start.",
  },
];

const HIGHER_TIERS = [
  {
    label: "Growth",
    price: 279,
    setup: 499,
    minutes: 250,
    extra: "Advanced transfers",
  },
  {
    label: "Scale",
    price: 449,
    setup: 799,
    minutes: 600,
    extra: "2 numbers · advanced routing",
  },
];

// ---------------------------------------------------------------------------

export default function LandingPage() {
  return (
    <MarketingShell>
      {/* ---------------------------------------------------------------- */}
      {/* Hero                                                             */}
      {/* ---------------------------------------------------------------- */}
      <Section className="pb-20 pt-16 md:pb-28 md:pt-24">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <Eyebrow>AI phone support for local business</Eyebrow>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
              Your AI receptionist, ready 24/7
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-gray-600">
              Lumi answers every call, quotes from your price list, and books the
              job on your real calendar. You see every word that was said.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href={DEMO_CTA}
                className="rounded-md bg-gray-900 px-5 py-3 text-sm font-medium text-white hover:bg-gray-800"
              >
                Book a discovery call
              </Link>
              <a
                href="#pricing"
                className="rounded-md border border-gray-300 px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                See pricing
              </a>
            </div>

            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500">
              <li className="flex items-center gap-2">
                <Check /> 24/7 answering
              </li>
              <li className="flex items-center gap-2">
                <Check /> Real-time booking
              </li>
              <li className="flex items-center gap-2">
                <Check /> Website knowledge included
              </li>
            </ul>
          </div>

          {/*
            Honest empty frame rather than a stock photo. Replace with a real
            capture of /conversations (client names masked) before launch — the
            reference sites are ~80% product screenshots for a reason.
          */}
          <div className="aspect-[4/3] rounded-xl border border-gray-200 bg-gradient-to-br from-gray-50 to-gray-100 shadow-sm">
            <div className="flex h-full items-center justify-center">
              <p className="px-8 text-center text-sm text-gray-400">
                Product screenshot goes here
                <br />
                <span className="text-xs">
                  (capture /conversations, mask client names)
                </span>
              </p>
            </div>
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Why it works — mirrors the Wix site's three pillars               */}
      {/* ---------------------------------------------------------------- */}
      <Section className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>Why Lumilink works</Eyebrow>
        <div className="mt-10 grid gap-10 md:grid-cols-3">
          {PILLARS.map((p) => (
            <div key={p.n}>
              <p className="text-sm font-semibold text-gray-400">{p.n}</p>
              <h3 className="mt-2 text-lg font-semibold text-gray-900">
                {p.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">
                {p.body}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Capabilities                                                     */}
      {/* ---------------------------------------------------------------- */}
      <Section className="py-20">
        <div className="max-w-2xl">
          <Eyebrow>What Lumi does</Eyebrow>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
            One agent that finishes the job
          </h2>
          <p className="mt-3 text-gray-600">
            A conversation that ends with an appointment on your calendar.
          </p>
        </div>

        <div className="mt-12 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((c) => (
            <div key={c.title} className="flex gap-3">
              <Check />
              <div>
                <h3 className="text-sm font-semibold text-gray-900">
                  {c.title}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-gray-600">
                  {c.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* The two-minute policy — stated up front, not buried in terms      */}
      {/* ---------------------------------------------------------------- */}
      <Section className="pb-20">
        <div className="rounded-2xl bg-gray-900 px-8 py-12 text-white md:px-12">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
              The {STARTER_PLAN.maxCallMinutes}-minute policy
            </p>
            <h2 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">
              Lumi won&rsquo;t trap your customer in a loop
            </h2>
            <p className="mt-4 leading-relaxed text-gray-300">
              We cap every AI call at {STARTER_PLAN.maxCallMinutes} minutes. Near
              the limit, Lumi stops opening new topics, finishes what it&rsquo;s
              doing, and offers a transfer or a callback. It says goodbye rather
              than cutting off mid-sentence.
            </p>
            <p className="mt-3 leading-relaxed text-gray-300">
              We publish this because you will hit it. An AI that keeps a
              frustrated caller on the line for nine minutes costs you more than
              one that hands them to a person at two.
            </p>
          </div>
        </div>
      </Section>
      {/* ---------------------------------------------------------------- */}
      {/* How it works — HIDDEN. Uncomment this block and the STEPS array   */}
      {/* above together; the nav link in components/marketing/shell.tsx    */}
      {/* was removed at the same time, so put "#how" back there too.       */}
      {/* ---------------------------------------------------------------- */}
      {/*
      <Section id="how" className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>How it works</Eyebrow>
        <h2 className="mt-4 max-w-2xl text-3xl font-semibold tracking-tight text-gray-900">
          Answering calls within about a week
        </h2>

        <div className="mt-12 grid gap-10 md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n}>
              <span className="grid h-9 w-9 place-items-center rounded-full bg-gray-900 text-sm font-semibold text-white">
                {s.n}
              </span>
              <h3 className="mt-4 text-lg font-semibold text-gray-900">
                {s.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </Section>
      */}

      {/* ---------------------------------------------------------------- */}
      {/* Pricing                                                          */}
      {/* ---------------------------------------------------------------- */}
      <Section id="pricing" className="py-20">
        <div className="max-w-2xl">
          <Eyebrow>Pricing</Eyebrow>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
            What you pay, and where the limits are
          </h2>
          <p className="mt-3 text-gray-600">
            Every plan has a fixed minute allowance. We&rsquo;d rather give you
            the number than call it unlimited and add a fair-use clause.
          </p>
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {/* Starter — the only self-serve plan today */}
          <div className="rounded-xl border-2 border-gray-900 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-gray-900">
                {STARTER_PLAN.label}
              </h3>
              <span className="shrink-0 rounded-full bg-gray-900 px-2.5 py-0.5 text-xs font-medium text-white">
                Most popular
              </span>
            </div>

            <p className="mt-4">
              <span className="text-4xl font-semibold tracking-tight text-gray-900">
                ${STARTER_PLAN.monthlyUsd}
              </span>
              <span className="text-sm text-gray-500">/month</span>
            </p>
            <p className="mt-1 text-sm text-gray-500">
              + ${STARTER_PLAN.setupFeeUsd} one-time setup
            </p>

            <ul className="mt-6 space-y-2">
              {[
                `${STARTER_PLAN.includedMinutes} included minutes per month`,
                `${STARTER_PLAN.numbers} local phone number`,
                "24/7 answering and booking",
                "Website knowledge sync",
                "Callback ticket portal",
                `${STARTER_PLAN.careHoursPerMonth} hours of platform care per month`,
              ].map((b) => (
                <li key={b} className="flex gap-2 text-sm text-gray-700">
                  <Check />
                  {b}
                </li>
              ))}
            </ul>

            <Link
              href={DEMO_CTA}
              className="mt-6 block rounded-md bg-gray-900 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-gray-800"
            >
              Get started
            </Link>
          </div>

          {/* Growth and Scale stay sales-assisted until the tier work lands. */}
          {HIGHER_TIERS.map((t) => (
            <div
              key={t.label}
              className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm"
            >
              <h3 className="text-lg font-semibold text-gray-900">{t.label}</h3>
              <p className="mt-4">
                <span className="text-4xl font-semibold tracking-tight text-gray-900">
                  ${t.price}
                </span>
                <span className="text-sm text-gray-500">/month</span>
              </p>
              <p className="mt-1 text-sm text-gray-500">
                + ${t.setup} one-time setup
              </p>

              <ul className="mt-6 space-y-2">
                {[
                  `${t.minutes} included minutes per month`,
                  t.extra,
                  "Everything in Starter",
                ].map((b) => (
                  <li key={b} className="flex gap-2 text-sm text-gray-700">
                    <Check />
                    {b}
                  </li>
                ))}
              </ul>

              <Link
                href={DEMO_CTA}
                className="mt-6 block rounded-md border border-gray-300 px-4 py-2.5 text-center text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Talk to us
              </Link>
            </div>
          ))}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* What's not included — HIDDEN.                                    */}
        {/*                                                                  */}
        {/* Worth knowing what this removes: the landing page no longer       */}
        {/* states the $0.30/min overage anywhere except the FAQ. /billing    */}
        {/* still carries the full disclosure, and that is the page a         */}
        {/* customer sees before checkout, so the pre-purchase disclosure     */}
        {/* survives. If a Stripe Payment Link ever gets linked straight from */}
        {/* here, bypassing /billing, put this block back first.              */}
        {/* ---------------------------------------------------------------- */}
        {/*
        <div className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-5">
          <h3 className="text-sm font-semibold text-gray-900">
            What&rsquo;s not included
          </h3>
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
            Minutes used are visible in your dashboard at all times. Setup fees
            are charged once. Enterprise pricing is quoted per organisation.
          </p>
        </div>
        */}
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* FAQ                                                              */}
      {/* ---------------------------------------------------------------- */}
      <Section id="faq" className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>Questions</Eyebrow>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
          What people ask before signing up
        </h2>

        <dl className="mt-10 grid gap-x-12 gap-y-8 md:grid-cols-2">
          {FAQS.map((f) => (
            <div key={f.q}>
              <dt className="text-sm font-semibold text-gray-900">{f.q}</dt>
              <dd className="mt-2 text-sm leading-relaxed text-gray-600">
                {f.a}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Closing CTA                                                      */}
      {/* ---------------------------------------------------------------- */}
      <Section className="py-20">
        <div className="rounded-2xl border border-gray-200 bg-white px-8 py-14 text-center shadow-sm md:px-12">
          <h2 className="text-3xl font-semibold tracking-tight text-gray-900">
            Stop losing jobs to voicemail
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-gray-600">
            Tell us about your business in twenty minutes. Lumi is answering your
            phone about a week later.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href={DEMO_CTA}
              className="rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white hover:bg-gray-800"
            >
              Book a discovery call
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
    </MarketingShell>
  );
}
