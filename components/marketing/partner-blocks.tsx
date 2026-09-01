// Shared primitives for the partner/channel landing pages under /partners/*.
//
// WHY A SEPARATE FILE FROM blocks.tsx. blocks.tsx's charter is explicitly "every
// block that touches a PRICE" — PLAN_TIERS, STARTER_PLAN, OVERAGE. Partner deals
// are custom-quoted, not on that ladder (see docs/BUILD-PLAN-2026-08.md §D:
// Enterprise/white-label is contact-us only, no plan_tiers row). Keeping these
// primitives separate means a partner page can never accidentally pull in a
// self-serve price it isn't allowed to quote.
//
// These pages are noindex and unlinked from the nav (2026-08-30 repositioning
// brief: partner pages are referral destinations, reached by a link the partner
// shares, not a site section someone browses to).
//
// CTAs go through /contact (partnerContactHref, below), not a mailto link.
// They used to point at enterpriseContactHref() — boss feedback 2026-08-31:
// a mailto CTA makes someone draft their own email from scratch, which is the
// opposite of "easy to engage with us." /contact existed by then, so this
// switched to it and pre-fills the topic instead of asking them to write it.

import Link from "next/link";
import { Check, Eyebrow, Section, contactHref } from "@/components/marketing/blocks";

/**
 * Re-exported under the partner-specific name the four /partners/* pages
 * already import. The implementation moved to blocks.tsx once /plans and
 * PricingGrid's Enterprise CTA needed the exact same "/contact with a
 * pre-filled topic" behavior — it was never actually partner-specific, just
 * built here first. Kept as a re-export rather than updating four files'
 * imports for a rename with no behavior change.
 */
export const partnerContactHref = contactHref;

export function PartnerHero({
  kicker,
  headline,
  subhead,
  primaryLabel,
  primaryHref,
  secondaryLabel,
  secondaryHref,
}: {
  kicker: string;
  headline: string;
  subhead: string;
  primaryLabel: string;
  primaryHref: string;
  secondaryLabel: string;
  secondaryHref: string;
}) {
  return (
    <Section className="pb-16 pt-16 md:pb-20 md:pt-24">
      <div className="max-w-2xl">
        <Eyebrow>{kicker}</Eyebrow>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
          {headline}
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-gray-600">{subhead}</p>

        <div className="mt-8 flex flex-wrap gap-3">
          <a
            href={primaryHref}
            className="rounded-md bg-gray-900 px-5 py-3 text-sm font-medium text-white hover:bg-gray-800"
          >
            {primaryLabel}
          </a>
          <a
            href={secondaryHref}
            className="rounded-md border border-gray-300 px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {secondaryLabel}
          </a>
        </div>
      </div>
    </Section>
  );
}

/** Renders a " · "-joined proof line as a checked list, matching the hero's checklist style. */
export function ProofBar({ items }: { items: string[] }) {
  return (
    <Section className="pb-4">
      <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500">
        {items.map((item) => (
          <li key={item} className="flex items-center gap-2">
            <Check /> {item}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function PartnerClosingCta({
  heading,
  body,
  ctaLabel,
  ctaHref,
}: {
  heading: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
}) {
  return (
    <Section className="py-20">
      <div className="rounded-2xl border border-gray-200 bg-white px-8 py-14 text-center shadow-sm md:px-12">
        <h2 className="text-3xl font-semibold tracking-tight text-gray-900">
          {heading}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-gray-600">{body}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <a
            href={ctaHref}
            className="rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white hover:bg-gray-800"
          >
            {ctaLabel}
          </a>
          <Link
            href="/story"
            className="rounded-md border border-gray-300 px-6 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Read Our Story
          </Link>
        </div>
      </div>
    </Section>
  );
}
