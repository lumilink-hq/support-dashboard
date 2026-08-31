// The "Our Story" page — the founder-led credibility argument that the
// features pages can't make on their own.
//
// Positioning source: the 2026-08-30 repositioning brief. The thesis this page
// exists to carry is "built by an owner-operator who lived this problem
// first," not "an AI company built a phone bot." Copy passed through the
// stop-slop pass before landing here — no em dashes, no "not X, it's Y"
// contrasts, active voice throughout.
//
// Numbers ($50M+ combined, $7M+ in the first 7 months) are outcomes, not
// industry-specific — deliberately no vertical named, per the brief.

import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/shell";
import { ClosingCta, Eyebrow, Pillars, Section } from "@/components/marketing/blocks";

export const STORY_METADATA: Metadata = {
  title: "Our Story | LumiLink",
  description:
    "LumiLink was built by an owner who scaled multiple businesses and hit the same wall every time: customer service didn't scale with the rest of it.",
};

const PILLARS = [
  {
    n: "01",
    title: "Automate What Repeats",
    body: "Lumi handles the calls, the reschedules, the routine questions that eat your day.",
  },
  {
    n: "02",
    title: "Escalate What Matters",
    body: "When a customer needs a real person, a real person answers.",
  },
  {
    n: "03",
    title: "Built By People Who've Done This",
    body: "The people making these decisions have run a business like yours.",
  },
];

export function OurStory() {
  return (
    <MarketingShell>
      {/* ---------------------------------------------------------------- */}
      {/* Hero                                                             */}
      {/* ---------------------------------------------------------------- */}
      <Section className="pb-16 pt-16 md:pb-20 md:pt-24">
        <div className="max-w-2xl">
          <Eyebrow>Our Story</Eyebrow>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
            We Built This Because We Needed It Ourselves
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-gray-600">
            LumiLink didn&rsquo;t start as a pitch deck. It started because
            answering the phone was eating our own business.
          </p>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* The scale                                                        */}
      {/* ---------------------------------------------------------------- */}
      <Section className="border-t border-gray-200 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            We&rsquo;ve Scaled Businesses Before This One
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            Our founder grew multiple businesses from the ground up: over $50
            million in combined revenue, one of them past $7 million in its
            first seven months. We still run a multi-location business today,
            and LumiLink came out of it.
          </p>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* The breaking point                                               */}
      {/* ---------------------------------------------------------------- */}
      <Section className="border-t border-gray-200 bg-gray-50 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Customer Service Was The Bottleneck
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            Each of those businesses hit the same wall. Growth meant more
            calls, more questions, more repeat customers, and no realistic way
            to answer all of it personally. Hiring ahead of revenue is a bet
            most owners can&rsquo;t afford. So we built the system we needed,
            then decided other owners needed it too.
          </p>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* What got built                                                   */}
      {/* ---------------------------------------------------------------- */}
      <Section className="border-t border-gray-200 py-16">
        <Eyebrow>What Came Out Of It</Eyebrow>
        <Pillars items={PILLARS} />
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Where it's going                                                 */}
      {/* ---------------------------------------------------------------- */}
      <Section className="border-t border-gray-200 bg-gray-50 py-16">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Phone Was The Start
          </h2>
          <p className="mt-4 leading-relaxed text-gray-600">
            We started with the phone because it was the loudest problem.
            We&rsquo;re building toward more: one place where Lumi handles
            every conversation with your customers, call, chat, or message, so
            nothing gets lost. Phone is the flagship, and the other pieces are
            coming next.
          </p>
        </div>
      </Section>

      <ClosingCta
        heading="See What Lumi Can Take Off Your Plate"
        body="Tell us about your business, and we'll show you what we'd automate first."
      />
    </MarketingShell>
  );
}
