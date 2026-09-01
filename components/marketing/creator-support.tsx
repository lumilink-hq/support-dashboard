// /lp/creator-support — direct pitch to creators, course sellers, and coaches
// as customers (not a partner/referral deal, unlike everything under
// /partners/*). Confirmed audience angle 2026-08-30: pitch influencers as
// customers, not a positioning/contrast page about the "guru" space.
//
// Same product, same plan ladder as every other vertical — this is scoped
// exactly like /solutions/ecommerce and /solutions/service, reusing
// PricingGrid and self-serve signup rather than the custom-quote CTA the
// partner pages use. It's noindex and unlinked from the nav only because it
// isn't one of the two verticals currently featured on the homepage, not
// because the deal shape is different.
//
// GROUNDING CHECK: every capability below is real shipped phone
// functionality (booking, price/policy lookup, callback tickets,
// reschedule). The natural fit for this audience is the "book a strategy
// call" enrollment funnel that's already standard in this industry, and
// support calls from existing students about access/refunds — not DMs or
// email, which this product doesn't touch. Don't stretch the pitch past
// what a phone line can actually do.

import Link from "next/link";
import { MarketingShell } from "@/components/marketing/shell";
import {
  CallLengthPolicy,
  CapabilityGrid,
  Check,
  ClosingCta,
  Eyebrow,
  FaqList,
  OVERAGE_ANSWER,
  Pillars,
  PricingGrid,
  Section,
  SIGNUP_CTA,
} from "@/components/marketing/blocks";
import {
  AppointmentsMockup,
  ReviewQueueMockup,
} from "@/components/marketing/dashboard-mockups";
import { guaranteedCalls, STARTER_PLAN } from "@/lib/entitlements";

export const CREATOR_SUPPORT_METADATA = {
  title: "LumiLink for Creators & Course Sellers | AI Phone Support",
  description:
    "Lumi answers your enrollment and support line 24/7, books strategy calls, and answers from your real program details, so a missed call doesn't become a missed student.",
};

const PILLARS = [
  {
    n: "01",
    title: "Never Miss An Enrollment Call",
    body: "A prospect who can't book a call today books with someone else tomorrow. Lumi answers day or night and gets the call on your calendar.",
  },
  {
    n: "02",
    title: "It Answers From Your Real Program Details",
    body: "Pricing, curriculum, and policies come from what you've actually published, not a guess. When a question needs your judgment, it says so.",
  },
  {
    n: "03",
    title: "Costs Less Than One Missed Enrollment",
    body: `Starter is $${STARTER_PLAN.monthlyUsd} a month and covers ${guaranteedCalls(STARTER_PLAN.includedMinutes)} calls a month. One enrolled student covers it several times over.`,
  },
];

const CAPABILITIES = [
  {
    title: "Answers your line, 24/7",
    body: "Prospects and students reach a real conversation any time, not a voicemail.",
  },
  {
    title: "Books strategy and enrollment calls",
    body: "Checks your live calendar, holds the slot, and confirms it.",
  },
  {
    title: "Answers from your real program details",
    body: "Pricing, curriculum, and policies pulled from what you've actually published, not invented.",
  },
  {
    title: "Handles access questions",
    body: "Reads the login and access instructions you give it, so a student gets the answer without waiting on you.",
  },
  {
    title: "Escalates refund requests, doesn't guess",
    body: "A refund or dispute becomes a callback ticket in your queue. Lumi doesn't promise money back on your behalf.",
  },
  {
    title: "Reschedules and cancels",
    body: "Students move their own calls by phone, without waiting for you to call back.",
  },
];

const FAQS = [
  {
    q: "Is This For Coaching, Courses, Or Communities?",
    a: "All three. Anything where someone calls to enroll, ask about access, or get help with your program.",
  },
  {
    q: "Can It Handle Refund Requests?",
    a: "It logs the request as a callback ticket for you. The decision stays with you; Lumi doesn't promise a refund on your behalf.",
  },
  {
    q: "Does It Know My Program Details?",
    a: "It syncs the pricing, curriculum, and policies already on your site. Included in every plan, with no connector fee. Update your site and Lumi's answers update with it.",
  },
  {
    q: "What Happens If Lumi Can't Handle A Call?",
    a: "It offers a transfer, or takes the details and logs a callback ticket for you to pick up. When it doesn't know something, it says so.",
  },
  {
    q: "Do I Need A Phone Number?",
    a: `No — we provide one. We buy and configure a local number for you as part of setup, and it's live before your first call. Starter includes ${STARTER_PLAN.numbers}.`,
  },
  {
    q: `Why Are Calls Capped At ${STARTER_PLAN.maxCallMinutes} Minutes?`,
    a: "That's about how long a prospect or student wants to be on the phone. Lumi settles the routine questions fast, and anything needing judgment goes to you instead of looping.",
  },
  {
    q: "What If I Run Out Of Calls?",
    a: OVERAGE_ANSWER,
  },
  {
    q: "What Does Setup Cost?",
    a: "Nothing. We provision your phone number, load your program details and pricing, connect your calendar, test the agent, and launch it, all included.",
  },
  {
    q: "Can I Cancel?",
    a: "Cancel anytime from your dashboard. We don't pro-rate the month you're already in, and there's no retention call.",
  },
];

export function CreatorSupportSolution() {
  return (
    <MarketingShell>
      <Section className="pb-20 pt-16 md:pb-28 md:pt-24">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <Eyebrow>AI Phone Support For Creators And Course Sellers</Eyebrow>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
              Every Question Answered. Every Student Still Yours.
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-gray-600">
              Lumi answers your enrollment and support line 24/7: books a
              strategy call, answers questions about your program from your
              real sales page, and logs anything that needs your judgment
              instead of losing it to a missed call.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href={SIGNUP_CTA}
                className="rounded-md bg-gray-900 px-5 py-3 text-sm font-medium text-white hover:bg-gray-800"
              >
                Create Your Account
              </Link>
              <a
                href="/plans"
                className="rounded-md border border-gray-300 px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                See Plans
              </a>
            </div>

            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500">
              <li className="flex items-center gap-2">
                <Check /> 24/7 Answering
              </li>
              <li className="flex items-center gap-2">
                <Check /> Books Strategy Calls
              </li>
              <li className="flex items-center gap-2">
                <Check /> We Build It For You
              </li>
            </ul>
          </div>

          <AppointmentsMockup caption="Admin dashboard — Appointments" />
        </div>
      </Section>

      <Section className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>Why LumiLink Works</Eyebrow>
        <Pillars items={PILLARS} />
      </Section>

      <Section className="py-20">
        <div className="max-w-2xl">
          <Eyebrow>What Lumi Does</Eyebrow>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
            One Agent That Finishes The Call
          </h2>
          <p className="mt-3 text-gray-600">
            A conversation that ends with a booked call or a real answer, not
            a message waiting for you.
          </p>
        </div>
        <CapabilityGrid items={CAPABILITIES} />

        <ReviewQueueMockup
          caption="Admin dashboard — Review Queue"
          className="mx-auto mt-12 max-w-2xl"
        />
      </Section>

      <CallLengthPolicy closing="We publish this because you will hit it. An AI that keeps a prospect on the line for nine minutes costs you more than one that hands them to a person at two." />

      <PricingGrid />

      <FaqList items={FAQS} heading="What Creators Ask" />

      <ClosingCta
        heading="Stop Losing Enrollments To Voicemail"
        body="Tell us about your program, we build it, and Lumi starts answering your line."
      />
    </MarketingShell>
  );
}
