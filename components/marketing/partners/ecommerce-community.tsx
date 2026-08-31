// LP-4 — "/partners/ecommerce-community". Selective educators and creator
// communities (source: Landing_Pages tab of
// docs/LumiLink Partnership Acquisition CRM.xlsx). Noindex, unlinked from nav.
//
// GUARDRAIL FROM THE SHEET, READ THIS BEFORE SENDING THE LINK ANYWHERE:
// "Use only where an active, paid community is verified. Avoid mass beginner
// audiences and income claims." The "Who qualifies" section below states that
// filter directly rather than burying it — this page should not be handed to
// a beginner-audience funnel, and nothing on it promises an income outcome.

import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/shell";
import { Eyebrow, Section } from "@/components/marketing/blocks";
import { PartnerClosingCta, PartnerHero, ProofBar } from "@/components/marketing/partner-blocks";
import { enterpriseContactHref } from "@/lib/entitlements";

export const ECOMMERCE_COMMUNITY_METADATA: Metadata = {
  title: "Partner With LumiLink | Ecommerce Communities",
  description:
    "A referral or cohort add-on that gives your community's serious operators branded phone and site support from day one.",
};

const CTA_HREF = enterpriseContactHref("Discuss a Cohort Pilot: Ecommerce Community");

const ONBOARDING_STEPS = [
  {
    n: "1",
    title: "We review the store together",
    body: "A short intake covering what the store sells, its policies, and its hours: what Lumi needs to answer correctly.",
  },
  {
    n: "2",
    title: "We configure and test",
    body: "Phone and widget both get set up and tested against real questions before the operator hears from a customer.",
  },
  {
    n: "3",
    title: "The operator goes live",
    body: "Within the approved setup workflow, with no code and nothing new to learn.",
  },
];

export function EcommerceCommunityPartner() {
  return (
    <MarketingShell>
      <PartnerHero
        kicker="Help Members Operate Like Real Businesses"
        headline="Give Your Best Operators a Customer-Service System From Day One"
        subhead="A referral or cohort add-on that gives serious ecommerce operators branded phone and site support, order lookup, tickets, transcripts, and a managed portal, without making them learn another tool."
        primaryLabel="Discuss a Cohort Pilot"
        primaryHref={CTA_HREF}
        secondaryLabel="See the Operator Setup"
        secondaryHref="#setup"
      />
      <ProofBar
        items={[
          "No-code onboarding",
          "Managed setup",
          "Branded experience",
          "Ecommerce-aware",
        ]}
      />

      {/* 1. Student execution gap */}
      <Section className="border-t border-gray-200 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Launching The Store Is The Easy Part
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            Your most serious operators get past building the store and hit
            the same wall every real business hits: customers ask questions
            faster than one person can answer them. That&rsquo;s where
            operators either scale past hobby status or stall out.
          </p>
        </div>
      </Section>

      {/* 2. Who qualifies — the guardrail, stated directly */}
      <Section className="border-t border-gray-200 bg-gray-50 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Built For Operators Already Running A Real Store
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            This is for launch-ready and established stores inside an active,
            paid community, not a beginner audience still building their first
            product page. We don&rsquo;t sell this as a shortcut to income,
            and we won&rsquo;t run it as one.
          </p>
        </div>
      </Section>

      {/* 3. Demo — a sequence, not parallel channels, so a step list fits
          the sheet's brief ("show a new store being onboarded... within the
          approved setup workflow") better than the tab toggle used on the
          other three partner pages. */}
      <Section id="setup" className="border-t border-gray-200 py-16">
        <Eyebrow>The Operator Setup</Eyebrow>
        <h2 className="mt-4 max-w-2xl text-2xl font-semibold tracking-tight text-gray-900">
          From Intake To A Working Phone And Widget
        </h2>
        <div className="mt-10 grid gap-10 md:grid-cols-3">
          {ONBOARDING_STEPS.map((s) => (
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

      {/* 4. Cohort offer */}
      <Section className="border-t border-gray-200 bg-gray-50 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            An Invite-Only Cohort Of 10 Stores
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            We onboard a small group at once, all from the same community, so
            we can compare results across operators running similar
            businesses.
          </p>
        </div>
      </Section>

      {/* 5. Referral economics */}
      <Section className="border-t border-gray-200 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            A Referral Line For Your Community, Not A Product Plug
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            Set up as a referral arrangement between your community and
            LumiLink. We&rsquo;ll work out the specifics with you directly
            rather than fitting it into a generic affiliate rate.
          </p>
        </div>
      </Section>

      {/* 6. Results scorecard */}
      <Section className="border-t border-gray-200 bg-gray-50 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Track What Your Members Actually Improve
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            We measure response time, resolved questions, and how much time it
            gives operators back, so you can show your community real
            outcomes instead of a testimonial.
          </p>
        </div>
      </Section>

      <PartnerClosingCta
        heading="Ready To Bring This To Your Community?"
        body="Tell us about your community and the operators you'd want in the first cohort. We'll come back with a pilot shape, not a generic deck."
        ctaLabel="Discuss a Cohort Pilot"
        ctaHref={CTA_HREF}
      />
    </MarketingShell>
  );
}
