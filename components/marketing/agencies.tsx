// "/solutions/agencies" — agencies and resellers (2026-10-16).
//
// The Solutions menu was industries only. RogIQ's strongest page is the one
// for agency owners, so this is ours (docs/rogiq-site-plan.md item 2): who
// the buyer is, not what industry. /partners/agency-white-label stays as the
// noindex referral page for ecommerce agencies; this one is public and covers
// every product.
//
// CLAIMS STAY INSIDE WHAT WE ALREADY PROMISE. White label is the same promise
// EnterpriseBand makes ("resell under your own brand"), with terms agreed per
// partner, so no branded portal, subdomain or client count is quoted here.
// No client is named, and no results are quoted until we have real ones
// (leadership, 2026-10-16).

import Link from "next/link";
import { MarketingShell } from "@/components/marketing/shell";
import {
  Accent,
  CapabilityGrid,
  Check,
  ClosingCta,
  contactHref,
  Eyebrow,
  FaqList,
  Pillars,
  Section,
} from "@/components/marketing/blocks";
import { AutomationFeedMockup } from "@/components/marketing/dashboard-mockups";

export const AGENCIES_METADATA = {
  title: "AI Phone Agents And SEO For Agencies And Resellers | LumiLink",
  description:
    "Offer every client an AI phone agent, website chat and SEO + AI search, built and run by our team. Keep the client relationship; resell under your own brand.",
};

const CONTACT = contactHref("/solutions/agencies", "Enterprise / White Label");

const PROBLEMS = [
  {
    n: "01",
    title: "Every New Client Means Another Hire",
    body: "Growth stalls on delivery, not sales. Each account adds work, and hiring to keep up just moves the bottleneck.",
  },
  {
    n: "02",
    title: "Clients Ask Whether AI Can Just Do It",
    body: "They're pitched AI tools every week. Without something real to offer, the retainer starts to look expensive.",
  },
  {
    n: "03",
    title: "The Revenue Stops When The Project Does",
    body: "The site launches, the campaign ends, and the invoice ends with it. Recurring work is what keeps a client.",
  },
];

const OFFER = [
  {
    title: "An AI Phone Agent Per Client",
    body: "Answers each client's calls 24/7, quotes from their prices and books into their calendar.",
  },
  {
    title: "Website Chat",
    body: "The same agent on each client's website, trained on their business.",
  },
  {
    title: "SEO + AI Search",
    body: "Weekly audits, rank tracking and AI search visibility for each client's website and locations.",
  },
  {
    title: "Nothing Goes Live Unapproved",
    body: "SEO fixes are drafted for approval before anything is published to a client's site.",
  },
  {
    title: "Your Team, With The Right Access",
    body: "Invite your staff as viewers, agents or admins, so each person sees and changes only what they should.",
  },
  {
    title: "We Do The Build",
    body: "Our team sets up and tests every client. You don't need developers or prompt engineers.",
  },
];

const STEPS = [
  {
    n: "1",
    title: "Tell Us About Your Clients",
    body: "Which clients, which products, and whether you'd rather refer, resell or bundle it into your retainer.",
  },
  {
    n: "2",
    title: "We Build Each Client",
    body: "We set up and test each client's phone agent, chat and SEO from their own information.",
  },
  {
    n: "3",
    title: "You Keep The Relationship",
    body: "You own the strategy conversation and the invoice. We run the system underneath it.",
  },
];

const FAQS = [
  {
    q: "Do We Lose The Client Relationship?",
    a: "No. You keep the strategy conversation and the client relationship. We run the system behind it.",
  },
  {
    q: "Can We Resell It Under Our Own Brand?",
    a: "Yes. White-label terms are agreed with each partner, so tell us how you work with your clients and we'll set it up around that.",
  },
  {
    q: "How Do We Price It To Clients?",
    a: "Referral, wholesale, or bundled into your retainer, your choice. We set up whichever model fits how you already bill.",
  },
  {
    q: "Does Our Team Need To Be Technical?",
    a: "No. We build and test every client's setup. Your team reviews conversations, approves SEO changes and reads the reports.",
  },
];

export function AgenciesSolution() {
  return (
    <MarketingShell>
      <Section className="bg-[radial-gradient(ellipse_55%_60%_at_78%_45%,var(--color-lumi-100),transparent)] pb-20 pt-16 md:pb-28 md:pt-24">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <Eyebrow>For Agencies &amp; Resellers</Eyebrow>
            <h1 className="mt-4 display-hero text-gray-900">
              Sell More To Every Client. <Accent>Hire No One To Deliver It.</Accent>
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-gray-600">
              Offer every client an AI phone agent, website chat and SEO + AI
              search, built and run by our team. You keep the relationship and
              the retainer.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href={CONTACT}
                className="rounded-md bg-gray-900 px-5 py-3 text-sm font-medium text-white hover:bg-gray-800"
              >
                Talk To Us
              </a>
              <Link
                href="/products"
                className="rounded-md border border-gray-300 px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                See The Products
              </Link>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500">
              <li className="flex items-center gap-2">
                <Check /> White Label
              </li>
              <li className="flex items-center gap-2">
                <Check /> Every Client, One Account
              </li>
              <li className="flex items-center gap-2">
                <Check /> We Do The Build
              </li>
            </ul>
          </div>
          <AutomationFeedMockup
            caption="One dashboard across every client"
            className="min-w-0"
          />
        </div>
      </Section>

      <Section className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>Sound Familiar?</Eyebrow>
        <h2 className="reveal mt-4 max-w-2xl display-section text-gray-900">
          The Bottleneck Is Delivery, Not Sales
        </h2>
        <Pillars items={PROBLEMS} />
      </Section>

      <Section className="py-20">
        <div className="max-w-2xl">
          <Eyebrow>What You Can Offer</Eyebrow>
          <h2 className="reveal mt-4 display-section text-gray-900">
            Recurring Services, Without A Delivery Team
          </h2>
          <p className="mt-3 text-gray-600">
            Every LumiLink product, set up for each of your clients.
          </p>
        </div>
        <CapabilityGrid items={OFFER} />
      </Section>

      <Section className="border-t border-gray-200 py-20">
        <Eyebrow>How It Works</Eyebrow>
        <h2 className="reveal mt-4 max-w-2xl display-section text-gray-900">
          You Sell It. We Build It. You Keep The Client.
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

      <FaqList items={FAQS} heading="What Agencies Ask" />

      <ClosingCta
        heading="Add Recurring Revenue To Every Client"
        body="Tell us about your clients and how you'd like to sell it. We'll put a partner setup together around that."
        cta="Talk To Us"
        href={CONTACT}
      />
    </MarketingShell>
  );
}
