// LP-1 — "/partners/merchant-support". Turnkey brand, creator, and
// dropshipping platforms (source: the Landing_Pages tab of
// docs/LumiLink Partnership Acquisition CRM.xlsx). Noindex, unlinked from
// nav — reached only by a link a partner shares with their own contacts.

import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/shell";
import { CapabilityGrid, Eyebrow, FaqList, Section } from "@/components/marketing/blocks";
import { PartnerClosingCta, PartnerHero, ProofBar } from "@/components/marketing/partner-blocks";
import { DemoToggle } from "@/components/marketing/demo-toggle";
import { enterpriseContactHref } from "@/lib/entitlements";

export const MERCHANT_SUPPORT_METADATA: Metadata = {
  title: "Partner With LumiLink | Merchant Support",
  description:
    "White-label a managed customer-service operation across phone and site chat for every merchant on your platform.",
};

const CTA_HREF = enterpriseContactHref("Design My Partner Pilot: Merchant Support");

const WHAT_MERCHANTS_RECEIVE = [
  {
    title: "Phone that answers 24/7",
    body: "Quotes, books, and takes messages using the merchant's real information, not a script.",
  },
  {
    title: "A site chat widget",
    body: "Same knowledge behind it as the phone line, so a customer gets the same answer either way.",
  },
  {
    title: "Order lookup from the real store",
    body: "Pulled from the merchant's actual Shopify or WooCommerce order, not a canned response.",
  },
  {
    title: "Identity verification first",
    body: "No order detail gets read out before the caller is verified.",
  },
  {
    title: "Escalation tickets",
    body: "Anything Lumi can't finish becomes a ticket in a follow-up queue, not a dropped call.",
  },
  {
    title: "Full transcripts, branded portal",
    body: "Every conversation logged where you and the merchant can both see it.",
  },
];

const DEMO_TABS = [
  {
    label: "Phone call",
    body: "A customer calls asking where their order is. Lumi verifies them, pulls the order, reads the status and tracking number, and confirms delivery timing, all in one call.",
  },
  {
    label: "Web chat",
    body: "The same question, asked through the merchant's site widget instead of the phone. Same knowledge, same order lookup, same answer.",
  },
  {
    label: "Order lookup",
    body: "Behind both channels: a live query against the merchant's store, not a static FAQ answer.",
  },
  {
    label: "Callback ticket",
    body: "A return request needs a human decision. Lumi logs it as a ticket with the order attached and hands it to the merchant's queue.",
  },
  {
    label: "Portal transcript",
    body: "The full conversation, timestamped and attributed to the order, visible in your branded partner portal.",
  },
];

const FAQS = [
  {
    q: "Does This Replace Our Support Team Entirely?",
    a: "No. It automates a large share of Tier 0 and Tier 1 phone and web questions. Anything outside that reaches a person instead of a dead end.",
  },
  {
    q: "What Does This Cost?",
    a: "Pricing is custom per partner, built around your merchant volume and the offer you want to run. We price your pilot directly rather than quoting off a public rate card.",
  },
  {
    q: "Is Email Support Included?",
    a: "Not at production scale yet. Phone and web chat are what we run today. Email automation would be scoped as its own project.",
  },
  {
    q: "Which Platforms Does Order Lookup Support?",
    a: "Shopify and WooCommerce today, with parity between the two. A merchant on a different platform would need to be scoped separately.",
  },
];

export function MerchantSupportPartner() {
  return (
    <MarketingShell>
      <PartnerHero
        kicker="A More Complete Business For Every Customer You Launch"
        headline="Give Every Merchant a Customer-Service Team, Under Your Brand"
        subhead="LumiLink white-labels a managed support operation across phone and site chat, with ecommerce order lookup, customer verification, escalation tickets, transcripts, and a partner-ready portal."
        primaryLabel="Design My Partner Pilot"
        primaryHref={CTA_HREF}
        secondaryLabel="See the Merchant Experience"
        secondaryHref="#demo"
      />
      <ProofBar
        items={[
          "White-label",
          "Shopify/WooCommerce-aware",
          "Managed setup",
          "Launch-ready in as little as 24 hours after inputs are approved",
        ]}
      />

      {/* 1. Revenue opportunity */}
      <Section className="border-t border-gray-200 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Every Merchant You Onboard Needs Support On Day One
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            Your merchants launch fast, then hit the hard part: answering
            customers. Most platforms leave that gap for the merchant to fill
            alone, and most fill it badly. Close it yourself and it becomes a
            new revenue line on every account you already have.
          </p>
        </div>
      </Section>

      {/* 2. What merchants receive */}
      <Section className="border-t border-gray-200 bg-gray-50 py-16">
        <div className="max-w-2xl">
          <Eyebrow>What Merchants Receive</Eyebrow>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight text-gray-900">
            One Phone Number, One Widget, Every Channel Covered
          </h2>
        </div>
        <CapabilityGrid items={WHAT_MERCHANTS_RECEIVE} />
      </Section>

      {/* 3. Why managed beats DIY */}
      <Section className="border-t border-gray-200 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Merchants Won&rsquo;t Build This Themselves, And Won&rsquo;t
            Maintain It If They Do
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            A merchant can wire up a chatbot in an afternoon and abandon it in
            a month. Managed means we configure it, tune it against real
            conversations, and keep it current as their catalog changes. You
            sell the outcome. We run the operation behind it.
          </p>
        </div>
      </Section>

      {/* 4. White-label experience */}
      <Section className="border-t border-gray-200 bg-gray-50 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Your Brand On Every Screen A Merchant Sees
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            The portal, the transcripts, and the support experience carry your
            name, not ours. A merchant working with you never has to know
            LumiLink is running underneath it.
          </p>
        </div>
      </Section>

      <Section id="demo" className="border-t border-gray-200 bg-gray-50 py-16">
        <div className="max-w-2xl">
          <Eyebrow>See The Merchant Experience</Eyebrow>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight text-gray-900">
            Toggle Through What A Customer Actually Sees
          </h2>
        </div>
        <div className="mt-8">
          <DemoToggle tabs={DEMO_TABS} />
        </div>
      </Section>

      {/* 5. Pilot economics */}
      <Section className="border-t border-gray-200 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Start With 5 To 10 Merchants
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            Pricing is custom, built around wholesale or attach-fee structures
            rather than a public rate card. During the pilot we track
            activation, containment, escalations, retention, and attach rate
            together, so the number that matters to your business is the one
            we&rsquo;re actually measuring.
          </p>
        </div>
      </Section>

      {/* 6. 3-step onboarding */}
      <Section className="border-t border-gray-200 bg-gray-50 py-16">
        <Eyebrow>Onboarding</Eyebrow>
        <h2 className="mt-4 max-w-2xl text-2xl font-semibold tracking-tight text-gray-900">
          Three Steps From Approval To Live
        </h2>
        <div className="mt-10 grid gap-10 md:grid-cols-3">
          {[
            {
              n: "1",
              title: "Approve the setup",
              body: "You review branding, catalog access, and escalation rules before anything goes live.",
            },
            {
              n: "2",
              title: "We configure and test",
              body: "Every merchant account gets its own knowledge base, tested against real questions before launch.",
            },
            {
              n: "3",
              title: "Merchants go live",
              body: "Support starts answering within about 24 hours of approved inputs, per merchant.",
            },
          ].map((s) => (
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

      <FaqList items={FAQS} heading="Questions Partners Ask" />

      <PartnerClosingCta
        heading="Ready To Give Every Merchant A Support Team On Day One?"
        body="Tell us about your platform and how many merchants you'd want to start with. We'll come back with a pilot shape, not a generic deck."
        ctaLabel="Design My Partner Pilot"
        ctaHref={CTA_HREF}
      />
    </MarketingShell>
  );
}
