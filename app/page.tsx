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
  title: "Lumilink — Your AI receptionist, ready 24/7",
  description:
    "Lumilink answers every call, quotes from your price list, and books the job on your real calendar — around the clock, for small local and service businesses.",
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
    body: "Lumi answers when you can't — after hours, on a job site, or when three people ring at once. Missed calls are lost jobs; this is the whole point.",
  },
  {
    n: "02",
    title: "Costs less than the calls you're missing",
    body: `Starter is $${STARTER_PLAN.monthlyUsd} a month with ${STARTER_PLAN.includedMinutes} included minutes. One booked job usually covers it.`,
  },
  {
    n: "03",
    title: "You can see everything",
    body: "Every call, transcript, booking and callback ticket lands in your dashboard. No black box, no guessing what the AI told your customer.",
  },
];

const CAPABILITIES = [
  {
    title: "Answers every call, 24/7",
    body: "After-hours, overflow and missed-call capture. Callers reach a real conversation instead of voicemail.",
  },
  {
    title: "Books real appointments",
    body: "Checks your live availability, holds the slot and confirms it. No double-booking, no calling people back to rearrange.",
  },
  {
    title: "Quotes from your price list",
    body: "Lumi reads the prices you set. It never invents a number, and it says so when a job needs a proper quote.",
  },
  {
    title: "Knows your business",
    body: "Syncs what's already on your website — services, hours, policies. Included in every plan, with no connector fee.",
  },
  {
    title: "Nothing disappears",
    body: "Anything Lumi can't finish becomes a callback ticket in a follow-up queue, so no customer request quietly evaporates.",
  },
  {
    title: "Reschedules and cancels",
    body: "Customers move their own appointments by phone instead of playing voicemail tag with you.",
  },
];

const STEPS = [
  {
    n: "1",
    title: "A 20-minute discovery call",
    body: "We go through your services, prices and hours — the things Lumi needs in order to answer accurately.",
  },
  {
    n: "2",
    title: "We build and test your agent",
    body: "Your setup fee covers implementation, knowledge setup, testing and launch. You hear it before your customers do.",
  },
  {
    n: "3",
    title: "Your number goes live",
    body: "Forward your existing number or use a new local one, then watch every call land in the dashboard.",
  },
];

const FAQS = [
  {
    q: "What happens if Lumi can't handle a call?",
    a: "It offers a transfer, or takes the details and logs a callback ticket for you to pick up. It doesn't pretend to know things it doesn't, and it doesn't leave anyone stuck in a loop.",
  },
  {
    q: `Why are calls capped at ${STARTER_PLAN.maxCallMinutes} minutes?`,
    a: "Because a caller going in circles with an AI is a worse experience than a callback from a person. Lumi warns before the limit, closes the conversation properly, and hands anything unresolved to you.",
  },
  {
    q: "Does it sound robotic?",
    a: "It's a natural voice with real conversational turn-taking, not a phone tree. The honest answer is that you should hear it yourself before deciding — that's what the discovery call is for.",
  },
  {
    q: "Can I keep my phone number?",
    a: `Yes. Forward your existing number to Lumi, or we'll provide a local one. Starter includes ${STARTER_PLAN.numbers} number.`,
  },
  {
    q: "What happens if I go over my minutes?",
    a: `Additional minutes are billed at $${OVERAGE.perVoiceMinuteUsd.toFixed(2)} each. Minutes used against your allowance are visible in the dashboard at any time, so it isn't a surprise on the invoice.`,
  },
  {
    q: "What's the setup fee for?",
    a: "Building your agent: loading your services and prices, connecting your calendar, testing against real scenarios, and launching it. Charged once, at the start.",
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
              job on your real calendar — then shows you exactly what was said.
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
            One agent that actually finishes the job
          </h2>
          <p className="mt-3 text-gray-600">
            Not a phone tree, not a voicemail transcriber — a conversation that
            ends with an appointment on your calendar.
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
              Every AI call is capped at {STARTER_PLAN.maxCallMinutes} minutes.
              As the limit approaches, Lumi stops opening new topics, finishes
              what it&rsquo;s doing, and offers a transfer or a callback — then
              says goodbye properly instead of cutting off mid-sentence.
            </p>
            <p className="mt-3 leading-relaxed text-gray-300">
              We publish this because you will hit it, and because an AI that
              keeps a frustrated caller on the line for nine minutes is worse for
              your business than one that hands them to a human at two.
            </p>
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* How it works                                                     */}
      {/* ---------------------------------------------------------------- */}
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

      {/* ---------------------------------------------------------------- */}
      {/* Pricing                                                          */}
      {/* ---------------------------------------------------------------- */}
      <Section id="pricing" className="py-20">
        <div className="max-w-2xl">
          <Eyebrow>Pricing</Eyebrow>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
            Straightforward, and we tell you where it stops
          </h2>
          <p className="mt-3 text-gray-600">
            Hard minute allowances rather than an &ldquo;unlimited&rdquo; plan
            with a fair-use clause buried in the terms.
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

        {/*
          Overage terms belong on the pricing page, inside the decision — not in
          a terms page nobody opens. A metered plan whose meter is a surprise
          generates chargebacks, and one $15 dispute costs more than the overage
          it was hiding ever collected.
        */}
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
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* FAQ                                                              */}
      {/* ---------------------------------------------------------------- */}
      <Section id="faq" className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>Questions</Eyebrow>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
          The things people actually ask
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
            Twenty minutes to tell us about your business. About a week until
            Lumi is answering your phone.
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
