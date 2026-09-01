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
  ConversationsMockup,
  ReviewQueueMockup,
} from "@/components/marketing/dashboard-mockups";
import { availableAddons } from "@/lib/addons";
import { STARTER_PLAN } from "@/lib/entitlements";

/** Shared by "/" and "/home" so the two can never say different things. */
export const LANDING_METADATA = {
  title: "LumiLink | Automate The Repetitive. Escalate What Matters.",
  description:
    "LumiLink answers every call, quotes from your price list, and books the job on your real calendar. We build the whole thing for you, with free setup and no per-minute charges.",
};

// ---------------------------------------------------------------------------
// Content, kept as data so ordering and edits are obvious
// ---------------------------------------------------------------------------

const PILLARS = [
  {
    n: "01",
    title: "Never Miss A Call",
    body: "Lumi answers when you can't: after hours, on a job site, or when three people ring at once. A missed call is a job that goes to whoever picked up.",
  },
  {
    n: "02",
    title: "We Build Your Agent From Your Information",
    body: "We write what it knows, provision your number, and test it before a customer ever hears it. Setup costs nothing. We'd rather prove the product works than charge you before you've seen it. Change what it says or how it works any time after launch.",
  },
  {
    n: "03",
    title: "A Fraction Of What The Phone Already Costs You",
    body: "Every call you take is a job you're not doing, and every one you miss is a job someone else did. Lumi handles the repetitive ones so your day belongs to the work you're actually paid for.",
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

// RESTORED 2026-08-30 as part of the hub repositioning (see the memory note
// "project-repositioning-2026-08" if this file is being read outside that
// context). Step 2's body used to say "your setup fee covers..." — that
// contradicted the FAQ two sections down, which has said setup is free since
// well before this section was hidden. Fixed rather than carried forward.
const STEPS = [
  {
    n: "1",
    title: "Create your account",
    body: "Tell us your services, prices, and hours. That's what Lumi needs to answer a customer correctly.",
  },
  {
    n: "2",
    title: "We build and test your agent",
    body: "We write what it knows, connect your calendar, and test it against real scenarios before your number goes live. No setup fee, no cost to you.",
  },
  {
    n: "3",
    title: "Your number goes live",
    body: "We provision your local number and point it at your agent. Every call lands in your dashboard from day one.",
  },
];

// Real catalogue, from lib/addons.ts — same source /billing and /addons use.
// The $15/$39 "extra number, routing tree" figures that used to live here
// came from docs/BUILD-PLAN-2026-08.md, which didn't match any actual Stripe
// object; this pulls the real, currently-sellable add-ons instead. Just the
// first two, cheapest-first, so the homepage teases rather than repeats the
// full list on /addons.
const ADD_ONS = availableAddons()
  .slice()
  .sort((a, b) => a.monthlyUsd - b.monthlyUsd)
  .slice(0, 2);

const FAQS = [
  {
    q: "What Happens If Lumi Can't Handle A Call?",
    a: "It offers a transfer, or takes the details and logs a callback ticket for you to pick up. When it doesn't know something, it says so.",
  },
  {
    q: `Why Are Calls Capped At ${STARTER_PLAN.maxCallMinutes} Minutes?`,
    a: "Because that's about how long your customer wants to be on the phone. Lumi settles the routine questions fast, and anything needing judgement goes to a person instead of looping. Nobody wins when an AI keeps someone talking for nine minutes.",
  },
  {
    q: "Does It Sound Robotic?",
    // Was "judge it yourself on the discovery call" — there is no discovery
    // call. Replaced with what the voice actually does rather than a promise to
    // demo it: an in-app test call is a known gap (FEATURE-GAPS.md §5), so
    // pointing at one here would swap a fake step for a missing feature.
    a: "It's a natural voice with real conversational turn-taking — it pauses, handles being interrupted, and doesn't read from a script. Every call is transcribed in your dashboard, so you can read exactly how it sounded.",
  },
  {
    q: "Do I Need A Phone Number?",
    a: `No — we provide one. We buy and configure a local number for you as part of setup, and it's live before your first call. Starter includes ${STARTER_PLAN.numbers}. Porting an existing number isn't supported yet.`,
  },
  {
    q: "What If I Run Out Of Calls?",
    a: OVERAGE_ANSWER,
  },
  {
    q: "What Does Setup Cost?",
    a: "Nothing. We provision your phone number, load your services and prices, connect your calendar, test the agent against real scenarios and launch it — all included. Most people expect a setup fee here. We'd rather you spent that money finding out whether we're any good.",
  },
  {
    q: "Can I Cancel?",
    a: "Cancel anytime from your dashboard. We don't pro-rate the month you're already in, and we won't put you through a retention call — if it isn't working, we'd rather hear why.",
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
            <Eyebrow>AI Customer Service For Growing Businesses</Eyebrow>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
              Automate The Repetitive. Escalate What Matters.
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-gray-600">
              Lumi answers every call, quotes from your price list, and books
              the job on your real calendar. Phone is where we start. The same
              system is built to carry everything else your customers need
              from you.
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
                <Check /> Free Setup
              </li>
              <li className="flex items-center gap-2">
                <Check /> 24/7 Answering
              </li>
              <li className="flex items-center gap-2">
                <Check /> We Build It For You
              </li>
            </ul>
          </div>

          {/*
            CSS MOCKUP, NOT A SCREENSHOT (2026-08-31). Used to be a real
            appointments-view capture, which meant re-shooting it by hand
            every time the UI or the seed data changed. This is markup that
            mirrors the real layout (app/(dashboard)/appointments) with
            invented names and numbers, so it never goes stale and never
            shows a real customer's information.
          */}
          <AppointmentsMockup caption="Admin dashboard — Appointments" />
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
              Service Businesses
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-600">
              HVAC, plumbing, electrical and the trades. Lumi quotes from your
              price list and books the job on your calendar.
            </p>
            <p className="mt-4 text-sm font-medium text-gray-900 group-hover:underline">
              See How It Works &rarr;
            </p>
          </Link>

          <Link
            href="/solutions/ecommerce"
            className="group rounded-xl border border-gray-200 bg-white p-6 shadow-sm hover:border-gray-900"
          >
            <h2 className="text-lg font-semibold text-gray-900">
              Online Stores
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-600">
              Shopify and WooCommerce. Lumi answers &ldquo;where&rsquo;s my
              order?&rdquo; from the real order, with tracking, day or night.
            </p>
            <p className="mt-4 text-sm font-medium text-gray-900 group-hover:underline">
              See How It Works &rarr;
            </p>
          </Link>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Why it works — mirrors the Wix site's three pillars               */}
      {/* ---------------------------------------------------------------- */}
      <Section className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>Why LumiLink Works</Eyebrow>
        <Pillars items={PILLARS} />
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Capabilities                                                     */}
      {/* ---------------------------------------------------------------- */}
      <Section className="py-20">
        <div className="max-w-2xl">
          <Eyebrow>What Lumi Does</Eyebrow>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
            One Agent That Finishes The Job
          </h2>
          <p className="mt-3 text-gray-600">
            A conversation that ends with an appointment on your calendar,
            today by phone, with more channels on the way.
          </p>
        </div>
        <CapabilityGrid items={CAPABILITIES} />
        {/*
          Honest about what's shipped vs. what's next: every item in
          CAPABILITIES above ships today, which is what the checkmarks
          promise. The widget and analytics work aren't there yet — the
          widget's routing exists (docs/BUILD-PLAN-2026-08.md §H) but has no
          metering, no per-client embed, and isn't exposed as a sellable
          feature; Insights has no code at all. Say so plainly rather than
          checkmarking something a customer can't actually get yet.
        */}
        <p className="mt-10 text-sm text-gray-500">
          Building next: a website widget with the same knowledge behind it,
          and a dashboard view of what your customers are actually asking for.
        </p>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Inside the dashboard — the two screens behind "nothing            */}
      {/* disappears" and "you see every word that was said" up in the      */}
      {/* hero. Those were claims with no picture next to them.             */}
      {/*                                                                   */}
      {/* CSS MOCKUPS, NOT SCREENSHOTS (2026-08-31) — same reasoning as the  */}
      {/* Appointments shot above. The "not a mockup" line in the blurb     */}
      {/* below refers to the DASHBOARD (it's the real product, not a demo  */}
      {/* environment), not to these particular images — worth rewording if */}
      {/* that reads as contradicting itself now that the images ARE mocked */}
      {/* up.                                                               */}
      {/* ---------------------------------------------------------------- */}
      <Section
        id="inside-the-dashboard"
        className="border-t border-gray-200 bg-gray-50 py-20"
      >
        <div className="max-w-2xl">
          <Eyebrow>Inside The Dashboard</Eyebrow>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
            Every Call Logged. Nothing Falls Through.
          </h2>
          <p className="mt-3 text-gray-600">
            This is the same dashboard your account gets. Every call becomes
            a transcript, and anything Lumi couldn&rsquo;t finish lands in a
            queue instead of vanishing.
          </p>
        </div>
        <div className="mt-12 grid gap-x-10 gap-y-12 md:grid-cols-2">
          <ConversationsMockup caption="Admin dashboard — Conversations" />
          <ReviewQueueMockup caption="Admin dashboard — Review Queue" />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* The two-minute policy — stated up front, not buried in terms      */}
      {/* ---------------------------------------------------------------- */}
      <CallLengthPolicy closing="We publish this because you will hit it. An AI that keeps a frustrated caller on the line for nine minutes costs you more than one that hands them to a person at two." />

      {/* ---------------------------------------------------------------- */}
      {/* How it works — restored 2026-08-30 with the Suite/add-ons framing */}
      {/* from the repositioning brief. Phone stays the flagship; this      */}
      {/* section is where "there's more to add later" gets said out loud. */}
      {/* ---------------------------------------------------------------- */}
      <Section id="how" className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>How LumiLink Works</Eyebrow>
        <h2 className="mt-4 max-w-2xl text-3xl font-semibold tracking-tight text-gray-900">
          Start With The Phone. Build Your Support From There.
        </h2>
        <p className="mt-3 max-w-2xl text-gray-600">
          Every plan starts with the same core agent, answering calls the day
          it goes live. A customer who reaches Lumi at 2am gets an answer
          instead of a competitor&rsquo;s voicemail, and a job gets booked
          instead of lost. From there, add what your specific business needs.
        </p>

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

        <div className="mt-12 rounded-xl border border-gray-200 bg-white p-6">
          <h3 className="text-sm font-semibold text-gray-900">
            Add To Your Plan When You Need It
          </h3>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {ADD_ONS.map((a) => (
              <li key={a.key} className="flex gap-2 text-sm text-gray-600">
                <Check />
                {a.name} (${a.monthlyUsd}/mo)
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-gray-500">
            <Link href="/addons" className="font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700">
              See every add-on
            </Link>
            . Website Chat is next on our roadmap.
          </p>
        </div>
      </Section>

      <PricingGrid />

      <FaqList items={FAQS} />

      <ClosingCta
        heading="Stop Losing Customers To Voicemail"
        body="Tell us about your business, we build it, and Lumi starts answering your phone. Setup costs nothing, and the product keeps getting better."
      />
    </MarketingShell>
  );
}
