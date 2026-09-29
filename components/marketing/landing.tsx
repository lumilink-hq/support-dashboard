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
// EVERY PRICE AND LIMIT HERE IS IMPORTED, NOT TYPED. Plan prices come from
// lib/entitlements.ts (which mirrors the CFO workbook), add-ons from
// lib/addons.ts, SEO from lib/seo-pricing.ts. That is deliberate: the cheapest way to lose
// money on this page is to quote a number the billing page disagrees with, and
// hand-copied prices drift the moment the model changes.
//
// SHARED BLOCKS. Since the vertical pages landed (/solutions/ecommerce,
// /solutions/service), the layout primitives and every block that quotes money
// live in components/marketing/blocks.tsx. Three pages with three pricing
// tables is three chances to disagree with /billing. Vertical-specific copy
// stays in each page component; this file keeps the general-audience copy.
//
// POSITIONING (2026-09-28): AUTOMATE THE WHOLE BUSINESS, NOT JUST THE PHONE.
// The page used to be the phone agent's product page with the rest of the
// catalogue as footnotes, following the old Wix site's "AI receptionist"
// framing. It now pitches every product with equal weight (phone, website
// chat, SEO + AI search, workflows), and the phone agent's detail lives in
// its own #phone-agent section further down. The pricing block is the plan
// finder quiz rather than the phone plan ladder, which /pricing still shows.

import Link from "next/link";
import { MarketingShell } from "@/components/marketing/shell";
import {
  CapabilityGrid,
  Check,
  ClosingCta,
  contactHref,
  EnterpriseBand,
  Eyebrow,
  FaqList,
  OVERAGE_ANSWER,
  Pillars,
  Section,
  SIGNUP_CTA,
} from "@/components/marketing/blocks";
import {
  AutomationFeedMockup,
  ConversationsMockup,
} from "@/components/marketing/dashboard-mockups";
import { SeoPortalMockup, seoCtaHref } from "@/components/marketing/seo";
import { PlanFinder } from "@/components/marketing/plan-finder";
import { finderPrices } from "@/components/marketing/finder-prices";
import { availableAddons } from "@/lib/addons";
import { PLAN_TIERS } from "@/lib/entitlements";
import { SEO_EXTRA_LOCATION, seoBundleSavings, seoPlanByKey } from "@/lib/seo-pricing";

/** Shared by "/" and "/home" so the two can never say different things. */
export const LANDING_METADATA = {
  title: "LumiLink | Automate The Repetitive. Escalate What Matters.",
  description:
    "AI automation for your whole business: an agent that answers every call and website visitor, books the job, gets you found on Google and in AI search, and connects to the tools you already use.",
};

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

// ---------------------------------------------------------------------------
// Content, kept as data so ordering and edits are obvious
// ---------------------------------------------------------------------------

const addonUsd = (key: string) =>
  availableAddons().find((a) => a.key === key)?.monthlyUsd ?? null;
const cheapestTier = Math.min(...PLAN_TIERS.map((t) => t.monthlyUsd));
const chatUsd = addonUsd("website_chat");

/**
 * Every product, equal weight. Prices are read from their sources, never
 * typed. Website Chat is an add-on on a phone plan (lib/addons.ts) and says so
 * in its price line.
 */
const PRODUCT_CARDS = [
  {
    tag: "Phone",
    title: "AI Phone Agent",
    body: "Answers every call 24/7, quotes from your price list, and books the job on your real calendar.",
    bullets: ["Books, reschedules and cancels", "Captures every lead", "Hands off to a person when it matters"],
    price: `From ${usd(cheapestTier)}/mo, free setup`,
    href: "#phone-agent",
    cta: "See The Phone Agent",
  },
  {
    tag: "Chat",
    title: "Website Chat",
    body: "The same agent on your website, so visitors get answers without picking up the phone.",
    bullets: ["Trained on your business", "Answers day and night", "Same dashboard as your calls"],
    price: chatUsd !== null ? `+${usd(chatUsd)}/mo on any phone plan` : "Add-on on any phone plan",
    href: "/pricing#addons",
    cta: "See Add-Ons",
  },
  {
    tag: "SEO",
    title: "SEO + AI Search",
    body: "Get found on Google, in the local map pack, and in the answers ChatGPT and Google's AI give.",
    bullets: ["Weekly audits and rank tracking", "AI search visibility included", "Fixes you approve before they go live"],
    price: `From ${usd(seoPlanByKey("local").monthlyUsd)}/location/mo`,
    href: "/products/seo",
    cta: "See SEO + AI Search",
  },
  // A "Workflows & Integrations" card sat here until 2026-09-29; removed at
  // the user's request. Those add-ons are still sold on /pricing#addons.
];

// "Why LumiLink Works". Was three phone-only pillars from the Wix site; SEO
// joined as its own pillar on 2026-09-28 (user feedback: "add section
// mentioning SEO").
const PILLARS = [
  {
    n: "01",
    title: "Never Miss A Customer",
    body: "Every call and every website visitor gets an answer: after hours, on a job site, or when three people reach out at once. A missed call is a job that goes to whoever picked up.",
  },
  {
    n: "02",
    title: "Get Found Where Customers Search",
    body: "Answering only helps if customers find you first. We track and improve where you rank on Google, in the local map pack, and in AI answers from ChatGPT and Google, every week.",
  },
  {
    n: "03",
    title: "We Build It For You",
    body: "We set up your agent from your information, test it before a customer hears it, and draft every SEO fix for your approval. Change anything, any time after launch.",
  },
  {
    n: "04",
    title: "A Fraction Of What The Work Costs",
    body: "Every repetitive call, question and report is time your team isn't spending on the work you're paid for. LumiLink takes that work for less than a part-time hire.",
  },
];

const CAPABILITIES = [
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

// RESTORED 2026-08-30; generalised 2026-09-28 from "your phone agent" to
// whatever the client is automating.
const STEPS = [
  {
    n: "1",
    title: "Tell Us What To Automate",
    body: "Create your account and pick what you need: calls, chat, SEO, workflows. Then tell us your services, prices and hours.",
  },
  {
    n: "2",
    title: "We Build And Test It",
    body: "We set up your agent, connect your calendar and tools, and run your first SEO audit. Nothing reaches a customer until it's tested.",
  },
  {
    n: "3",
    title: "It Runs. You See Everything.",
    body: "Calls, chats, bookings, rankings and reports land in one dashboard from day one. Add more whenever you're ready.",
  },
];

const bundle = seoBundleSavings();

const FAQS = [
  {
    q: "What Can LumiLink Automate?",
    a: "Today: answering your phone (booking, quoting, capturing leads, handling callbacks), answering website visitors, getting found on Google and in AI search, and connecting the agent to the tools you already use. Each is its own product, so you start with what you need and add the rest later.",
  },
  {
    q: "Do I Have To Buy Everything?",
    a: "No. SEO + AI Search is a standalone product. Website Chat and workflows are add-ons on a phone plan. Take one product or all of them, and change your mind from the dashboard.",
  },
  {
    q: "Do I Save By Bundling SEO?",
    a: `Yes. Full SEO + AI Search is ${usd(seoPlanByKey("bundle").monthlyUsd)} a month for your website and one location, ${usd(bundle.baseMonthlyUsd)} less than buying Website SEO + AI Search and Local SEO separately. Every extra location is ${usd(SEO_EXTRA_LOCATION.monthlyUsd)} instead of ${usd(seoPlanByKey("local").monthlyUsd)}, another ${usd(bundle.perExtraLocationUsd)} a month each.`,
  },
  {
    q: "We Have Many Locations Or Brands. Is There A Plan For Us?",
    a: "Yes: Enterprise. One account across every location and brand, white-label options, custom limits and a dedicated team, priced around what you need. Talk to us and we'll put a quote together.",
  },
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

// ---------------------------------------------------------------------------

export async function Landing({ homeHref = "/" }: { homeHref?: string }) {
  const seoHref = await seoCtaHref();

  return (
    // /home passes its own path so a signed-in visitor clicking the wordmark
    // stays on the marketing site instead of being bounced to the dashboard.
    <MarketingShell homeHref={homeHref}>
      {/* ---------------------------------------------------------------- */}
      {/* Hero                                                             */}
      {/* ---------------------------------------------------------------- */}
      {/* The faint glow behind the mockup is the "Lumi" in LumiLink; keep it faint. */}
      <Section className="bg-[radial-gradient(ellipse_55%_60%_at_78%_45%,var(--color-lumi-100),transparent)] pb-20 pt-16 md:pb-28 md:pt-24">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <Eyebrow>AI Automation For Your Whole Business</Eyebrow>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
              Automate The Repetitive. Escalate What Matters.
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-gray-600">
              LumiLink answers your phone and your website, books the jobs,
              gets you found on Google and in AI search, and connects to the
              tools you already use. The repetitive work runs itself. The
              moments that need you come straight to you.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href={SIGNUP_CTA}
                className="rounded-md bg-gray-900 px-5 py-3 text-sm font-medium text-white hover:bg-gray-800"
              >
                Create Your Account
              </Link>
              <a
                href="#finder"
                className="rounded-md border border-gray-300 px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Find What You Need
              </a>
            </div>

            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500">
              <li className="flex items-center gap-2">
                <Check /> Calls &amp; Chat
              </li>
              <li className="flex items-center gap-2">
                <Check /> SEO &amp; AI Search
              </li>
              <li className="flex items-center gap-2">
                <Check /> Workflows
              </li>
              <li className="flex items-center gap-2">
                <Check /> We Build It For You
              </li>
            </ul>
          </div>

          {/* CSS mockup, not a screenshot: invented names and numbers (see
              dashboard-mockups.tsx). One feed across every product. */}
          <AutomationFeedMockup
            caption="Your dashboard — everything LumiLink handled today"
            className="min-w-0"
          />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Every product, equal weight                                       */}
      {/* ---------------------------------------------------------------- */}
      <Section id="products" className="border-t border-gray-200 py-20">
        <div className="max-w-2xl">
          <Eyebrow>Products</Eyebrow>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
            One Platform For Every Repetitive Job
          </h2>
          <p className="mt-3 text-gray-600">
            Start with the one that hurts most. Add the rest when you&rsquo;re
            ready. Everything shares one dashboard, one account and one team
            that builds it for you.
          </p>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {PRODUCT_CARDS.map((p) => (
            <Link
              key={p.title}
              href={p.href}
              className="group flex flex-col rounded-xl border border-gray-200 bg-white p-6 shadow-sm transition hover:border-gray-900"
            >
              <span className="w-max rounded-full bg-lumi-50 px-2.5 py-0.5 text-xs font-semibold text-lumi-700">
                {p.tag}
              </span>
              <h3 className="mt-4 text-lg font-semibold text-gray-900">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">{p.body}</p>
              <ul className="mt-4 flex-1 space-y-1.5">
                {p.bullets.map((b) => (
                  <li key={b} className="flex gap-2 text-sm text-gray-700">
                    <Check /> {b}
                  </li>
                ))}
              </ul>
              <p className="mt-5 text-sm font-medium text-gray-900">{p.price}</p>
              <p className="mt-3 text-sm font-medium text-lumi-700 group-hover:underline">
                {p.cta} &rarr;
              </p>
            </Link>
          ))}
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Who it's for — the industry pages, plus Enterprise                */}
      {/* ---------------------------------------------------------------- */}
      <Section className="pb-20">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
          Built For Your Kind Of Business
        </h2>
        <div className="mt-6 grid gap-6 md:grid-cols-3">
          <Link
            href="/solutions/service"
            className="group rounded-xl border border-gray-200 bg-white p-6 shadow-sm hover:border-gray-900"
          >
            <h3 className="text-lg font-semibold text-gray-900">Service Businesses</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-600">
              HVAC, plumbing, electrical, clinics and salons. Every call
              answered, every job booked, every location ranking.
            </p>
            <p className="mt-4 text-sm font-medium text-gray-900 group-hover:underline">
              See How It Works &rarr;
            </p>
          </Link>

          <Link
            href="/solutions/ecommerce"
            className="group rounded-xl border border-gray-200 bg-white p-6 shadow-sm hover:border-gray-900"
          >
            <h3 className="text-lg font-semibold text-gray-900">Online Stores</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-600">
              Shopify and WooCommerce. &ldquo;Where&rsquo;s my order?&rdquo;
              answered from the real order, and your store found in search.
            </p>
            <p className="mt-4 text-sm font-medium text-gray-900 group-hover:underline">
              See How It Works &rarr;
            </p>
          </Link>

          <a
            href="#enterprise"
            className="group rounded-xl border-2 border-gray-900 bg-gray-900 p-6 text-white shadow-sm hover:bg-gray-800"
          >
            <h3 className="text-lg font-semibold">Multi-Location &amp; Enterprise</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-300">
              Franchises, groups and agencies. Every location and brand on one
              account, with white-label options and a dedicated team.
            </p>
            <p className="mt-4 text-sm font-medium group-hover:underline">
              See Enterprise &rarr;
            </p>
          </a>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Why it works                                                      */}
      {/* ---------------------------------------------------------------- */}
      <Section className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>Why LumiLink Works</Eyebrow>
        <h2 className="mt-4 max-w-2xl text-3xl font-semibold tracking-tight text-gray-900">
          Answered, Found, And Handled, Without Adding Headcount
        </h2>
        <Pillars items={PILLARS} />
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Phone agent detail — what used to be the whole page               */}
      {/* ---------------------------------------------------------------- */}
      <Section id="phone-agent" className="py-20">
        <div className="max-w-2xl">
          <Eyebrow>AI Phone Agent</Eyebrow>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
            One Agent That Finishes The Job
          </h2>
          <p className="mt-3 text-gray-600">
            A conversation that ends with an appointment on your calendar, by
            phone or on your website.
          </p>
        </div>
        <CapabilityGrid items={CAPABILITIES} />
        <p className="mt-10 text-sm text-gray-500">
          Building next: a dashboard view of what your customers are actually
          asking for.
        </p>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Inside the dashboard — calls and rankings side by side            */}
      {/* ---------------------------------------------------------------- */}
      <Section
        id="inside-the-dashboard"
        className="border-t border-gray-200 bg-gray-50 py-20"
      >
        <div className="max-w-2xl">
          <Eyebrow>Inside The Dashboard</Eyebrow>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
            Every Call, Chat And Ranking In One Place
          </h2>
          <p className="mt-3 text-gray-600">
            This is the same dashboard your account gets. Every conversation
            becomes a transcript, anything Lumi couldn&rsquo;t finish lands in a
            queue, and your rankings update every week.
          </p>
        </div>
        <div className="mt-12 grid gap-x-10 gap-y-12 md:grid-cols-2">
          <ConversationsMockup caption="Admin dashboard — Conversations" />
          <SeoPortalMockup caption="Client portal — SEO + AI Search" />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* How it works                                                      */}
      {/* ---------------------------------------------------------------- */}
      <Section id="how" className="py-20">
        <Eyebrow>How LumiLink Works</Eyebrow>
        <h2 className="mt-4 max-w-2xl text-3xl font-semibold tracking-tight text-gray-900">
          Pick What To Automate. We Handle The Rest.
        </h2>
        <p className="mt-3 max-w-2xl text-gray-600">
          A customer who reaches you at 2am gets an answer instead of a
          competitor&rsquo;s voicemail, and one who searches for what you do
          finds you instead of them. You don&rsquo;t configure any of it
          yourself.
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
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Pricing: the plan finder, not one product's ladder                */}
      {/* ---------------------------------------------------------------- */}
      <Section id="finder" className="border-t border-gray-200 bg-gray-50 py-20">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div className="max-w-2xl">
            <Eyebrow>Pricing</Eyebrow>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
              Let Us Figure Out What Your Business Needs
            </h2>
            <p className="mt-3 text-gray-600">
              Answer a few questions and we&rsquo;ll recommend the right
              products with a monthly estimate. No setup fee on phone plans,
              and the full SEO bundle saves {usd(bundle.baseMonthlyUsd)}/mo.
            </p>
          </div>
          <Link
            href="/pricing"
            className="shrink-0 text-sm font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700"
          >
            See Every Plan And Price
          </Link>
        </div>
        <div className="mt-10">
          <PlanFinder
            prices={finderPrices()}
            signupHref={SIGNUP_CTA}
            seoSignupHref={seoHref}
            enterpriseHref={contactHref("/", "Enterprise / White Label")}
          />
        </div>
      </Section>

      <EnterpriseBand contactSource="/" />

      <FaqList items={FAQS} />

      <ClosingCta
        heading="Stop Doing The Work A System Should Do"
        body="Tell us what's eating your week. We build the automation, test it, and hand you a dashboard that shows every call, chat and ranking."
      />
    </MarketingShell>
  );
}
