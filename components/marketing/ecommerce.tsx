// /solutions/ecommerce — the online-store vertical.
//
// Sells the SAME Starter/Growth/Scale ladder as everything else (decided
// 2026-08-12). No ecommerce-specific plan, price or Stripe object exists, so
// nothing on this page may imply one; the pricing block is the shared component
// for exactly that reason.
//
// EVERY CAPABILITY CLAIMED HERE IS BUILT AND RUNNING:
//   order lookup by number        supabase/functions/voice-order-lookup
//   Shopify AND WooCommerce       same function, one normalized shape (lib.ts)
//   tracking / carrier / ETA      Shopify fulfillments; Woo via ShipStation
//   identity check before details verify_hint (phone) / verifyCaller (web)
//   catalog answers               product-sync + products_cache (0018)
//   store policies                settings.policies -> {{store_policies}}
//   callback tickets              create_ticket + the review queue
//   web widget                    slug routing, live at /demo/orders
//
// EMAIL IS NOT ON THIS PAGE, deliberately. The email channel is paused, has no
// sending code in the repo, and its Zapier economics are unresolved
// (docs/BUILD-PLAN-2026-08.md §E). Do not add it here until that is settled.

import Link from "next/link";
import { MarketingShell } from "@/components/marketing/shell";
import {
  CallLengthPolicy,
  CapabilityGrid,
  Check,
  ClosingCta,
  DEMO_CTA,
  Eyebrow,
  FaqList,
  OVERAGE_ANSWER,
  Pillars,
  PricingGrid,
  Section,
} from "@/components/marketing/blocks";
import { STARTER_PLAN } from "@/lib/entitlements";

export const ECOMMERCE_METADATA = {
  title: "Lumilink for online stores | AI order support, 24/7",
  description:
    "Lumi answers “where is my order?” by phone and on your site — looking up the real order in Shopify or WooCommerce, reading back tracking, and logging a ticket when it can't finish. Including merchants other vendors turn away.",
};

/**
 * The demo line for this vertical.
 *
 * DELIBERATELY NULL. Two demo numbers are being purchased, one per vertical
 * (docs/BUILD-PLAN-2026-08.md §C). Until this one exists the page links to the
 * web demo only — it must NEVER fall back to a client's live number, which is
 * the exact bug that has /demo/hvac unlinked and noindexed today: a prospect's
 * test call landing on a paying client's line, burning their minutes and
 * reading out real order data.
 */
const DEMO_PHONE: string | null = null;

const PILLARS = [
  {
    n: "01",
    title: "“Where is my order?”, answered without you",
    body: "The most common question you get is also the most mechanical. Lumi takes the order number, looks up the real order, and reads back the status and tracking — at 2am, or while five people are queued.",
  },
  {
    n: "02",
    title: "It looks up the actual order",
    body: "Not a canned reply. A live read from Shopify or WooCommerce, so what your customer hears matches what your store says. If the store can't be reached, Lumi says so and takes a callback instead of guessing.",
  },
  {
    n: "03",
    title: "You can read every word",
    body: "Every call and web session lands in your dashboard with a transcript and the order it was about. Nothing your customer was told is invisible to you.",
  },
];

const CAPABILITIES = [
  {
    title: "Order status and tracking",
    body: "Order number in, status out — plus carrier, tracking number and estimated delivery when the shipment exists.",
  },
  {
    title: "Shopify and WooCommerce",
    body: "Both platforms, one agent. Your customers get the same answer whichever one you run.",
  },
  {
    title: "Checks who it's talking to",
    body: "Lumi confirms an identifying detail before reading anything personal, and on the web it asks for the order email or ZIP first. Order numbers are sequential; the check is what stops them being a lookup key for strangers.",
  },
  {
    title: "Answers product questions",
    body: "Syncs your catalog so Lumi can confirm what a product is, what it costs, and whether it's in stock.",
  },
  {
    title: "Knows your policies",
    body: "Returns, shipping and refund policy read from your own store — so the answer on the phone is the answer on your site.",
  },
  {
    title: "Nothing disappears",
    body: "When Lumi can't finish — a damaged parcel, a refund dispute, an order it genuinely can't find — it takes the details and logs a callback ticket in your queue.",
  },
];

/**
 * Regulated and high-risk verticals.
 *
 * Section rather than a dedicated page (decided 2026-08-12). It converts
 * because this audience arrives expecting to be turned away.
 *
 * The claim is about who our CUSTOMERS are, not what we sell, so it is not a
 * restricted-business question for our own billing — but confirm that before
 * this goes live rather than after.
 */
const VERTICALS = [
  "Hemp and CBD",
  "Peptides and research supplies",
  "Supplements and nutraceuticals",
  "Vape and smoke shops",
  "Firearms accessories",
  "Adult wellness",
];

const FAQS = [
  {
    q: "Which platforms do you support?",
    a: "Shopify and WooCommerce today. Both are read-only: Lumi looks orders up, it never edits or refunds them.",
  },
  {
    q: "How do you get access to my store?",
    a: "For Shopify we ask you to invite an account to your store, and we create the read-only connection ourselves — you never have to generate or paste an API key. WooCommerce uses a read-only REST key you create in your own admin.",
  },
  {
    q: "Can it look up any order?",
    a: "It matches the exact order number, and asks the caller to confirm an identifying detail before reading anything personal back. On your website it asks for the email or ZIP on the order first, and reveals nothing until that matches.",
  },
  {
    q: "What if it can't find the order?",
    a: "It says so, asks the customer to re-read the number, and then takes their details for a callback rather than guessing. A wrong order read aloud is worse than an honest handover.",
  },
  {
    q: "Do you work with hemp, peptide or supplement stores?",
    a: "Yes. We support merchants in regulated and high-risk categories that other vendors decline. Lumi answers from your own catalog and your own published policies, and it doesn't improvise claims about your products.",
  },
  {
    q: `Why are calls capped at ${STARTER_PLAN.maxCallMinutes} minutes?`,
    a: "A customer going in circles with an AI has a worse time than one who gets a callback from a person. Lumi warns before the limit, closes the conversation, and hands anything unresolved to you.",
  },
  {
    q: "What happens if I go over my minutes?",
    a: OVERAGE_ANSWER,
  },
  {
    q: "Does it handle email too?",
    a: "Phone and your website today. Email support is on the roadmap and we'd rather not sell you a channel we haven't finished.",
  },
];

export function EcommerceSolution() {
  return (
    <MarketingShell>
      {/* ------------------------------------------------------------------ */}
      {/* Hero                                                               */}
      {/* ------------------------------------------------------------------ */}
      <Section className="pb-20 pt-16 md:pb-28 md:pt-24">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <Eyebrow>AI order support for online stores</Eyebrow>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
              &ldquo;Where&rsquo;s my order?&rdquo; &mdash; answered in seconds,
              day or night
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-gray-600">
              Lumi picks up the phone, takes the order number, and reads back the
              real status and tracking from your store. Your inbox stops filling
              up with the same question.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href={DEMO_CTA}
                className="rounded-md bg-gray-900 px-5 py-3 text-sm font-medium text-white hover:bg-gray-800"
              >
                Book a discovery call
              </Link>
              <Link
                href="/demo/orders"
                className="rounded-md border border-gray-300 px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Try the live demo
              </Link>
            </div>

            {DEMO_PHONE ? (
              <p className="mt-4 text-sm text-gray-500">
                Or call the demo line:{" "}
                <span className="font-medium text-gray-900">{DEMO_PHONE}</span>
              </p>
            ) : null}

            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500">
              <li className="flex items-center gap-2">
                <Check /> Shopify &amp; WooCommerce
              </li>
              <li className="flex items-center gap-2">
                <Check /> Live order lookup
              </li>
              <li className="flex items-center gap-2">
                <Check /> Phone and web
              </li>
            </ul>
          </div>

          {/*
            SWAP FOR A REAL SCREENSHOT — a transcript with the order panel beside
            it is the single most persuasive image this page could carry. Mask
            the customer name. Quiet empty frame until then: a visitor should
            never be told what is missing.
          */}
          <div
            aria-hidden
            className="aspect-[4/3] rounded-xl border border-gray-200 bg-gray-50 shadow-sm"
          />
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* Why it works                                                       */}
      {/* ------------------------------------------------------------------ */}
      <Section className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>Why stores use it</Eyebrow>
        <Pillars items={PILLARS} />
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* Capabilities                                                       */}
      {/* ------------------------------------------------------------------ */}
      <Section className="py-20">
        <div className="max-w-2xl">
          <Eyebrow>What Lumi does</Eyebrow>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
            Reads your store, not a script
          </h2>
          <p className="mt-3 text-gray-600">
            Every answer comes from the order, the catalog or the policy you
            already published.
          </p>
        </div>
        <CapabilityGrid items={CAPABILITIES} />
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* Regulated verticals                                                */}
      {/* ------------------------------------------------------------------ */}
      <Section className="pb-20">
        <div className="rounded-2xl border border-gray-200 bg-gray-50 px-8 py-12 md:px-12">
          <div className="max-w-3xl">
            <Eyebrow>Industries we serve</Eyebrow>
            <h2 className="mt-4 text-2xl font-semibold tracking-tight text-gray-900 md:text-3xl">
              Including the ones other vendors turn away
            </h2>
            <p className="mt-4 leading-relaxed text-gray-600">
              If you sell in a regulated or high-risk category, you already know
              the routine: the software is fine until someone reads your product
              list. We support these stores, and Lumi answers strictly from your
              own catalog and your own published policies rather than
              improvising claims about what you sell.
            </p>
          </div>

          <ul className="mt-8 grid gap-x-10 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {VERTICALS.map((v) => (
              <li key={v} className="flex gap-2 text-sm text-gray-700">
                <Check />
                {v}
              </li>
            ))}
          </ul>

          <p className="mt-8 text-sm text-gray-500">
            Not listed? Ask. The answer is usually yes.
          </p>
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* Honesty block                                                      */}
      {/* ------------------------------------------------------------------ */}
      <CallLengthPolicy closing="An order status call takes well under a minute. The cap exists for the conversation that has gone wrong — a damaged parcel or a refund argument belongs with a person, and Lumi hands it over rather than talking in circles." />

      <PricingGrid blurb="The same plans as everywhere else — no separate ecommerce tier, no connector surcharge for reading your store. Every plan has a fixed minute allowance, and we'd rather give you the number than call it unlimited." />

      <FaqList items={FAQS} heading="What store owners ask" />

      <ClosingCta
        heading="Stop answering the same question"
        body="Twenty minutes on your store, your policies and your busiest questions. Lumi is answering them about a week later."
      />
    </MarketingShell>
  );
}
