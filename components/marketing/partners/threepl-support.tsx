// LP-2 — "/partners/3pl-customer-support". 3PLs, fulfillment platforms, and
// ecommerce workspaces (source: Landing_Pages tab of
// docs/LumiLink Partnership Acquisition CRM.xlsx). Noindex, unlinked from nav.

import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/shell";
import { Eyebrow, FaqList, Section } from "@/components/marketing/blocks";
import { PartnerClosingCta, PartnerHero, ProofBar, partnerContactHref } from "@/components/marketing/partner-blocks";
import { DemoToggle } from "@/components/marketing/demo-toggle";

export const THREEPL_SUPPORT_METADATA: Metadata = {
  title: "Partner With LumiLink | 3PL & Fulfillment Support",
  description:
    "Turn your order and tracking data into automated, branded customer support for the merchants you fulfill for.",
};

const CTA_HREF = partnerContactHref(
  "/partners/3pl-customer-support",
  "3PL Support Pilot",
);

const DEMO_TABS = [
  {
    label: "Call in",
    body: "A customer calls asking where their order is. Lumi verifies them and reads the current status and tracking number straight from the order.",
  },
  {
    label: "Web chat",
    body: "Same question through the merchant's site widget. Same order lookup, same answer, no phone required.",
  },
  {
    label: "Order lookup",
    body: "A live query against the merchant's store for the order in question, not a static tracking-page link.",
  },
  {
    label: "Exception ticket",
    body: "A damaged shipment or a disputed charge doesn't get guessed at. Lumi opens a ticket with the order attached and routes it to your team.",
  },
];

const FAQS = [
  {
    q: "Does This Connect Directly To Our WMS?",
    a: "Shopify and WooCommerce order lookup work today. A direct WMS integration is something we scope per system, so tell us what you're running and we'll work out the fit.",
  },
  {
    q: "What Data Does Lumi See?",
    a: "Only what it needs to answer a specific question: order status, tracking, and what's required to verify the customer asking. Nothing more.",
  },
  {
    q: "Who Owns The Merchant Relationship?",
    a: "You do. LumiLink runs the support layer underneath it.",
  },
  {
    q: "What Does This Cost?",
    a: "Pricing is custom, built around your merchant count and how you want to sell it: bundled into your fee or offered as a paid add-on.",
  },
];

export function ThreePlSupportPartner() {
  return (
    <MarketingShell>
      <PartnerHero
        kicker="Your Fulfillment Data Should Answer Customer Questions"
        headline="Turn Order Visibility Into Automated Customer Support"
        subhead="Give merchants a managed, branded phone and web support layer for tracking, order status, returns triage, and address-change requests, without asking your operations team to become a call center."
        primaryLabel="Start The Conversation"
        primaryHref={CTA_HREF}
        secondaryLabel="How A WISMO Call Resolves"
        secondaryHref="#demo"
      />
      <ProofBar
        items={[
          "Order lookup",
          "Verification",
          "Callback tickets",
          "Escalation",
          "Custom portal",
          "Managed tuning",
        ]}
      />

      {/* 1. WISMO problem */}
      <Section className="border-t border-gray-200 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            &ldquo;Where&rsquo;s My Order&rdquo; Is The Call Your Team Answers
            Most And Enjoys Least
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            Every 3PL runs into the same volume: order status, tracking, and
            returns questions that repeat all day and rarely need a person.
            Your ops team keeps fulfilling orders while those calls pile up
            somewhere else, usually on the merchant.
          </p>
        </div>
      </Section>

      <Section id="demo" className="border-t border-gray-200 bg-gray-50 py-16">
        <div className="max-w-2xl">
          <Eyebrow>Customer Journey</Eyebrow>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight text-gray-900">
            Follow A WISMO Question Through Resolution
          </h2>
        </div>
        <div className="mt-8">
          <DemoToggle tabs={DEMO_TABS} />
        </div>
      </Section>

      {/* 3. Exception handoff */}
      <Section className="border-t border-gray-200 bg-gray-50 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Routine Questions Get Answered. Real Exceptions Get A Person.
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            Lumi resolves tracking, status, and standard returns questions
            directly from the order. When something falls outside that, a
            damaged shipment or a disputed charge, it opens a ticket and hands
            it to your team with the order already attached.
          </p>
        </div>
      </Section>

      {/* 4. Merchant portal */}
      <Section className="border-t border-gray-200 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            One Portal, Every Merchant, Your Branding
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            Each merchant sees their own transcripts, tickets, and resolution
            stats in a portal that carries your name. You decide what
            merchants see. We run what&rsquo;s underneath it.
          </p>
        </div>
      </Section>

      {/* 5. Revenue/retention options */}
      <Section className="border-t border-gray-200 bg-gray-50 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Sell It As A Feature Or As An Add-On
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            Bundle it into your standard fulfillment fee as a retention
            feature, or price it as a paid add-on merchants opt into. Either
            way, fewer support tickets land on your operations line, and
            merchants get an answer faster than a ticket queue gives them.
          </p>
        </div>
      </Section>

      {/* 6. Pilot scorecard */}
      <Section className="border-t border-gray-200 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            One Location Or Five To Ten Merchants To Start
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            Run the pilot at a single location, with three of your 3PL
            customers, or across five to ten merchants directly. We track
            automated resolution rate, response time, ticket reduction,
            merchant adoption, and any add-on revenue, so you get numbers you
            can take into your next merchant conversation.
          </p>
        </div>
      </Section>

      <FaqList
        items={FAQS}
        heading="Security, Data, And Scope Questions"
      />

      <PartnerClosingCta
        heading="Ready To Stop Absorbing WISMO Calls?"
        body="Tell us how many merchants or locations you'd want to start with. We'll come back with a pilot shape, not a generic deck."
        ctaLabel="Start The Conversation"
        ctaHref={CTA_HREF}
      />
    </MarketingShell>
  );
}
