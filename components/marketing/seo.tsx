// /products/seo — the SEO + AI Search product page (plan.md, the SEO build plan).
//
// NOT JUST LOCAL (2026-09-28). The page used to read as "Local SEO, per
// location" top to bottom, which hid the website plan and AI search visibility
// (ChatGPT, Google AI Overviews) that two of the three plans include. The hero,
// pillars and a dedicated AI search band now say all three.
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
import { SEO_EXTRA_LOCATION, SEO_PLANS, seoBundleSavings, seoPlanByKey } from "@/lib/seo-pricing";

export const SEO_METADATA = {
  title: "SEO + AI Search For Your Website And Every Location | LumiLink",
  description:
    "Get found on Google, in the local map pack, and in AI answers from ChatGPT and Google AI Overviews. Weekly audits, rank tracking, AI search visibility, and fixes you approve before anything goes live.",
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
    title: "Found Wherever Customers Look",
    body: "Google's organic results, the local map pack, and the AI answers from ChatGPT and Google AI Overviews. We track all three every week, for your website and every location.",
  },
  {
    n: "02",
    title: "Nothing Goes Live Without You",
    body: "Every fix and every article is drafted for your approval first. Approve it and we publish it. Change your mind and we roll it back.",
  },
  {
    n: "03",
    title: "Your Core Details Stay Yours",
    body: "Your business name, address, phone number and primary category are never edited by automation. That's enforced in code, not left to a setting.",
  },
];

const CAPABILITIES = [
  {
    title: "Weekly Site Audit",
    body: "We crawl each location's site for missing titles, meta descriptions and headings, local business schema, image alt text, thin pages and a phone number that doesn't match.",
  },
  {
    title: "Technical Health Checks",
    body: "Core Web Vitals, indexing and canonical status from Search Console, broken redirects, robots.txt and your sitemap, checked on a schedule rather than once.",
  },
  {
    title: "Rank Tracking With A Geo Grid",
    body: "Your keywords are checked weekly in organic results and the local map pack, with a 5×5 grid around each location showing where you rank across the area.",
  },
  {
    title: "Competitors Side By Side",
    body: "Name up to five competitors and see their positions next to yours for every keyword we track, with no extra setup.",
  },
  {
    title: "AI Search Visibility",
    body: "We check weekly whether Google's AI Overviews and ChatGPT cite your site when people ask about what you do.",
  },
  {
    title: "Backlink Monitoring",
    body: "A monthly view of who links to you: referring domains, links gained and lost, and which of your pages attract them.",
  },
  {
    title: "Fixes Drafted For You",
    body: "Audit findings become ready-to-approve changes. On Shopify we publish them for you; on any other site you get the exact change and where to paste it.",
  },
  {
    title: "Local Articles",
    body: "Up to two articles a week, aimed at the keywords where you're furthest behind, each checked against your other posts and locations so nothing is duplicated.",
  },
  {
    title: "A Monthly Report",
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
    q: "Who Is This For?",
    a: "Any business that needs to be found online. Website SEO + AI Search suits a business whose customers find it through its website; Local SEO suits one with physical locations that need to show up when someone nearby searches: trades, clinics, salons, retailers, multi-location brands. Most businesses with both take the full bundle.",
  },
  {
    q: "Do I Need A LumiLink Phone Plan?",
    a: "No. SEO + AI Search is its own product with its own subscription. You can have it on its own or alongside a phone plan.",
  },
  {
    q: "What Do I Need To Connect?",
    a: "Your Google Search Console property, so we can see indexing and search data. If your site runs on Shopify, you can also connect the store so approved fixes and articles are published for you.",
  },
  {
    q: "Will You Change My Site Without Asking?",
    a: "No. Every change is drafted and waits for your approval. We store what was there before, so anything we publish can be rolled back from your dashboard.",
  },
  {
    q: "My Site Isn't On Shopify. Does It Still Work?",
    a: "Yes. The audits, tracking and reports work on any site. For fixes and articles, you get the exact change and step-by-step instructions to apply it yourself.",
  },
  {
    q: "Are The Articles Written By AI?",
    a: "They're drafted by AI and approved by you. Drafts are held to your business's real details: they won't claim licences, guarantees, years in business or numbers we can't verify.",
  },
  {
    q: "How Is Pricing Calculated?",
    a: `Website SEO + AI Search is ${usd(seoPlanByKey("website").monthlyUsd)} a month for one website. Local SEO is ${usd(seoPlanByKey("local").monthlyUsd)} a month per location. Full SEO + AI Search covers one website and one location for ${usd(seoPlanByKey("bundle").monthlyUsd)} a month, and each extra location is ${usd(SEO_EXTRA_LOCATION.monthlyUsd)}. Groups with many brands, sites or locations get a custom quote.`,
  },
  {
    q: "How Much Does The Full Bundle Save?",
    a: `${usd(seoBundleSavings().baseMonthlyUsd)} a month against buying Website SEO + AI Search and Local SEO separately, and another ${usd(seoBundleSavings().perExtraLocationUsd)} a month on every location after the first (${usd(SEO_EXTRA_LOCATION.monthlyUsd)} instead of ${usd(seoPlanByKey("local").monthlyUsd)}). A website with five locations saves ${usd(seoBundleSavings(5).totalMonthlyUsd)} a month, or ${usd(seoBundleSavings(5).totalMonthlyUsd * 12)} a year.`,
  },
  {
    q: "What Is AI Search, And Why Does It Matter?",
    a: "More people now ask ChatGPT or read Google's AI Overview before they click a single link. If those answers don't mention you, you're invisible to that customer. We check every week whether they cite your site for the questions people ask about what you do, and the fixes we draft (clear answers, structured business data) make your pages easier for them to quote.",
  },
  {
    q: "Do You Build Links?",
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

export function SeoPortalMockup({ caption }: { caption: string }) {
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
 *
 * SAVINGS TAGS (2026-09-28). The bundle card says what it saves against
 * buying the other two, and the per-location card says what an extra
 * location costs on the bundle instead. Both come from seoBundleSavings(),
 * so they move with the prices.
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
  const savings = seoBundleSavings();
  const tags: Partial<Record<(typeof SEO_PLANS)[number]["key"], string>> = {
    website: "AI Search Included",
    bundle: `Save ${usd(savings.baseMonthlyUsd)}/mo`,
  };
  const savingNotes: Partial<Record<(typeof SEO_PLANS)[number]["key"], string>> = {
    local: `Adding a website? The full bundle makes each extra location ${usd(SEO_EXTRA_LOCATION.monthlyUsd)}, ${usd(savings.perExtraLocationUsd)} less.`,
    bundle: `${usd(savings.baseMonthlyUsd)} a month less than buying both, plus ${usd(savings.perExtraLocationUsd)} off every extra location.`,
  };

  return (
    <Section id={id} className="border-t border-gray-200 py-20">
      <div className="max-w-2xl">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
          Your Website, Your Locations, Or Both
        </h2>
        <p className="mt-3 text-gray-600">
          AI search optimization is included with every website plan. Local SEO
          grows with the number of locations you have, and the full bundle is
          the cheapest way to get both.
        </p>
        {learnMoreHref ? (
          <Link
            href={learnMoreHref}
            className="mt-4 inline-block text-sm font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700"
          >
            What SEO + AI Search Includes
          </Link>
        ) : null}
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        {SEO_PLANS.map((plan) => {
          const featured = plan.key === "bundle";
          const tag = tags[plan.key];
          const note = savingNotes[plan.key];
          return (
            <div
              key={plan.key}
              className={`relative flex flex-col rounded-2xl bg-white p-8 shadow-sm ${
                featured ? "border-2 border-gray-900" : "border border-gray-200"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium text-gray-500">{plan.name}</p>
                {tag ? (
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      featured ? "bg-green-600 text-white" : "bg-lumi-100 text-lumi-700"
                    }`}
                  >
                    {tag}
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-4xl font-semibold tracking-tight text-gray-900">
                {usd(plan.monthlyUsd)}
                <span className="text-base font-normal text-gray-500">
                  {plan.perLocation ? " / location / month" : " / month"}
                </span>
              </p>
              {featured ? (
                <p className="mt-1 text-sm text-gray-400">
                  <span className="line-through">
                    {usd(plan.monthlyUsd + savings.baseMonthlyUsd)}
                  </span>{" "}
                  if bought separately
                </p>
              ) : null}
              <p className="mt-3 text-sm text-gray-600">{plan.headline}</p>
              <ul className="mt-6 flex-1 space-y-2">
                {plan.includes.map((item) => (
                  <li key={item} className="flex gap-2 text-sm text-gray-600">
                    <Check /> {item}
                  </li>
                ))}
              </ul>
              {note ? (
                <p
                  className={`mt-4 rounded-md px-3 py-2 text-xs font-medium ${
                    featured ? "bg-green-50 text-green-800" : "bg-gray-50 text-gray-600"
                  }`}
                >
                  {note}
                </p>
              ) : null}
              {plan.footnote ? <p className="mt-4 text-xs text-gray-400">{plan.footnote}</p> : null}
              <Link
                href={ctaHref}
                className={`mt-6 block rounded-md px-4 py-3 text-center text-sm font-medium ${
                  featured
                    ? "bg-gray-900 text-white hover:bg-gray-800"
                    : "border border-gray-300 text-gray-700 hover:bg-gray-50"
                }`}
              >
                Get Started
              </Link>
            </div>
          );
        })}
      </div>

      <p className="mt-8 text-sm text-gray-500">
        Many brands, sites or locations?{" "}
        <Link
          href="/pricing#enterprise"
          className="font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700"
        >
          See Enterprise
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

// What the AI search band claims. Held to the same rule as the rest of the
// page: only what's built (AI Overviews and ChatGPT via DataForSEO's LLM
// Mentions, schema and content fixes through the approval queue).
const AI_SEARCH_POINTS = [
  {
    title: "See Whether AI Mentions You",
    body: "Every week we ask the questions your customers ask and check whether Google's AI Overviews and ChatGPT cite your site in the answer.",
  },
  {
    title: "Pages AI Can Quote",
    body: "Audit fixes include clear answers, local business schema and clean headings: the structure AI answers pull from.",
  },
  {
    title: "Included, Not Upsold",
    body: "AI search visibility comes with every website plan at no extra charge. It's where search is going, so it isn't an add-on.",
  },
];

export async function SeoSolution() {
  const primaryHref = await seoCtaHref();

  return (
    <MarketingShell>
      <Section className="pb-20 pt-16 md:pb-28 md:pt-24">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <Eyebrow>SEO + AI Search</Eyebrow>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
              Get Found On Google And In AI Search.
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-gray-600">
              Your website, every location, and the answers ChatGPT and
              Google&rsquo;s AI Overviews give. We audit each week, track where
              you rank, and draft the fixes. You approve them, we publish them.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href={primaryHref}
                className="rounded-md bg-gray-900 px-5 py-3 text-sm font-medium text-white hover:bg-gray-800"
              >
                Get Started
              </Link>
              <a
                href="#pricing"
                className="rounded-md border border-gray-300 px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                See Pricing
              </a>
            </div>

            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500">
              <li className="flex items-center gap-2">
                <Check /> Website SEO
              </li>
              <li className="flex items-center gap-2">
                <Check /> Local Map Pack
              </li>
              <li className="flex items-center gap-2">
                <Check /> AI Search Visibility
              </li>
              <li className="flex items-center gap-2">
                <Check /> You Approve Every Change
              </li>
            </ul>
          </div>

          <SeoPortalMockup caption="Client portal — SEO + AI Search" />
        </div>
      </Section>

      <Section className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>How It Works</Eyebrow>
        <Pillars items={PILLARS} />
      </Section>

      {/* AI search gets its own band: it's the part of the product people
          don't expect from an SEO service, and it was one bullet before. */}
      <Section className="py-20">
        <div className="rounded-2xl bg-gray-900 px-8 py-12 text-white md:px-12">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            AI Search
          </p>
          <h2 className="mt-4 max-w-2xl text-2xl font-semibold tracking-tight md:text-3xl">
            Your Customers Ask AI First. Make Sure It Names You.
          </h2>
          <p className="mt-4 max-w-2xl leading-relaxed text-gray-300">
            More searches now end in an AI answer instead of a list of links.
            Ranking on Google still matters, and so does being the business
            ChatGPT and Google&rsquo;s AI Overviews recommend.
          </p>
          <div className="mt-10 grid gap-8 md:grid-cols-3">
            {AI_SEARCH_POINTS.map((p) => (
              <div key={p.title}>
                <h3 className="text-base font-semibold">{p.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-gray-300">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section className="border-t border-gray-200 py-20">
        <div className="max-w-2xl">
          <Eyebrow>What&rsquo;s Included</Eyebrow>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
            Audit, Track, Fix, Report
          </h2>
          <p className="mt-3 text-gray-600">
            Everything runs on a schedule for your website and every location,
            and it all lands in one portal.
          </p>
        </div>
        <CapabilityGrid items={CAPABILITIES} />

        <div className="mt-14 rounded-xl border border-dashed border-gray-300 p-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Coming Soon
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

      <FaqList items={FAQS} heading="What People Ask About SEO + AI Search" />

      <ClosingCta
        heading="Start Ranking Where Your Customers Look"
        body="Add your website and locations, connect Search Console, and your first audit, rankings and AI search check are on the way."
        cta="Get Started"
        href={primaryHref}
      />
    </MarketingShell>
  );
}
