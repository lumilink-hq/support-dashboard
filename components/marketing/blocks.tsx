// Shared marketing building blocks.
//
// WHY THIS FILE EXISTS. There are now three public pages — the landing page and
// one per vertical (/solutions/ecommerce, /solutions/service) — and all three
// quote prices, list plans and answer the same money questions. Three copies of
// a pricing table is three chances to advertise a number the billing page
// disagrees with, which is the single cheapest way to lose money on a website.
//
// So: layout primitives and every block that touches a PRICE live here once.
// Vertical-specific copy lives in the page components. Nothing in this file
// hardcodes a number — PLAN_TIERS, STARTER_PLAN and OVERAGE all come from
// lib/entitlements.ts, which mirrors the CFO workbook.

import Link from "next/link";
import {
  advertisedCalls,
  guaranteedCalls,
  ENTERPRISE_TIER,
  OVERAGE,
  PLAN_TIERS,
  STARTER_PLAN,
} from "@/lib/entitlements";
import { isSignedIn } from "@/components/marketing/shell";
import { safeNextPath } from "@/lib/route-access";
import { ADDONS } from "@/lib/addons";
import {
  SEO_EXTRA_LOCATION,
  SEO_PLANS,
  seoPlanByKey,
  type SeoPlan,
  type SeoPlanKey,
} from "@/lib/seo-pricing";
import { WidgetPreviewMockup } from "@/components/marketing/storefront-mockups";

/**
 * Where an Enterprise/partner CTA sends someone: the real /contact form, with
 * the topic pre-filled and the source page tracked, not a mailto link they'd
 * have to draft themselves.
 *
 * REPLACED enterpriseContactHref() (mailto) here and in /plans on 2026-08-31
 * — boss feedback: a mailto CTA is the opposite of "easy to engage with us."
 * Kept as `contactHref` (not `enterpriseContactHref`) since /contact is the
 * real destination for any "talk to us" CTA now, not just Enterprise.
 */
export function contactHref(sourcePath: string, topic: string): string {
  const params = new URLSearchParams({
    source: safeNextPath(sourcePath, "/contact"),
    topic,
  });
  return `/contact?${params.toString()}`;
}

/**
 * Where every primary CTA points: straight at account creation.
 *
 * The old comment here said "swap to a Cal.com/Calendly URL once booking is set
 * up". That is not the plan — we don't run discovery calls, and the buttons
 * that said "Book a discovery call" were pointing here the whole time, so the
 * label was describing a step that never existed. Renamed from DEMO_CTA to
 * SIGNUP_CTA so nothing re-adopts the booking idea from the name alone.
 */
export const SIGNUP_CTA = "/signup";

/**
 * Where a plan card should send THIS visitor.
 *
 * Signed out, the answer is signup — that's the change requested on 2026-08-13,
 * and it removes a hop for the only people who see these cards and can't check
 * out yet. `next=/plans` brings them back to the tier they were looking at.
 *
 * Signed IN, it stays /plans. A pricing card cannot become a checkout button:
 * the Stripe link has to carry client_reference_id, and only /plans reads the
 * session to supply it. Sending an existing customer to a signup form instead
 * of checkout would be a worse hop than the one we just removed.
 */
export async function planCtaHref(): Promise<string> {
  return (await isSignedIn()) ? "/plans" : "/signup?next=%2Fplans";
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function Section({
  id,
  className = "",
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`scroll-mt-16 ${className}`}>
      <div className="mx-auto max-w-6xl px-6">{children}</div>
    </section>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-lumi-700">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-lumi-500" />
      {children}
    </p>
  );
}

/**
 * One or two key words in a headline, in the brand accent ("Get found on
 * <Accent>Google</Accent>"). Display sizes only: lumi-600 on white clears the
 * 3:1 large-text contrast bar, not the 4.5:1 one body text needs.
 */
export function Accent({ children }: { children: React.ReactNode }) {
  return <span className="text-lumi-600">{children}</span>;
}

export function Check() {
  return (
    <span aria-hidden className="mt-0.5 shrink-0 text-green-600">
      ✓
    </span>
  );
}

/** Numbered pillars: three across, or two-then-four across when there are four. */
export function Pillars({
  items,
}: {
  items: { n: string; title: string; body: string }[];
}) {
  const cols = items.length === 4 ? "md:grid-cols-2 lg:grid-cols-4" : "md:grid-cols-3";
  return (
    <div className={`mt-10 grid gap-10 ${cols}`}>
      {items.map((p) => (
        <div key={p.n} className="reveal">
          <p className="text-sm font-semibold text-lumi-600">{p.n}</p>
          <h3 className="mt-2 text-lg font-semibold text-gray-900">{p.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-600">{p.body}</p>
        </div>
      ))}
    </div>
  );
}

/** Tick-listed capability grid. */
export function CapabilityGrid({
  items,
}: {
  items: { title: string; body: string }[];
}) {
  return (
    <div className="mt-12 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((c) => (
        <div key={c.title} className="reveal flex gap-3">
          <Check />
          <div>
            <h3 className="text-sm font-semibold text-gray-900">{c.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-gray-600">{c.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ProofShot / ProofGallery (real <Image> screenshot frames) lived here until
// 2026-08-31, when the last real screenshots on the marketing site — the
// dashboard views and the named-client storefronts — were replaced with CSS
// mockups (components/marketing/dashboard-mockups.tsx,
// components/marketing/storefront-mockups.tsx). Removed once nothing called
// them rather than left as dead code; the glow-frame chrome they used lives
// on as MockupFrame in dashboard-mockups.tsx.

// ---------------------------------------------------------------------------
// Blocks that quote money — the reason this file exists
// ---------------------------------------------------------------------------

/**
 * The plan ladder.
 *
 * STILL DISPLAY ONLY. No card here is ever a checkout link: the Stripe URL has
 * to carry `client_reference_id`, and only /plans reads the session to supply
 * it. A checkout button on a page that doesn't know who is clicking it is how a
 * payment ends up unroutable — see STRIPE-GO-LIVE.md §1.
 *
 * What changed 2026-08-13: the button no longer hardcodes /plans. It asks
 * planCtaHref, which sends a signed-out visitor to signup first. That makes
 * this an async server component — fine everywhere it's used (all three
 * marketing pages are server components), but it does mean this block can't be
 * dropped into a "use client" tree without being refactored back to a prop.
 */
export async function PricingGrid({
  heading = "What You Pay, And Where The Limits Are",
  blurb = "Every plan comes with a set number of calls and no setup fee. When you outgrow one, you move up a plan — we never bill you for going over.",
  // Which page rendered this grid, so an Enterprise lead through /contact
  // knows where it came from. Defaults to /plans, the phone-plan checkout
  // page; /pricing passes its own path for accurate attribution.
  contactSource = "/plans",
  // /pricing renders the full EnterpriseBand below the products instead, so
  // it hides this row rather than saying the same thing twice.
  showEnterprise = true,
}: {
  heading?: string;
  blurb?: string;
  contactSource?: string;
  showEnterprise?: boolean;
}) {
  const ctaHref = await planCtaHref();

  return (
    <Section id="pricing" className="py-20">
      <div className="max-w-2xl">
        <Eyebrow>Pricing</Eyebrow>
        <h2 className="reveal mt-4 display-section text-gray-900">
          {heading}
        </h2>
        <p className="mt-3 text-gray-600">{blurb}</p>
      </div>

      <div className="mt-12 grid gap-6 lg:grid-cols-3">
        {PLAN_TIERS.map((tier) => (
          <div
            key={tier.label}
            className={`flex flex-col rounded-xl bg-white p-6 shadow-sm ${
              tier.mostPopular
                ? "border-2 border-gray-900"
                : "border border-gray-200"
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-gray-900">
                {tier.label}
              </h3>
              {tier.mostPopular ? (
                <span className="shrink-0 rounded-full bg-gray-900 px-2.5 py-0.5 text-xs font-medium text-white">
                  Most Popular
                </span>
              ) : null}
            </div>

            <p className="mt-4">
              <span className="text-4xl font-semibold tracking-tight text-gray-900">
                ${tier.monthlyUsd}
              </span>
              <span className="text-sm text-gray-500">/month</span>
            </p>
            <p className="mt-1 text-sm font-medium text-green-700">
              {tier.setupFeeUsd > 0
                ? `+ $${tier.setupFeeUsd} one-time setup`
                : "Setup Is On Us — $0"}
            </p>

            <ul className="mt-6 space-y-2">
              {tier.highlights.map((h) => (
                <li key={h} className="flex gap-2 text-sm text-gray-700">
                  <Check />
                  {h}
                </li>
              ))}
            </ul>

            <div className="mt-6 flex-1" />

            <Link
              href={ctaHref}
              className={`block rounded-md px-4 py-2.5 text-center text-sm font-medium ${
                tier.mostPopular
                  ? "bg-gray-900 text-white hover:bg-gray-800"
                  : "border border-gray-300 text-gray-700 hover:bg-gray-50"
              }`}
            >
              Get Started
            </Link>
          </div>
        ))}
      </div>

      {/*
        Enterprise / white label — NOT a PLAN_TIERS card. There's no price
        and no self-serve checkout, just the /contact form, so it gets its
        own full-width row rather than a fourth card in the 3-column grid.
      */}
      {showEnterprise ? (
      <div className="mt-6 flex flex-col items-start justify-between gap-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">
            {ENTERPRISE_TIER.label} / White Label
          </h3>
          <p className="mt-1 text-sm text-gray-600">{ENTERPRISE_TIER.blurb}</p>
          <p className="mt-1 text-xs text-gray-500">
            {ENTERPRISE_TIER.highlights.join(" · ")}
          </p>
        </div>
        <a
          href={contactHref(contactSource, "Enterprise / White Label")}
          className="shrink-0 rounded-md border border-gray-300 px-4 py-2.5 text-center text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Contact Us
        </a>
      </div>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* What's not included — HIDDEN. Moved here from landing.tsx when the  */}
      {/* pricing block was shared, so it stays attached to the prices.       */}
      {/*                                                                    */}
      {/* Worth knowing what this removes: no marketing page states the       */}
      {/* $0.30/min rate at all (the FAQ's OVERAGE_ANSWER describes the hard  */}
      {/* cap instead). /billing still carries the rate, and that is the page  */}
      {/* a customer sees before                                              */}
      {/* checkout, so the pre-purchase disclosure survives. If a Stripe      */}
      {/* Payment Link is ever linked straight from a marketing page,         */}
      {/* bypassing /billing, put this block back FIRST.                      */}
      {/* ------------------------------------------------------------------ */}
      {/*
      <div className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-5">
        <h3 className="text-sm font-semibold text-gray-900">
          What&rsquo;s not included
        </h3>
        <ul className="mt-2 grid gap-1.5 text-sm text-gray-600 sm:grid-cols-2">
          <li>
            Minutes above your allowance: ${OVERAGE.perVoiceMinuteUsd.toFixed(2)} per minute
          </li>
          <li>
            Platform care beyond your included hours: ${OVERAGE.perCareHourUsd} per hour
          </li>
          <li>Additional AI phone line: $19 per month</li>
          <li>Additional location: $29 per month</li>
          <li>Advanced workflow: $49 per month</li>
          <li>Managed integration: $29 per month</li>
        </ul>
        <p className="mt-3 text-xs text-gray-500">
          Minutes used are visible in your dashboard at all times. Setup fees
          are charged once. Enterprise pricing is quoted per organisation.
        </p>
      </div>
      */}
    </Section>
  );
}

/**
 * Enterprise, as a section of its own (2026-09-28). It used to be one row
 * under the phone plans, which a multi-location or multi-brand buyer, the
 * people it's for, scrolled past. id="enterprise" is what the nav's
 * "Enterprise" link lands on at /pricing.
 *
 * No price and no checkout: Enterprise is quoted (a Stripe Quote for SEO,
 * custom limits for phone), so the only CTA is the /contact form.
 */
export function EnterpriseBand({
  contactSource,
  id = "enterprise",
}: {
  contactSource: string;
  id?: string;
}) {
  const points = [
    {
      title: "Every Location, One Account",
      body: "Phone agents, website chat and SEO across all your locations and brands, managed and reported in one place.",
    },
    {
      title: "White Label",
      body: "Resell LumiLink under your own brand to your clients or franchisees.",
    },
    {
      title: "Custom Limits And Workflows",
      body: "Minute allowances, phone numbers, integrations and automations sized to how you actually operate.",
    },
    {
      title: "A Dedicated Team",
      body: "Hands-on onboarding, a direct line to the people who build it, and priority support.",
    },
  ];
  return (
    <Section id={id} className="py-20">
      <div className="rounded-2xl bg-gray-900 px-8 py-12 text-white md:px-12">
        <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-widest text-lumi-400">
              {ENTERPRISE_TIER.label}
            </p>
            <h2 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">
              Multi-Location, Multi-Brand, Or Reselling? Let&rsquo;s Build It Together.
            </h2>
            <p className="mt-4 leading-relaxed text-gray-300">
              For groups, franchises and agencies that need more than the
              self-serve plans. Priced per organisation, around what you
              actually need.
            </p>
          </div>
          <a
            href={contactHref(contactSource, "Enterprise / White Label")}
            className="shrink-0 rounded-md bg-white px-5 py-3 text-center text-sm font-medium text-gray-900 hover:bg-gray-100"
          >
            Talk To Us About Enterprise
          </a>
        </div>
        <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {points.map((p) => (
            <div key={p.title} className="border-t border-white/15 pt-5">
              <h3 className="text-sm font-semibold">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-300">{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

/**
 * The call-length policy, stated up front rather than buried in terms.
 *
 * Kept on every vertical page deliberately: it is the limit customers actually
 * hit, and publishing it is cheaper than having it discovered.
 */
export function CallLengthPolicy({ closing }: { closing: string }) {
  return (
    <Section className="pb-20">
      <div className="rounded-2xl bg-gray-900 px-8 py-12 text-white md:px-12">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Automate The Repetitive. Escalate What Matters.
          </p>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">
            Fast Answers. Real People When It Counts.
          </h2>
          <p className="mt-4 leading-relaxed text-gray-300">
            {`Most calls are the same handful of questions, and Lumi settles them in under ${STARTER_PLAN.maxCallMinutes} minutes`}{" "}
            — which is exactly how long your customer wants to spend on the
            phone. Anything that needs judgement goes to a person instead of
            going in circles.
          </p>
          <p className="mt-3 leading-relaxed text-gray-300">{closing}</p>
        </div>
      </div>
    </Section>
  );
}

/**
 * FAQ list. Always rendered with id="faq" so the shell's "#faq" nav anchor
 * resolves on every page that uses it — an anchor that scrolls nowhere reads as
 * a broken site, and there are three pages in that nav now.
 */
export function FaqList({
  items,
  heading = "What People Ask Before Signing Up",
}: {
  items: { q: string; a: string }[];
  heading?: string;
}) {
  return (
    <Section id="faq" className="border-t border-gray-200 bg-gray-50 py-20">
      <Eyebrow>Questions</Eyebrow>
      <h2 className="reveal mt-4 display-section text-gray-900">
        {heading}
      </h2>

      <dl className="mt-10 grid gap-x-12 gap-y-8 md:grid-cols-2">
        {items.map((f) => (
          <div key={f.q}>
            <dt className="text-sm font-semibold text-gray-900">{f.q}</dt>
            <dd className="mt-2 text-sm leading-relaxed text-gray-600">{f.a}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export function ClosingCta({
  heading,
  body,
  // Was "Book A Discovery Call". We don't run discovery calls, and this link
  // has always gone to /signup — the label was inventing a step.
  cta = "Create Your Account",
  // Still signup by default; /products/seo passes its own CTA (signup with
  // ?product=seo, or adding SEO to a signed-in workspace).
  href = SIGNUP_CTA,
}: {
  heading: string;
  body: string;
  cta?: string;
  href?: string;
}) {
  return (
    <Section className="py-20">
      <div className="rounded-2xl border border-gray-200 bg-white px-8 py-14 text-center shadow-sm md:px-12">
        <h2 className="reveal display-section text-gray-900">
          {heading}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-gray-600">{body}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href={href}
            className="rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white hover:bg-gray-800"
          >
            {cta}
          </Link>
          <Link
            href="/login"
            className="rounded-md border border-gray-300 px-6 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Sign In
          </Link>
        </div>
      </div>
    </Section>
  );
}

/** The overage line, shared so no page can quote a different rate. */
// HARD CAP, NOT METERED OVERAGE (2026-08-13). Deliberately says what does NOT
// happen: an unexpected usage charge is the fear that stops a small business
// putting a phone number in front of an AI, and the answer to it is "we can't
// bill you for that, because we don't bill for it at all".
//
// Still bridges the two units. We SELL calls and we METER minutes, and the one
// moment a customer meets the second unit must not be a surprise.
export const OVERAGE_ANSWER = `We don't. There's no per-minute charge and no surprise bill — your plan is a cap, not a meter. Starter's ${
  STARTER_PLAN.includedMinutes
} minutes of talk time cover about ${advertisedCalls(
  STARTER_PLAN.includedMinutes,
)} calls a month, and never fewer than ${guaranteedCalls(
  STARTER_PLAN.includedMinutes,
)}, and you can see what you've used in your dashboard at any point. If you're regularly reaching it, that's a good problem — move up a plan and we'll handle the switch.`;

// ---------------------------------------------------------------------------
// Cross-sell blocks for the vertical pages (2026-10-12)
// ---------------------------------------------------------------------------
//
// Every industry page recommends a plan WITH SEO, not just the phone agent,
// and the store pages pitch the website widget. Both blocks quote prices, so
// they live here and read them from lib/seo-pricing.ts and lib/addons.ts like
// every other money block.

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

/**
 * "AI search optimization is included, free." Shown wherever SEO is pitched
 * on a vertical page. Only the website plans include it (SEO_PLANS'
 * includesWebsite), so the copy says "with every website SEO plan", never
 * "with every plan": Local SEO on its own does not cover it.
 */
export function AiSearchIncludedCallout({ className = "" }: { className?: string }) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-xl border-2 border-green-600 bg-green-50 p-5 sm:flex-row sm:items-center ${className}`}
    >
      <span className="w-max shrink-0 rounded-full bg-green-600 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
        Included Free
      </span>
      <p className="text-sm leading-relaxed text-green-900">
        <span className="font-semibold">AI Search Optimization</span>{" "}for
        ChatGPT and Google&rsquo;s AI Overviews comes with every website SEO
        plan. Many agencies sell it as a separate, expensive retainer. We
        don&rsquo;t charge for it at all.
      </p>
    </div>
  );
}

/**
 * "Pair it with SEO + AI Search": a recommended SEO plan for this vertical,
 * the other two as options, and the AI search callout. Links to
 * /products/seo rather than a checkout: SEO is its own subscription, bought
 * from that page or /billing.
 */
export function SeoPairing({
  audience,
  heading,
  body,
  recommend,
  reasons,
}: {
  /** Who the recommendation is for, e.g. "Online Stores". */
  audience: string;
  heading: string;
  body: string;
  recommend: SeoPlanKey;
  /** Why this plan fits this vertical, one line each. */
  reasons: string[];
}) {
  const plan = seoPlanByKey(recommend);
  const others = SEO_PLANS.filter((p) => p.key !== recommend);
  const priceLabel = (p: SeoPlan) =>
    p.perLocation
      ? `${usd(p.monthlyUsd)}/location/mo`
      : p.includedLocations > 0
        ? `${usd(p.monthlyUsd)}/mo + ${usd(SEO_EXTRA_LOCATION.monthlyUsd)}/extra location`
        : `${usd(p.monthlyUsd)}/mo`;

  return (
    <Section id="seo" className="border-t border-gray-200 py-20">
      <div className="grid gap-12 lg:grid-cols-2">
        <div>
          <Eyebrow>Pair It With SEO + AI Search</Eyebrow>
          <h2 className="reveal mt-4 display-section text-gray-900">
            {heading}
          </h2>
          <p className="mt-3 leading-relaxed text-gray-600">{body}</p>
          <ul className="mt-6 space-y-3">
            {reasons.map((r) => (
              <li key={r} className="flex gap-2 text-sm leading-relaxed text-gray-700">
                <Check /> {r}
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm text-gray-500">
            SEO + AI Search is its own subscription. Run it alongside your
            phone plan or on its own.
          </p>
        </div>

        <div>
          <div className="rounded-2xl border-2 border-gray-900 bg-white p-8 shadow-sm">
            <span className="rounded-full bg-gray-900 px-2.5 py-0.5 text-xs font-semibold text-white">
              Recommended For {audience}
            </span>
            <p className="mt-4 text-sm font-medium text-gray-500">{plan.name}</p>
            <p className="mt-1 text-3xl font-semibold tracking-tight text-gray-900">
              {usd(plan.monthlyUsd)}
              <span className="text-base font-normal text-gray-500">
                {plan.perLocation ? " / location / month" : " / month"}
              </span>
            </p>
            {!plan.perLocation && plan.includedLocations > 0 ? (
              <p className="mt-1 text-sm text-gray-500">
                Includes {plan.includedLocations} location, then{" "}
                {usd(SEO_EXTRA_LOCATION.monthlyUsd)}/mo per extra location
              </p>
            ) : null}
            <p className="mt-3 text-sm text-gray-600">{plan.headline}</p>
            <ul className="mt-5 space-y-2">
              {plan.includes.slice(0, 5).map((item) => (
                <li key={item} className="flex gap-2 text-sm text-gray-600">
                  <Check /> {item}
                </li>
              ))}
            </ul>
            <Link
              href="/products/seo#pricing"
              className="mt-6 block rounded-md bg-gray-900 px-4 py-3 text-center text-sm font-medium text-white hover:bg-gray-800"
            >
              See SEO + AI Search
            </Link>
          </div>

          <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-5">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
              Other Options
            </p>
            <ul className="mt-3 space-y-2">
              {others.map((p) => (
                <li key={p.key} className="flex flex-wrap justify-between gap-x-4 text-sm">
                  <span className="font-medium text-gray-900">{p.name}</span>
                  <span className="text-gray-600">{priceLabel(p)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <AiSearchIncludedCallout className="mt-10" />
    </Section>
  );
}

/**
 * The website widget: the same agent as a chat bubble on the client's site.
 * Sold as the Website Chat add-on on a phone plan (lib/addons.ts), so the
 * price line reads from there, and disappears if the add-on is pulled.
 */
export function WebsiteChatBand({
  heading,
  body,
  points,
  storeName,
  greeting,
}: {
  heading: string;
  body: string;
  points: { title: string; body: string }[];
  storeName: string;
  greeting?: string;
}) {
  const chat = ADDONS.find((a) => a.key === "website_chat");
  return (
    <Section id="website-chat" className="border-t border-gray-200 bg-gray-50 py-20">
      <div className="grid items-center gap-12 md:grid-cols-2">
        <div>
          <Eyebrow>Website Chat Widget</Eyebrow>
          <h2 className="reveal mt-4 display-section text-gray-900">
            {heading}
          </h2>
          <p className="mt-3 leading-relaxed text-gray-600">{body}</p>
          <div className="mt-8 space-y-5">
            {points.map((p) => (
              <div key={p.title} className="flex gap-3">
                <Check />
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">{p.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-gray-600">{p.body}</p>
                </div>
              </div>
            ))}
          </div>
          {chat?.available ? (
            <p className="mt-8 text-sm font-medium text-gray-900">
              Add it to any phone plan for {usd(chat.monthlyUsd)}/month.
            </p>
          ) : null}
        </div>
        <WidgetPreviewMockup
          storeName={storeName}
          accent="slate"
          greeting={greeting}
          caption="The chat widget on your website"
        />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Product-page blocks (2026-10-16, docs/rogiq-site-plan.md items 1 and 3)
// ---------------------------------------------------------------------------

type WorksWithKey = "voice" | "chat" | "seo";

/**
 * "Works better together": the other products, as cards, on each product
 * page. The cross-sell RogIQ runs as "Part of your complete system". Prices
 * come from their sources like every other money block, and a card whose
 * add-on has been pulled drops its price line rather than quote a stale one.
 */
export function WorksWith({
  current,
  heading,
  body,
}: {
  /** The page's own product, left out of the cards. */
  current: WorksWithKey;
  heading: string;
  body: string;
}) {
  const chat = ADDONS.find((a) => a.key === "website_chat");
  const cheapestTier = Math.min(...PLAN_TIERS.map((t) => t.monthlyUsd));
  const cards: {
    key: WorksWithKey;
    tag: string;
    title: string;
    body: string;
    price: string | null;
    href: string;
    cta: string;
  }[] = [
    {
      key: "voice",
      tag: "Phone",
      title: "AI Phone Agent",
      body: "Ranking brings the calls. The phone agent answers every one of them, 24/7, and books the job on your calendar.",
      price: `From ${usd(cheapestTier)}/mo, free setup`,
      href: "/products/phone-agent",
      cta: "See The Phone Agent",
    },
    {
      key: "chat",
      tag: "Chat",
      title: "Website Chat",
      body: "The same agent on your website, so visitors who'd rather type than call still get an answer and a booking.",
      price: chat?.available ? `+${usd(chat.monthlyUsd)}/mo on any phone plan` : null,
      href: "/pricing#addons",
      cta: "See Add-Ons",
    },
    {
      key: "seo",
      tag: "SEO",
      title: "SEO + AI Search",
      body: "An agent that answers every call is worth more when more people call. Get found on Google, in the map pack and in AI answers.",
      price: `From ${usd(seoPlanByKey("local").monthlyUsd)}/location/mo`,
      href: "/products/seo",
      cta: "See SEO + AI Search",
    },
  ];

  return (
    <Section id="works-with" className="border-t border-gray-200 bg-gray-50 py-20">
      <div className="max-w-2xl">
        <Eyebrow>Works Better Together</Eyebrow>
        <h2 className="reveal mt-4 display-section text-gray-900">{heading}</h2>
        <p className="mt-3 text-gray-600">{body}</p>
      </div>
      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {cards
          .filter((c) => c.key !== current)
          .map((c) => (
            <Link
              key={c.key}
              href={c.href}
              className="reveal group flex flex-col rounded-xl border border-gray-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-gray-900 hover:shadow-md"
            >
              <span className="w-max rounded-full bg-lumi-50 px-2.5 py-0.5 text-xs font-semibold text-lumi-700">
                {c.tag}
              </span>
              <h3 className="mt-4 text-lg font-semibold text-gray-900">{c.title}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-gray-600">{c.body}</p>
              {c.price ? (
                <p className="mt-5 text-sm font-medium text-gray-900">{c.price}</p>
              ) : null}
              <p className="mt-3 text-sm font-medium text-lumi-700 group-hover:underline">
                {c.cta}{" "}&rarr;
              </p>
            </Link>
          ))}
      </div>
      <p className="mt-8 text-sm text-gray-500">
        One account, one dashboard, and one team that builds all of it for you.
      </p>
    </Section>
  );
}

/**
 * The closing block on product and solution pages: two paths instead of one
 * button. A single business signs up; a multi-location group or an agency
 * talks to us, because Enterprise is quoted, not self-serve (EnterpriseBand).
 */
export function SplitCta({
  heading,
  body,
  cta = "Create Your Account",
  href = SIGNUP_CTA,
  contactSource,
}: {
  heading: string;
  body: string;
  cta?: string;
  href?: string;
  /** The page rendering this, so a /contact lead says where it came from. */
  contactSource: string;
}) {
  return (
    <Section className="py-20">
      <div className="text-center">
        <h2 className="reveal display-section text-gray-900">{heading}</h2>
        <p className="mx-auto mt-4 max-w-xl text-gray-600">{body}</p>
      </div>
      <div className="mx-auto mt-10 grid max-w-4xl gap-6 md:grid-cols-2">
        <div className="reveal flex flex-col rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-widest text-lumi-700">
            For Business Owners
          </p>
          <h3 className="mt-3 text-xl font-semibold text-gray-900">Running One Business?</h3>
          <p className="mt-2 flex-1 text-sm leading-relaxed text-gray-600">
            Create your account, tell us how you work, and we build and test it
            before a customer ever sees it.
          </p>
          <Link
            href={href}
            className="mt-6 rounded-md bg-gray-900 px-5 py-3 text-center text-sm font-medium text-white hover:bg-gray-800"
          >
            {cta}
          </Link>
        </div>
        <div className="reveal flex flex-col rounded-2xl bg-gray-900 p-8 text-white shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-widest text-lumi-400">
            For Groups And Agencies
          </p>
          <h3 className="mt-3 text-xl font-semibold">Many Locations Or Clients?</h3>
          <p className="mt-2 flex-1 text-sm leading-relaxed text-gray-300">
            One account across every location, brand or client, with custom
            limits and a dedicated team. Priced around what you need.
          </p>
          <a
            href={contactHref(contactSource, "Enterprise / White Label")}
            className="mt-6 rounded-md bg-white px-5 py-3 text-center text-sm font-medium text-gray-900 hover:bg-gray-100"
          >
            Talk To Us
          </a>
        </div>
      </div>
    </Section>
  );
}
