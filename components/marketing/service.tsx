// /solutions/service — the trades / HVAC vertical.
//
// The archetype word matches the code: business_type is 'service' | 'ecommerce'
// (migration 0034), and it decides which onboarding steps a client sees. The
// site and the product use the same two words on purpose.
//
// This page leads with SCHEDULING, which is the MVP (docs/scheduling-mvp-build-plan.md)
// and the thing the landing page only gestures at. Same plan ladder, same
// pricing component.

import Image from "next/image";
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
import { DEMO_LINES } from "@/lib/demo";
import { advertisedCalls, STARTER_PLAN } from "@/lib/entitlements";

export const SERVICE_METADATA = {
  title: "Lumilink for service businesses | AI booking, 24/7",
  description:
    "Lumi answers every call, quotes from your price list, and books the job on your real calendar — for HVAC, plumbing, electrical and the trades. A missed call is a job that goes to whoever picked up.",
};

// Live since 2026-08-12. Shared with /demo/hvac via lib/demo.ts.
const DEMO_LINE = DEMO_LINES.service;

const PILLARS = [
  {
    n: "01",
    title: "Never miss a call",
    body: "Lumi answers when you can't: after hours, on a job site, or when three people ring at once. A missed call is a job that goes to whoever picked up.",
  },
  {
    n: "02",
    title: "It books the job, not a message",
    body: "Lumi checks your live availability, holds the slot and confirms it. You stop ringing people back to arrange something they already asked for.",
  },
  {
    n: "03",
    title: `Costs less than the calls you're missing`,
    body: `Starter is $${STARTER_PLAN.monthlyUsd} a month and covers about ${advertisedCalls(STARTER_PLAN.includedMinutes)} calls a month. One booked job covers it.`,
  },
];

const CAPABILITIES = [
  {
    title: "Books real appointments",
    body: "Checks live availability, holds the slot, and confirms it — on your actual calendar, not a request form.",
  },
  {
    title: "Reschedules and cancels",
    body: "Customers move their own appointments by phone, without waiting for you to call them back.",
  },
  {
    title: "Quotes from your price list",
    body: "Lumi reads the prices you set. When a job needs a site visit before anyone can price it, it says so instead of inventing a number.",
  },
  {
    title: "Knows your service area",
    body: "Callers outside the area you cover are told so on the call, not after a van has been dispatched.",
  },
  {
    title: "Answers after hours",
    body: "Evenings, weekends and the overflow while you're under a sink. Every caller reaches a real conversation.",
  },
  {
    title: "Nothing disappears",
    body: "When Lumi can't finish a call, it logs a callback ticket in your follow-up queue. You decide who rings back.",
  },
];

const FAQS = [
  {
    q: "Which trades is this for?",
    a: "HVAC, plumbing, electrical, appliance repair, landscaping — anything where the job gets booked on a calendar and a missed call goes to a competitor.",
  },
  {
    q: "Does it use my real calendar?",
    a: "Yes. Lumi checks live availability before offering a slot, so it can't double-book you or offer a time you're already out on a job.",
  },
  {
    q: "What if a job can't be priced over the phone?",
    a: "Lumi says so and books the site visit. It quotes from the price list you set and doesn't guess at anything you haven't priced.",
  },
  {
    q: "What happens if Lumi can't handle a call?",
    a: "It offers a transfer, or takes the details and logs a callback ticket for you to pick up. When it doesn't know something, it says so.",
  },
  {
    q: "Do I need a phone number?",
    a: `No — we provide one. We buy and configure a local number for you as part of setup, and it's live before your first call. Starter includes ${STARTER_PLAN.numbers}. Porting an existing number isn't supported yet.`,
  },
  {
    q: `Why are calls capped at ${STARTER_PLAN.maxCallMinutes} minutes?`,
    a: "A caller going in circles with an AI has a worse time than one who gets a callback from a person. Lumi warns before the limit, closes the conversation, and hands anything unresolved to you.",
  },
  {
    q: "What If I Run Out Of Calls?",
    a: OVERAGE_ANSWER,
  },
  {
    q: "What Does Setup Cost?",
    a: "Nothing. We provision your phone number, load your services and prices, connect your calendar, test the agent against real scenarios and launch it — all included. You don't lift a finger and you don't pay a setup fee.",
  },
  {
    q: "Can I Cancel?",
    a: "Cancel anytime from your dashboard. We don't pro-rate the month you're already in, and there's no retention call.",
  },
];

export function ServiceSolution() {
  return (
    <MarketingShell>
      <Section className="pb-20 pt-16 md:pb-28 md:pt-24">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <Eyebrow>AI phone support for the trades</Eyebrow>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
              Every call answered. Every job on the calendar.
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-gray-600">
              Lumi picks up while you&rsquo;re on a job, quotes from your price
              list, and books the appointment on your real calendar. You see
              every word that was said.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href={DEMO_CTA}
                className="rounded-md bg-gray-900 px-5 py-3 text-sm font-medium text-white hover:bg-gray-800"
              >
                Book a discovery call
              </Link>
              {/*
                Matches /solutions/ecommerce. This slot used to be "See pricing",
                which is the weaker ask: pricing is in the nav, in the anchor
                below, and on /plans, whereas the demo is the only thing on the
                page that lets someone HEAR the product before talking to us.
                It was only "See pricing" because /demo/hvac was parked at the
                time — it isn't any more.
              */}
              <Link
                href="/demo/hvac"
                className="rounded-md border border-gray-300 px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Try the live demo
              </Link>
            </div>

            {DEMO_LINE.tel ? (
              <p className="mt-4 text-sm text-gray-500">
                Hear it first:{" "}
                <a
                  href={`tel:${DEMO_LINE.tel}`}
                  className="font-medium text-gray-900 underline"
                >
                  {DEMO_LINE.display}
                </a>{" "}
                — book a visit with our demo HVAC company.
              </p>
            ) : null}

            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500">
              <li className="flex items-center gap-2">
                <Check /> 24/7 answering
              </li>
              <li className="flex items-center gap-2">
                <Check /> Real-time booking
              </li>
              <li className="flex items-center gap-2">
                <Check /> Quotes from your prices
              </li>
            </ul>
          </div>

          {/*
            CROPPED, not scaled. The original was a full-page capture — sidebar,
            empty "Upcoming" panel and all — and shrinking that into a
            half-width column rendered every label at sub-pixel size, which
            reads as a low-quality screenshot rather than a dense product.
            Cropping to the metric row and the week strip means less content
            competing for the same width, so the numbers stay readable.

            Real product, not a mockup. The appointments view a contractor actually sees.
            Bordered rather than bled to the edge so it reads as a screenshot of
            something that exists, which is the entire point of putting it here.
          */}
          <Image
            src="/proof-appointments-crop.png"
            alt="Booked revenue, average job value and the week ahead, from jobs the agent booked"
            width={1590}
            height={475}
            sizes="(min-width: 768px) 50vw, 100vw"
            priority
            className="rounded-xl border border-gray-200 shadow-sm"
          />
        </div>
      </Section>

      <Section className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>Why Lumilink works</Eyebrow>
        <Pillars items={PILLARS} />
      </Section>

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

      <CallLengthPolicy closing="We publish this because you will hit it. An AI that keeps a frustrated caller on the line for nine minutes costs you more than one that hands them to a person at two." />

      <PricingGrid />

      <FaqList items={FAQS} heading="What contractors ask" />

      <ClosingCta
        heading="Stop losing jobs to voicemail"
        body="Tell us about your business in twenty minutes. Lumi is answering your phone about a week later."
      />
    </MarketingShell>
  );
}
