// The marketing landing page, as a COMPONENT rather than a route.
//
// Two routes render it and they differ only in who gets redirected away:
//   app/page.tsx      "/"      public front door; signed-in users are sent to
//                              the dashboard instead
//   app/home/page.tsx "/home"  always renders, so someone already signed in can
//                              still look at the marketing site
//
// Keeping the markup here means those two can never drift apart. It also means
// only ONE of them carries the canonical metadata — /home is noindex, because
// two indexable URLs serving identical content split the ranking signal and
// neither wins.
//
// EVERY PRICE AND LIMIT HERE IS IMPORTED, NOT TYPED. STARTER_PLAN and the
// pricing block come from lib/entitlements.ts via components/marketing/blocks.tsx,
// which mirrors the CFO workbook. That is deliberate: the cheapest way to lose
// money on this page is to quote a number the billing page disagrees with, and
// hand-copied prices drift the moment the model changes.
//
// SHARED BLOCKS. Since the vertical pages landed (/solutions/ecommerce,
// /solutions/service), the layout primitives and every block that quotes money
// live in components/marketing/blocks.tsx. Three pages with three pricing
// tables is three chances to disagree with /billing. Vertical-specific copy
// stays in each page component; this file keeps the general-audience copy.
//
// Positioning follows the existing Wix site ("Your AI receptionist, ready 24/7"
// and its three "Why LumiLink works" pillars) so the two don't contradict each
// other while both are reachable.

import Link from "next/link";
import { MarketingShell } from "@/components/marketing/shell";
import {
  CallLengthPolicy,
  CapabilityGrid,
  Check,
  ClosingCta,
  DEMO_CTA,
  Eyebrow,
  FaqList,
  OVERAGE_ANSWER,
  Pillars,
  PricingGrid,
  Section,
} from "@/components/marketing/blocks";
import { advertisedCalls, STARTER_PLAN } from "@/lib/entitlements";

/** Shared by "/" and "/home" so the two can never say different things. */
export const LANDING_METADATA = {
  title: "Lumilink | Your AI receptionist, ready 24/7",
  description:
    "Lumilink answers every call, quotes from your price list, and books the job on your real calendar. Built for small local and service businesses.",
};

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
    body: `Starter is $${STARTER_PLAN.monthlyUsd} a month and covers about ${advertisedCalls(STARTER_PLAN.includedMinutes)} calls. One booked job covers it.`,
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
    a: OVERAGE_ANSWER,
  },
  {
    q: "What's the setup fee for?",
    a: "We build your agent: load your services and prices, connect your calendar, test it against real scenarios, and launch it. You pay it once, at the start.",
  },
];

// ---------------------------------------------------------------------------

export function Landing({ homeHref = "/" }: { homeHref?: string }) {
  return (
    // /home passes its own path so a signed-in visitor clicking the wordmark
    // stays on the marketing site instead of being bounced to the dashboard.
    <MarketingShell homeHref={homeHref}>
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
                href="/plans"
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
            SWAP THIS FOR A REAL SCREENSHOT. Capture /conversations with client
            names masked and drop it in public/. Both reference sites are around
            80% product imagery, and it does more for credibility than any
            styling work.

            Until then this is a quiet empty frame rather than instructions to
            the reader — a visitor should never be told what is missing.
          */}
          <div
            aria-hidden
            className="aspect-[4/3] rounded-xl border border-gray-200 bg-gray-50 shadow-sm"
          />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Pick your vertical — the two pages that do the actual selling     */}
      {/* ---------------------------------------------------------------- */}
      <Section className="pb-20">
        <div className="grid gap-6 md:grid-cols-2">
          <Link
            href="/solutions/service"
            className="group rounded-xl border border-gray-200 bg-white p-6 shadow-sm hover:border-gray-900"
          >
            <h2 className="text-lg font-semibold text-gray-900">
              Service businesses
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-600">
              HVAC, plumbing, electrical and the trades. Lumi quotes from your
              price list and books the job on your calendar.
            </p>
            <p className="mt-4 text-sm font-medium text-gray-900 group-hover:underline">
              See how it works &rarr;
            </p>
          </Link>

          <Link
            href="/solutions/ecommerce"
            className="group rounded-xl border border-gray-200 bg-white p-6 shadow-sm hover:border-gray-900"
          >
            <h2 className="text-lg font-semibold text-gray-900">
              Online stores
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-600">
              Shopify and WooCommerce. Lumi answers &ldquo;where&rsquo;s my
              order?&rdquo; from the real order, with tracking, day or night.
            </p>
            <p className="mt-4 text-sm font-medium text-gray-900 group-hover:underline">
              See how it works &rarr;
            </p>
          </Link>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Why it works — mirrors the Wix site's three pillars               */}
      {/* ---------------------------------------------------------------- */}
      <Section className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>Why Lumilink works</Eyebrow>
        <Pillars items={PILLARS} />
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
        <CapabilityGrid items={CAPABILITIES} />
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* The two-minute policy — stated up front, not buried in terms      */}
      {/* ---------------------------------------------------------------- */}
      <CallLengthPolicy closing="We publish this because you will hit it. An AI that keeps a frustrated caller on the line for nine minutes costs you more than one that hands them to a person at two." />

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

      <PricingGrid />

      <FaqList items={FAQS} />

      <ClosingCta
        heading="Stop losing jobs to voicemail"
        body="Tell us about your business in twenty minutes. Lumi is answering your phone about a week later."
      />
    </MarketingShell>
  );
}
