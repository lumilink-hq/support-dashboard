// "/pricing" — everything LumiLink sells and what it costs, on one page.
//
// WAS /addons until 2026-09-23 (next.config.ts redirects it). That page
// already showed the core plans and the add-ons together, per the 2026-08-31
// boss feedback: "give them a beautiful view of all available so automating
// the whole thing is just a matter of clicking on what they want," not a hop
// to a second page for half the picture. Local SEO was the missing half once
// it became a product, so it joined here and the page was renamed to match
// the nav's "Pricing".
//
// NOTHING HERE RE-DESCRIBES A PRICE. The plans are PricingGrid (the same
// component /plans and the homepage use), the add-ons are availableAddons()
// from lib/addons.ts (which also backs /billing and /welcome), and Local SEO is
// SeoPricingSection (shared with /products/seo). Each reads its own source of
// truth, so this page can't drift from any of them.
//
// PURELY INFORMATIONAL for add-ons. An add-on is a line item on an EXISTING
// phone subscription (lib/services/billing.ts), so a signed-out visitor can't
// buy one; the cards point at /plans, where the subscription starts. Buying
// an add-on happens inside /billing or /welcome, which know who is asking.
//
// THE PLAN FINDER (2026-09-28). A short quiz at the top recommends products
// and a monthly estimate (components/marketing/plan-finder.tsx). Its prices
// come from finder-prices.ts, which reads the same sources as the sections
// below (the homepage embeds the same quiz), and the
// sections carry ids (#phone, #addons, #seo, #enterprise) for its links and
// the jump bar.
//
// /plans IS STILL THE PHONE-PLAN CHECKOUT PAGE. Signup (?next=/plans) and
// PricingGrid's cards route through it, so it isn't merged into this page.

import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/shell";
import {
  contactHref,
  EnterpriseBand,
  Eyebrow,
  PricingGrid,
  Section,
  SIGNUP_CTA,
} from "@/components/marketing/blocks";
import { SeoPricingSection, seoCtaHref } from "@/components/marketing/seo";
import { PlanFinder } from "@/components/marketing/plan-finder";
import { finderPrices } from "@/components/marketing/finder-prices";
import { availableAddons } from "@/lib/addons";
import { productByKey } from "@/lib/catalog";

const JUMPS = [
  { href: "#phone", label: "Phone Agent" },
  { href: "#addons", label: "Add-Ons" },
  { href: "#seo", label: "SEO + AI Search" },
  { href: "#enterprise", label: "Enterprise" },
];

export const metadata: Metadata = {
  title: "Pricing | LumiLink",
  description:
    "Every plan, add-on and product in one place: the AI phone agent, website chat, extra lines and locations, and SEO + AI search for your website and every location.",
  alternates: { canonical: "/pricing" },
};

export default async function PricingPage() {
  const addons = availableAddons();
  const seoHref = await seoCtaHref();

  return (
    <MarketingShell>
      <Section className="pb-8 pt-20">
        <div className="max-w-2xl">
          <Eyebrow>Pricing</Eyebrow>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900">
            Build What Your Business Needs
          </h1>
          <p className="mt-3 text-lg text-gray-600">
            Phone calls, website chat, workflows, and getting found on Google
            and in AI search. Answer four questions and we&rsquo;ll tell you
            what fits, or scroll down: everything we sell is on this page.
          </p>
        </div>

        <nav aria-label="Pricing sections" className="mt-8 flex flex-wrap gap-2">
          {JUMPS.map((j) => (
            <a
              key={j.href}
              href={j.href}
              className="rounded-full border border-gray-300 bg-white px-3.5 py-1.5 text-sm font-medium text-gray-700 hover:border-gray-900 hover:text-gray-900"
            >
              {j.label}
            </a>
          ))}
        </nav>
      </Section>

      <Section id="finder" className="pb-12">
        <h2 className="text-lg font-semibold text-gray-900">
          Not Sure Where To Start? Let Us Figure Out What Your Business Needs.
        </h2>
        <div className="mt-5">
          <PlanFinder
            prices={finderPrices()}
            signupHref={SIGNUP_CTA}
            seoSignupHref={seoHref}
            enterpriseHref={contactHref("/pricing", "Enterprise / White Label")}
          />
        </div>
      </Section>

      <div id="phone" className="scroll-mt-16 border-t border-gray-200">
        <PricingGrid
          heading="Phone Agent: Start With A Core Plan"
          blurb="Every plan includes 24/7 answering, booking, and a website knowledge sync. No setup fee on any of them."
          contactSource="/pricing"
          showEnterprise={false}
        />
      </div>

      <Section id="addons" className="border-t border-gray-200 bg-gray-50 py-20">
        <div className="max-w-2xl">
          <Eyebrow>Add-Ons</Eyebrow>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
            Then Add What You Need
          </h2>
          <p className="mt-3 text-gray-600">
            Optional extras that ride your existing phone plan, billed on the
            same subscription.
          </p>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {addons.map((a) => (
            <div
              key={a.key}
              className="flex flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-base font-semibold text-gray-900">
                  {a.name}
                </h3>
                <p className="shrink-0 text-sm font-medium text-gray-900">
                  ${a.monthlyUsd}
                  <span className="text-gray-500">/mo</span>
                </p>
              </div>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-gray-600">
                {a.blurb}
              </p>
              <Link
                href="/plans"
                className="mt-4 block rounded-md border border-gray-300 px-3 py-2 text-center text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Start With A Plan
              </Link>
            </div>
          ))}
        </div>
      </Section>

      <SeoPricingSection
        id="seo"
        eyebrow="SEO + AI Search"
        ctaHref={seoHref}
        learnMoreHref={productByKey("seo").marketingHref}
      />

      <EnterpriseBand contactSource="/pricing" />

      <Section className="border-t border-gray-200 py-12">
        <p className="text-sm text-gray-500">
          Don&rsquo;t see what you need?{" "}
          <Link
            href="/contact"
            className="font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700"
          >
            Contact Us
          </Link>
          .
        </p>
      </Section>
    </MarketingShell>
  );
}
