// LP-3 — "/partners/agency-white-label". Ecommerce and Shopify agencies
// (source: Landing_Pages tab of docs/LumiLink Partnership Acquisition CRM.xlsx).
// Noindex, unlinked from nav.

import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/shell";
import { CapabilityGrid, Eyebrow, FaqList, Section } from "@/components/marketing/blocks";
import { PartnerClosingCta, PartnerHero, ProofBar } from "@/components/marketing/partner-blocks";
import { DemoToggle } from "@/components/marketing/demo-toggle";
import { enterpriseContactHref } from "@/lib/entitlements";

export const AGENCY_WHITE_LABEL_METADATA: Metadata = {
  title: "Partner With LumiLink | Agency White Label",
  description:
    "Add managed, white-label customer support to every commerce engagement and turn it into recurring revenue.",
};

const CTA_HREF = enterpriseContactHref("Select 3 Pilot Clients: Agency White Label");

const WHAT_LUMILINK_OPERATES = [
  {
    title: "Phone and site chat",
    body: "Configured per client, using the knowledge and policies you approve.",
  },
  {
    title: "Order lookup and status",
    body: "Pulled from the client's real store, on Shopify or WooCommerce.",
  },
  {
    title: "Escalation tickets",
    body: "Routed to whoever the client designates, not a shared inbox.",
  },
  {
    title: "Transcripts and resolution stats",
    body: "Visible in a portal that carries your agency's branding.",
  },
  {
    title: "Ongoing tuning",
    body: "As the client's catalog and policies change, so does what Lumi knows.",
  },
];

const DEMO_TABS = [
  {
    label: "Agency portal",
    body: "Your branding on the login screen and every page after it. A client working with you never sees LumiLink's name.",
  },
  {
    label: "Transcripts",
    body: "Every conversation logged per client, searchable, timestamped.",
  },
  {
    label: "Ticket queue",
    body: "Anything Lumi can't finish lands here, routed to whoever the client wants handling it.",
  },
  {
    label: "Website widget",
    body: "The same knowledge as the phone line, embedded on the client's own site.",
  },
  {
    label: "Phone flow",
    body: "A caller reaches a real conversation: answers questions, checks orders, books what needs booking.",
  },
];

const FAQS = [
  {
    q: "Do We Lose The Client Relationship?",
    a: "No. You keep the strategy conversation and the client relationship. We run the support operation behind it.",
  },
  {
    q: "Is This Exclusive To Our Agency?",
    a: "No exclusivity is offered or implied. Every partner runs the same pilot terms.",
  },
  {
    q: "Will This Guarantee Lower Support Costs For Our Clients?",
    a: "We don't guarantee a savings number upfront. The pilot measures the real numbers for your specific clients before you price it.",
  },
  {
    q: "How Do We Price It To Clients?",
    a: "Referral, wholesale, or bundled into your retainer, your choice. We set up whichever model fits how you already bill.",
  },
];

export function AgencyWhiteLabelPartner() {
  return (
    <MarketingShell>
      <PartnerHero
        kicker="Recurring Revenue After The Storefront Goes Live"
        headline="Add Managed Customer Support to Every Commerce Engagement"
        subhead="You own the client relationship. LumiLink supplies the white-label phone, site chat, order lookup, ticketing, portal, and ongoing optimization, so your agency can add recurring revenue without building an operations team."
        primaryLabel="Select 3 Pilot Clients"
        primaryHref={CTA_HREF}
        secondaryLabel="View the White-Label Portal"
        secondaryHref="#demo"
      />
      <ProofBar
        items={[
          "Agency-branded",
          "Managed delivery",
          "Commerce-aware",
          "Escalation-ready",
          "Monthly recurring revenue",
        ]}
      />

      {/* 1. Post-launch revenue gap */}
      <Section className="border-t border-gray-200 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            The Build Ends. The Client Relationship Doesn&rsquo;t Have To.
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            You launch the storefront, hand it over, and move to the next
            client. Support isn&rsquo;t part of that handoff, so the revenue
            stops the day the site goes live. Add support, and the
            relationship, and the invoice, keep going.
          </p>
        </div>
      </Section>

      {/* 2. What the agency sells */}
      <Section className="border-t border-gray-200 bg-gray-50 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            You Keep The Strategy Conversation
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            Position it as part of your retainer: a support layer that comes
            with every build, priced how you already price your other retained
            services.
          </p>
        </div>
      </Section>

      {/* 3. What LumiLink operates */}
      <Section className="border-t border-gray-200 py-16">
        <div className="max-w-2xl">
          <Eyebrow>What LumiLink Operates</Eyebrow>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight text-gray-900">
            Everything Underneath The Storefront&rsquo;s Support Tab
          </h2>
        </div>
        <CapabilityGrid items={WHAT_LUMILINK_OPERATES} />
      </Section>

      <Section id="demo" className="border-t border-gray-200 bg-gray-50 py-16">
        <div className="max-w-2xl">
          <Eyebrow>Client Experience</Eyebrow>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight text-gray-900">
            What A Client Sees Once It&rsquo;s Live
          </h2>
        </div>
        <div className="mt-8">
          <DemoToggle tabs={DEMO_TABS} />
        </div>
      </Section>

      {/* 5. Pricing models */}
      <Section className="border-t border-gray-200 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Referral, Wholesale, Or Bundled: Your Choice
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            Refer clients directly and take a commission, buy wholesale and
            set your own retail price, or fold it into a bundled retainer.
            We&rsquo;ll set up whichever model fits how you already bill.
          </p>
        </div>
      </Section>

      {/* 6. Pilot */}
      <Section className="border-t border-gray-200 bg-gray-50 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Three Retained Clients, Thirty Days
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            Pick three clients you already manage. We run a joint discovery
            call, set the pilot up together, and measure it over 30 days
            before either of us decides to expand.
          </p>
        </div>
      </Section>

      <FaqList items={FAQS} heading="Questions We Hear From Agencies" />

      <PartnerClosingCta
        heading="Ready To Add Support To Every Engagement?"
        body="Tell us how many clients you'd want to start with and how you'd want to price it. We'll come back with a pilot shape, not a generic deck."
        ctaLabel="Select 3 Pilot Clients"
        ctaHref={CTA_HREF}
      />
    </MarketingShell>
  );
}
