// /products/seo — the Local SEO product page (plan.md, the SEO build plan).
//
// A different product from the phone agent: no calls involved, its own
// subscription, its own plans (lib/seo-pricing.ts's SEO_PLANS: website,
// local per location, or both) rather than the Starter/Growth/Scale ladder.
// So this page does NOT use PricingGrid; it renders its own plan cards from
// SEO_PLANS, so the numbers here can't disagree with what /billing charges.
//
// COPY ONLY CLAIMS WHAT IS BUILT (plan.md §3, 2026-09-22). Google Business
// Profile sync, profile edits and review replies (Phase 4) wait on Google's
// API approval, so they're listed under "Coming soon", not as features.
// Citations and link building (Phase 5) are parked and aren't mentioned as
// features at all. Only Shopify has a publish adapter; every other site gets
// the change as step-by-step instructions (seo-publish's manual_required
// fallback). AI visibility covers Google AI Overviews and ChatGPT only (the
// two platforms DataForSEO's LLM Mentions accepts). Update this file when any
// of those change.

import Link from "next/link";
import { MarketingShell, isSignedIn } from "@/components/marketing/shell";
import {
  CapabilityGrid,
  Check,
  ClosingCta,
  Eyebrow,
  FaqList,
  Pillars,
  Section,
} from "@/components/marketing/blocks";
import { MockupFrame } from "@/components/marketing/dashboard-mockups";
import { SEO_EXTRA_LOCATION, SEO_PLANS, seoPlanByKey } from "@/lib/seo-pricing";

export const SEO_METADATA = {
  title: "Local SEO for every location | LumiLink",
  description:
    "Weekly site audits, rank tracking with a map-pack geo grid, competitor and AI search visibility, and fixes you approve before anything goes live. Website SEO, Local SEO per location, or both.",
};

// Signed out: create an account for Local SEO (?product=seo).
// Signed in: /onboarding/add, which adds Local SEO to the existing workspace
// and starts its setup steps; checkout follows once locations exist. Same
// destination as the dashboard sidebar's "Add Local SEO" row.
const SIGNUP_SEO = "/signup?product=seo";
const ADD_SEO = "/onboarding/add?product=seo";

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

const PILLARS = [
  {
    n: "01",
    title: "Found where customers look",
    body: "We track where each location shows up in Google's map pack and organic results, block by block across its service area, every week.",
  },
  {
    n: "02",
    title: "Nothing goes live without you",
    body: "Every fix and every article is drafted for your approval first. Approve it and we publish it. Change your mind and we roll it back.",
  },
  {
    n: "03",
    title: "Your core details stay yours",
    body: "Your business name, address, phone number and primary category are never edited by automation. That's enforced in code, not left to a setting.",
  },
];

const CAPABILITIES = [
  {
    title: "Weekly site audit",
    body: "We crawl each location's site for missing titles, meta descriptions and headings, local business schema, image alt text, thin pages and a phone number that doesn't match.",
  },
  {
    title: "Technical health checks",
    body: "Core Web Vitals, indexing and canonical status from Search Console, broken redirects, robots.txt and your sitemap, checked on a schedule rather than once.",
  },
  {
    title: "Rank tracking with a geo grid",
    body: "Your keywords are checked weekly in organic results and the local map pack, with a 5×5 grid around each location showing where you rank across the area.",
  },
  {
    title: "Competitors side by side",
    body: "Name up to five competitors and see their positions next to yours for every keyword we track, with no extra setup.",
  },
  {
    title: "AI search visibility",
    body: "We check weekly whether Google's AI Overviews and ChatGPT cite your site when people ask about what you do.",
  },
  {
    title: "Backlink monitoring",
    body: "A monthly view of who links to you: referring domains, links gained and lost, and which of your pages attract them.",
  },
  {
    title: "Fixes drafted for you",
    body: "Audit findings become ready-to-approve changes. On Shopify we publish them for you; on any other site you get the exact change and where to paste it.",
  },
  {
    title: "Local articles",
    body: "Up to two articles a week, aimed at the keywords where you're furthest behind, each checked against your other posts and locations so nothing is duplicated.",
  },
  {
    title: "A monthly report",
    body: "On the 1st of each month: rankings, work shipped, what's queued next, and a plain statement of the radius each location can realistically win.",
  },
];

const COMING_SOON = [
  "Google Business Profile sync: daily profile metrics, reviews and a completeness audit",
  "Profile updates drafted for your approval, with the same rollback as site changes",
  "Review replies in your voice, with anything under three stars sent to a person first",
];

const FAQS = [
  {
    q: "Who is this for?",
    a: "Businesses with one or more physical locations that need to show up when someone nearby searches for what they do: trades, clinics, salons, retailers, multi-location brands.",
  },
  {
    q: "Do I need a LumiLink phone plan?",
    a: "No. Local SEO is its own product with its own subscription. You can have it on its own or alongside a phone plan.",
  },
  {
    q: "What do I need to connect?",
    a: "Your Google Search Console property, so we can see indexing and search data. If your site runs on Shopify, you can also connect the store so approved fixes and articles are published for you.",
  },
  {
    q: "Will you change my site without asking?",
    a: "No. Every change is drafted and waits for your approval. We store what was there before, so anything we publish can be rolled back from your dashboard.",
  },
  {
    q: "My site isn't on Shopify. Does it still work?",
    a: "Yes. The audits, tracking and reports work on any site. For fixes and articles, you get the exact change and step-by-step instructions to apply it yourself.",
  },
  {
    q: "Are the articles written by AI?",
    a: "They're drafted by AI and approved by you. Drafts are held to your business's real details: they won't claim licences, guarantees, years in business or numbers we can't verify.",
  },
  {
    q: "How is pricing calculated?",
    a: `Website SEO + AI Search is ${usd(seoPlanByKey("website").monthlyUsd)} a month for one website. Local SEO is ${usd(seoPlanByKey("local").monthlyUsd)} a month per location. Full SEO + AI Search covers one website and one location for ${usd(seoPlanByKey("bundle").monthlyUsd)} a month, and each extra location is ${usd(SEO_EXTRA_LOCATION.monthlyUsd)}. Groups with many brands, sites or locations get a custom quote.`,
  },
  {
    q: "Do you build links?",
    a: "No. We monitor your backlink profile every month, but we don't buy or place links on other sites.",
  },
];

/**
 * CSS MOCKUP, NOT A SCREENSHOT — same rule as dashboard-mockups.tsx: every
 * name and number here is invented. Shape follows the real /seo portal: a
 * geo grid of local-pack positions and a keyword table against a competitor.
 */
const GRID: (number | null)[] = [
  7, 5, 4, 6, 9,
  4, 2, 2, 3, 6,
  3, 1, 1, 2, 5,
  5, 2, 1, 3, 8,
  9, 6, 4, 7, null,
];

function gridCellClass(pos: number | null): string {
  if (pos === null) return "bg-gray-100 text-gray-400";
  if (pos <= 3) return "bg-green-500 text-white";
  if (pos <= 6) return "bg-amber-400 text-white";
  return "bg-red-400 text-white";
}

const KEYWORDS = [
  { kw: "emergency plumber", you: 2, them: 4 },
  { kw: "water heater repair", you: 5, them: 3 },
  { kw: "drain cleaning near me", you: 1, them: 7 },
];

function SeoPortalMockup({ caption }: { caption: string }) {
  return (
    <MockupFrame caption={caption}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-900">Riverside Plumbing — Eastside</p>
        <span className="rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-medium text-green-700">
          Site connected
        </span>
      </div>

      <div className="mt-4 grid gap-5 sm:grid-cols-[auto_1fr]">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-gray-400">
            Map pack · &ldquo;emergency plumber&rdquo;
          </p>
          <div className="mt-2 grid w-max grid-cols-5 gap-1">
            {GRID.map((pos, i) => (
              <span
                key={i}
                className={`flex h-7 w-7 items-center justify-center rounded text-[11px] font-semibold ${gridCellClass(pos)}`}
              >
                {pos ?? "–"}
              </span>
            ))}
          </div>
        </div>

        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-wide text-gray-400">
            Organic position vs. top competitor
          </p>
          <table className="mt-2 w-full text-left text-xs">
            <thead>
              <tr className="text-gray-400">
                <th className="py-1 font-medium">Keyword</th>
                <th className="py-1 text-right font-medium">You</th>
                <th className="py-1 text-right font-medium">Them</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {KEYWORDS.map((k) => (
                <tr key={k.kw}>
                  <td className="truncate py-1.5 text-gray-700">{k.kw}</td>
                  <td
                    className={`py-1.5 text-right font-semibold ${k.you <= k.them ? "text-green-600" : "text-gray-900"}`}
                  >
                    {k.you}
                  </td>
                  <td className="py-1.5 text-right text-gray-500">{k.them}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-5 rounded-lg border border-gray-200 p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium text-gray-900">
            Add a meta description to /services/water-heaters
          </p>
          <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
            Awaiting approval
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
          &ldquo;Same-day water heater repair and replacement on the Eastside.
          Tank and tankless, all major brands.&rdquo;
        </p>
      </div>
    </MockupFrame>
  );
}

/**
 * The SEO plan cards with their pitch. Shared by this page and /pricing so
 * the two can't quote the SEO product differently.
 */
export function SeoPricingSection({
  id,
  ctaHref,
  eyebrow = "Pricing",
  learnMoreHref,
}: {
  id?: string;
  ctaHref: string;
  eyebrow?: string;
  /** Set on /pricing, where the visitor hasn't seen the product page yet. */
  learnMoreHref?: string;
}) {
  return (
    <Section id={id} className="border-t border-gray-200 py-20">
      <div className="max-w-2xl">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
          Your website, your locations, or both
        </h2>
        <p className="mt-3 text-gray-600">
          AI search optimization is included with every website plan. Local SEO
          grows with the number of locations you have.
        </p>
        {learnMoreHref ? (
          <Link
            href={learnMoreHref}
            className="mt-4 inline-block text-sm font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700"
          >
            What SEO includes
          </Link>
        ) : null}
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        {SEO_PLANS.map((plan) => {
          const featured = plan.key === "bundle";
          return (
            <div
              key={plan.key}
              className={`flex flex-col rounded-2xl border bg-white p-8 shadow-sm ${
                featured ? "border-gray-900" : "border-gray-200"
              }`}
            >
              <p className="text-sm font-medium text-gray-500">{plan.name}</p>
              <p className="mt-2 text-4xl font-semibold tracking-tight text-gray-900">
                {usd(plan.monthlyUsd)}
                <span className="text-base font-normal text-gray-500">
                  {plan.perLocation ? " / location / month" : " / month"}
                </span>
              </p>
              <p className="mt-3 text-sm text-gray-600">{plan.headline}</p>
              <ul className="mt-6 flex-1 space-y-2">
                {plan.includes.map((item) => (
                  <li key={item} className="flex gap-2 text-sm text-gray-600">
                    <Check /> {item}
                  </li>
                ))}
              </ul>
              {plan.footnote ? <p className="mt-4 text-xs text-gray-400">{plan.footnote}</p> : null}
              <Link
                href={ctaHref}
                className={`mt-6 block rounded-md px-4 py-3 text-center text-sm font-medium ${
                  featured
                    ? "bg-gray-900 text-white hover:bg-gray-800"
                    : "border border-gray-300 text-gray-700 hover:bg-gray-50"
                }`}
              >
                Get started
              </Link>
            </div>
          );
        })}
      </div>

      <p className="mt-8 text-sm text-gray-500">
        Many brands, sites or locations?{" "}
        <Link
          href="/contact"
          className="font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700"
        >
          Talk to us about Enterprise
        </Link>
        . Prices exclude setup, custom development, paid media, third-party
        fees and taxes.
      </p>
    </Section>
  );
}

/** Signup for SEO when signed out; add SEO to the workspace when signed in. */
export async function seoCtaHref(): Promise<string> {
  return (await isSignedIn()) ? ADD_SEO : SIGNUP_SEO;
}

export async function SeoSolution() {
  const primaryHref = await seoCtaHref();

  return (
    <MarketingShell>
      <Section className="pb-20 pt-16 md:pb-28 md:pt-24">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <Eyebrow>Local SEO, per location</Eyebrow>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
              Show up when customers nearby search.
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-gray-600">
              We audit every location&rsquo;s site each week, track where you
              rank across your service area, and draft the fixes. You approve
              them, we publish them.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href={primaryHref}
                className="rounded-md bg-gray-900 px-5 py-3 text-sm font-medium text-white hover:bg-gray-800"
              >
                Get started
              </Link>
              <a
                href="#pricing"
                className="rounded-md border border-gray-300 px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                See pricing
              </a>
            </div>

            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500">
              <li className="flex items-center gap-2">
                <Check /> Weekly audits
              </li>
              <li className="flex items-center gap-2">
                <Check /> Map-pack geo grid
              </li>
              <li className="flex items-center gap-2">
                <Check /> You approve every change
              </li>
            </ul>
          </div>

          <SeoPortalMockup caption="Client portal — Local SEO" />
        </div>
      </Section>

      <Section className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>How it works</Eyebrow>
        <Pillars items={PILLARS} />
      </Section>

      <Section className="py-20">
        <div className="max-w-2xl">
          <Eyebrow>What&rsquo;s included</Eyebrow>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
            Audit, track, fix, report
          </h2>
          <p className="mt-3 text-gray-600">
            Everything runs on a schedule for every location, and it all lands
            in one portal.
          </p>
        </div>
        <CapabilityGrid items={CAPABILITIES} />

        <div className="mt-14 rounded-xl border border-dashed border-gray-300 p-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Coming soon
          </p>
          <ul className="mt-3 space-y-2">
            {COMING_SOON.map((item) => (
              <li key={item} className="text-sm leading-relaxed text-gray-600">
                {item}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <SeoPricingSection id="pricing" ctaHref={primaryHref} />

      <FaqList items={FAQS} heading="What people ask about local SEO" />

      <ClosingCta
        heading="Start ranking where your customers are"
        body="Add your locations, connect Search Console, and your first audit and rankings are on the way."
        cta="Get Started"
        href={primaryHref}
      />
    </MarketingShell>
  );
}
