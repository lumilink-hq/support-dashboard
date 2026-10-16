// "/products/phone-agent" — the AI Phone Agent's own product page (2026-10-16).
//
// Until now the landing page doubled as this product's page (catalog.ts had
// marketingHref "/"), so the Products menu's first item went to a page about
// everything. The landing page keeps its short #phone-agent section; this is
// the full pitch, in the order every product page now follows
// (docs/rogiq-site-plan.md item 3): the problem, what Lumi does, how it
// works, the price, what it works with, questions, and a two-path ending.
//
// The capability list and the phone FAQs live here and the landing page
// imports them, so the two pages can't describe the agent differently.
// Prices come from lib/entitlements.ts through the shared blocks.

import Link from "next/link";
import { MarketingShell } from "@/components/marketing/shell";
import {
  Accent,
  CallLengthPolicy,
  CapabilityGrid,
  Check,
  Eyebrow,
  FaqList,
  OVERAGE_ANSWER,
  Pillars,
  PricingGrid,
  Section,
  SIGNUP_CTA,
  SplitCta,
  WorksWith,
} from "@/components/marketing/blocks";
import {
  ConversationsMockup,
  ReviewQueueMockup,
} from "@/components/marketing/dashboard-mockups";
import { DEMO_LINES } from "@/lib/demo";

export const PHONE_AGENT_METADATA = {
  title: "AI Phone Agent That Answers And Books 24/7 | LumiLink",
  description:
    "An AI phone agent that answers every call, quotes from your price list and books the job on your real calendar. Free setup, no per-minute bills.",
};

const DEMO_LINE = DEMO_LINES.service;

// The problem first, the way RogIQ opens every page.
const PROBLEMS = [
  {
    n: "01",
    title: "Every Missed Call Is A Job For Someone Else",
    body: "On a job site, after hours, or with three lines ringing at once. The caller doesn't leave a voicemail. They call the next business on the list.",
  },
  {
    n: "02",
    title: "Answering Services Take Messages, Not Bookings",
    body: "A message still means you ringing back, playing phone tag, and rearranging your day. The job isn't on the calendar until you do.",
  },
  {
    n: "03",
    title: "Hiring Someone To Answer Is Expensive",
    body: "A receptionist costs a salary, covers business hours only, and still can't take the 9pm call that turns into tomorrow's job.",
  },
];

/** Also rendered in the landing page's #phone-agent section. */
export const PHONE_CAPABILITIES = [
  {
    title: "Answers Every Call, 24/7",
    body: "After hours, overflow, and the calls that arrive while you're on a job. Every caller reaches a real conversation.",
  },
  {
    title: "Books Real Appointments",
    body: "Checks your live availability, holds the slot, and confirms it. You stop ringing people back to rearrange.",
  },
  {
    title: "Quotes From Your Price List",
    body: "Lumi reads the prices you set. When a job needs a site visit before anyone can price it, it says so.",
  },
  {
    title: "Knows Your Business",
    body: "Syncs the services, hours, and policies already on your website. Included in every plan, with no connector fee.",
  },
  {
    title: "Nothing Disappears",
    body: "When Lumi can't finish a call, it logs a callback ticket in your follow-up queue. You decide who rings back.",
  },
  {
    title: "Reschedules And Cancels",
    body: "Customers move their own appointments by phone, without waiting for you to call them back.",
  },
];

const STEPS = [
  {
    n: "1",
    title: "Tell Us How You Work",
    body: "Create your account and give us your services, prices, hours and the calendar you book into.",
  },
  {
    n: "2",
    title: "We Build And Test It",
    body: "We set up your number and your agent, then test it against real scenarios. No customer hears it until it passes.",
  },
  {
    n: "3",
    title: "It Answers. You See Every Word.",
    body: "Every call becomes a transcript in your dashboard, every booking lands on your calendar, and anything unfinished waits in your queue.",
  },
];

/** Also the last five questions on the landing page. */
export const PHONE_FAQS = [
  {
    q: "What Happens If Lumi Can't Handle A Call?",
    a: "It offers a transfer, or takes the details and logs a callback ticket for you to pick up. When it doesn't know something, it says so.",
  },
  {
    q: "Does It Sound Robotic?",
    // Was "judge it yourself on the discovery call" — there is no discovery
    // call. An in-app test call is a known gap (FEATURE-GAPS.md §5).
    a: "It's a natural voice with real conversational turn-taking — it pauses, handles being interrupted, and doesn't read from a script. Every call is transcribed in your dashboard, so you can read exactly how it sounded.",
  },
  {
    q: "What If I Run Out Of Calls?",
    a: OVERAGE_ANSWER,
  },
  {
    q: "What Does Setup Cost?",
    a: "Nothing, on every phone plan. We provision your number, load your services and prices, connect your calendar, test the agent against real scenarios and launch it. We'd rather you spent that money finding out whether we're any good.",
  },
  {
    q: "Can I Cancel?",
    a: "Cancel anytime from your dashboard. We don't pro-rate the month you're already in, and we won't put you through a retention call — if it isn't working, we'd rather hear why.",
  },
];

export function PhoneAgentProduct() {
  return (
    <MarketingShell>
      <Section className="bg-[radial-gradient(ellipse_55%_60%_at_78%_45%,var(--color-lumi-100),transparent)] pb-20 pt-16 md:pb-28 md:pt-24">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <Eyebrow>AI Phone Agent</Eyebrow>
            <h1 className="mt-4 display-hero text-gray-900">
              Every Call Answered. <Accent>Every Job Booked.</Accent>
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-gray-600">
              Lumi picks up every call, day or night, quotes from your price
              list and books the job on your real calendar. You read every word
              that was said.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href={SIGNUP_CTA}
                className="rounded-md bg-gray-900 px-5 py-3 text-sm font-medium text-white hover:bg-gray-800"
              >
                Create Your Account
              </Link>
              <Link
                href="/demo/hvac"
                className="rounded-md border border-gray-300 px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Try The Live Demo
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
                <Check /> 24/7 Answering
              </li>
              <li className="flex items-center gap-2">
                <Check /> Real Bookings
              </li>
              <li className="flex items-center gap-2">
                <Check /> Free Setup
              </li>
            </ul>
          </div>

          {/* CSS mockup, not a screenshot: invented names and numbers (see
              dashboard-mockups.tsx). */}
          <ConversationsMockup caption="Admin dashboard — Conversations" />
        </div>
      </Section>

      <Section className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>Sound Familiar?</Eyebrow>
        <h2 className="reveal mt-4 max-w-2xl display-section text-gray-900">
          The Phone Rings At The Worst Possible Time
        </h2>
        <Pillars items={PROBLEMS} />
      </Section>

      <Section className="py-20">
        <div className="max-w-2xl">
          <Eyebrow>What Lumi Does</Eyebrow>
          <h2 className="reveal mt-4 display-section text-gray-900">
            One Agent That Finishes The Job
          </h2>
          <p className="mt-3 text-gray-600">
            Not a message-taker. A conversation that ends with an appointment
            on your calendar.
          </p>
        </div>
        <CapabilityGrid items={PHONE_CAPABILITIES} />
        <ReviewQueueMockup
          caption="Admin dashboard — Review Queue"
          className="mx-auto mt-12 max-w-2xl"
        />
      </Section>

      <Section className="border-t border-gray-200 py-20">
        <Eyebrow>How It Works</Eyebrow>
        <h2 className="reveal mt-4 max-w-2xl display-section text-gray-900">
          Live In Days. You Don&rsquo;t Configure A Thing.
        </h2>
        <div className="mt-12 grid gap-10 md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="reveal">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-gray-900 text-sm font-semibold text-white">
                {s.n}
              </span>
              <h3 className="mt-4 text-lg font-semibold text-gray-900">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">{s.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <CallLengthPolicy closing="We publish this because you will hit it. An AI that keeps a frustrated caller on the line for nine minutes costs you more than one that hands them to a person at two." />

      <PricingGrid contactSource="/products/phone-agent" />

      <WorksWith
        current="voice"
        heading="Answer Every Call. Then Get More Of Them."
        body="The phone agent makes sure no call goes to voicemail. Add chat for the visitors who'd rather type, and SEO + AI Search so more people find you to call in the first place."
      />

      <FaqList items={PHONE_FAQS} heading="What People Ask About The Phone Agent" />

      <SplitCta
        heading="Stop Losing Jobs To Voicemail"
        body="Tell us about your business, we build it, and Lumi starts answering your phone."
        contactSource="/products/phone-agent"
      />
    </MarketingShell>
  );
}
