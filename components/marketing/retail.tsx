// /solutions/retail — the retail-locations vertical (2026-10-12).
//
// Brick-and-mortar stores, from one shop to a chain. The pitch is three
// products working per storefront: the phone agent (with more numbers per
// store and more locations as add-ons), the website chat widget, and site +
// local SEO with AI search optimization included.
//
// Same Starter/Growth/Scale ladder as everything else: no retail plan, price
// or Stripe object exists, so the pricing block is the shared one. Add-on and
// SEO prices are read from lib/addons.ts and lib/seo-pricing.ts, never typed
// in here.
//
// COPY ONLY CLAIMS WHAT IS BUILT. Hours, directions and policies come from
// website knowledge sync; product and stock answers need a Shopify or
// WooCommerce catalog (product-sync); extra numbers and locations are real
// add-ons but are fulfilled by hand (lib/addons.ts manualFulfilment). There is
// no retail demo line, so the hero has no "call it" link.

import Link from "next/link";
import { MarketingShell } from "@/components/marketing/shell";
import {
  Accent,
  CallLengthPolicy,
  CapabilityGrid,
  Check,
  DoneForYouBand,
  Eyebrow,
  FaqList,
  OVERAGE_ANSWER,
  Pillars,
  PricingGrid,
  Section,
  SeoPairing,
  SIGNUP_CTA,
  SplitCta,
  WebsiteChatBand,
} from "@/components/marketing/blocks";
import { StorefrontSupportMockup } from "@/components/marketing/storefront-mockups";
import { ADDONS } from "@/lib/addons";
import { SEO_EXTRA_LOCATION, seoPlanByKey } from "@/lib/seo-pricing";
import { STARTER_PLAN } from "@/lib/entitlements";

export const RETAIL_METADATA = {
  title: "LumiLink for retail stores | AI customer service + local SEO",
  description:
    "AI phone and website support for every storefront, from one shop to many locations, plus website and local SEO with AI search optimization included.",
};

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

function addonPrice(key: string): string | null {
  const a = ADDONS.find((x) => x.key === key && x.available);
  return a ? `${usd(a.monthlyUsd)}/mo` : null;
}

const EXTRA_LINE = addonPrice("additional_phone_line");
const EXTRA_LOCATION = addonPrice("additional_location");
const LOCAL_SEO = seoPlanByKey("local");
const BUNDLE = seoPlanByKey("bundle");

const PILLARS = [
  {
    n: "01",
    title: "Every storefront answered",
    body: "Hours, directions, returns, “do you have it in stock?” Lumi answers the calls your floor staff can't get to, so nobody is pulled off a customer standing in front of them.",
  },
  {
    n: "02",
    title: "One store or many",
    body: "Start with a single shop. Add locations as you grow, each with its own number, hours, greeting and routing, all in one dashboard.",
  },
  {
    n: "03",
    title: "On the phone and on your site",
    body: "The same agent answers your phone lines and a chat widget on your website, from the same store details.",
  },
  {
    n: "04",
    title: "Found before they visit",
    body: "Website and local SEO put each store in Google's map pack and search results, and AI search optimization gets you named in ChatGPT and AI Overviews.",
  },
];

const CAPABILITIES = [
  {
    title: "Hours, directions and parking",
    body: "Store hours, holiday hours, where to park and how to find you, read from your own website so the answer stays current.",
  },
  {
    title: "Product and stock questions",
    body: "Connect a Shopify or WooCommerce catalog and Lumi can confirm what you carry, what it costs and whether it's in stock.",
  },
  {
    title: "Returns and store policies",
    body: "Returns, exchanges, layaway, gift cards: answered from the policies you publish, the same way every time.",
  },
  {
    title: "Online order lookups",
    body: "Selling online too? Lumi looks up the real order in Shopify or WooCommerce and reads back the status and tracking.",
  },
  {
    title: "Hands off to your team",
    body: "When a caller needs a person, Lumi transfers the call or takes the details and logs a callback ticket in your queue.",
  },
  {
    title: "Every word on record",
    body: "Every call and chat lands in your dashboard with a transcript, so you know what each store's customers are asking.",
  },
];

const WIDGET_POINTS = [
  {
    title: "Questions answered before the trip",
    body: "Shoppers check hours, stock and policies on your site without calling, and show up knowing you have what they need.",
  },
  {
    title: "The same answers as your phone line",
    body: "The widget and your phone agent share the same store details, so a customer hears the same thing either way.",
  },
  {
    title: "Logged with everything else",
    body: "Every chat lands in your dashboard next to your calls, with the full transcript.",
  },
];

const FAQS = [
  {
    q: "Is this for one store or a chain?",
    a: "Both. A single shop gets a local number, its own hours and policies, and Local SEO for its one location. A multi-location retailer adds each store as a location with its own number, hours, greeting and routing, and sees every store in one dashboard.",
  },
  {
    q: "Can one store have more than one number?",
    a: `Yes. Add another AI phone line to any store${EXTRA_LINE ? ` for ${EXTRA_LINE}` : ""}, for a returns desk, a pickup line, a department or a campaign. Scale includes two numbers.`,
  },
  {
    q: "How do I add more locations?",
    a: `Each extra store is an add-on${EXTRA_LOCATION ? ` at ${EXTRA_LOCATION}` : ""} on your phone plan, with its own number, hours, greeting and routing. Large groups and franchises can talk to us about Enterprise.`,
  },
  {
    q: "Can it check what's in stock?",
    a: "If your catalog lives in Shopify or WooCommerce, yes: we sync it and Lumi answers from it. If it doesn't, Lumi answers from your website and policies and takes a callback for anything it can't confirm, rather than guessing.",
  },
  {
    q: "What does SEO cost for multiple stores?",
    a: `Local SEO is ${usd(LOCAL_SEO.monthlyUsd)} a month per location. Full SEO + AI Search covers your website and one location for ${usd(BUNDLE.monthlyUsd)} a month, and each extra location is ${usd(SEO_EXTRA_LOCATION.monthlyUsd)}. AI search optimization comes with the website plans at no extra cost.`,
  },
  {
    q: "Do I need a phone plan to get SEO?",
    a: "No. SEO + AI Search is its own subscription. Most retailers run both, but you can start with either.",
  },
  {
    q: `Why are calls capped at ${STARTER_PLAN.maxCallMinutes} minutes?`,
    a: "A customer going in circles with an AI has a worse time than one who gets a callback from a person. Lumi warns before the limit, closes the conversation, and hands anything unresolved to your store.",
  },
  {
    q: "What If I Run Out Of Calls?",
    a: OVERAGE_ANSWER,
  },
];

/** The single-store vs multi-location comparison. */
function LocationScale() {
  const single = [
    `A local AI phone number (Starter includes ${STARTER_PLAN.numbers})`,
    "Your hours, greeting and store policies",
    "Website chat widget as an add-on",
    `Local SEO for your location, ${usd(LOCAL_SEO.monthlyUsd)}/mo`,
  ];
  const multi = [
    `Each store gets its own number, hours, greeting and routing${EXTRA_LOCATION ? ` (${EXTRA_LOCATION} per extra location)` : ""}`,
    `Multiple numbers per storefront${EXTRA_LINE ? ` (${EXTRA_LINE} per extra line)` : ""}`,
    "Every store's calls and chats in one dashboard",
    `Full SEO + AI Search for your website and every location, ${usd(SEO_EXTRA_LOCATION.monthlyUsd)}/mo per extra location`,
  ];
  return (
    <Section className="py-20">
      <div className="max-w-2xl">
        <Eyebrow>Built for one shop or many</Eyebrow>
        <h2 className="reveal mt-4 display-section text-gray-900">
          Optimized for a single location or a whole chain
        </h2>
        <p className="mt-3 text-gray-600">
          Start with the store you have. Every piece scales by location, so
          the tenth store is set up the same way as the first.
        </p>
      </div>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-medium text-gray-500">Single location</p>
          <h3 className="mt-2 text-xl font-semibold text-gray-900">
            One store, fully covered
          </h3>
          <ul className="mt-6 space-y-3">
            {single.map((item) => (
              <li key={item} className="flex gap-2 text-sm text-gray-700">
                <Check /> {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl border-2 border-lumi-600 bg-white p-8 shadow-sm">
          <p className="text-sm font-medium text-gray-500">Multi-location</p>
          <h3 className="mt-2 text-xl font-semibold text-gray-900">
            Every storefront, one account
          </h3>
          <ul className="mt-6 space-y-3">
            {multi.map((item) => (
              <li key={item} className="flex gap-2 text-sm text-gray-700">
                <Check /> {item}
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm text-gray-500">
            Franchise or large group?{" "}
            <Link
              href="/pricing#enterprise"
              className="font-medium text-gray-900 underline underline-offset-4"
            >
              See Enterprise
            </Link>
          </p>
        </div>
      </div>
    </Section>
  );
}

export function RetailSolution() {
  return (
    <MarketingShell>
      <Section className="bg-hero-glow pb-20 pt-16 md:pb-28 md:pt-24">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <Eyebrow>AI customer service for retail stores</Eyebrow>
            <h1 className="mt-4 display-hero text-gray-900">
              Every storefront answered. <Accent>Every location found.</Accent>
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-gray-600">
              Whether you run one shop or twenty, Lumi answers each store&rsquo;s
              phones and website chat with that store&rsquo;s hours, stock and
              policies. SEO + AI Search gets every location found on Google, in
              the map pack and in AI answers.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href={SIGNUP_CTA}
                className="rounded-md btn-raspberry px-5 py-3 text-sm font-medium"
              >
                Create your account
              </Link>
              <a
                href="#seo"
                className="rounded-md border border-gray-300 px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                See the SEO plans
              </a>
            </div>

            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500">
              <li className="flex items-center gap-2">
                <Check /> Single or multi-location
              </li>
              <li className="flex items-center gap-2">
                <Check /> Multiple numbers per store
              </li>
              <li className="flex items-center gap-2">
                <Check /> Website chat
              </li>
              <li className="flex items-center gap-2">
                <Check /> Site + local SEO
              </li>
              <li className="flex items-center gap-2 font-medium text-green-700">
                <Check /> AI search optimization, free
              </li>
            </ul>
          </div>

          {/* CSS mockup with an invented store, same rule as the ecommerce
              page: no named client on a marketing page. */}
          <StorefrontSupportMockup
            storeName="Harborview Outfitters"
            tagline="Downtown · Store support"
            phone="(555) 014-3388"
            accent="green"
            message="Questions about hours, stock or a return? Call us, day or night."
            caption="What it looks like for your store"
          />
        </div>
      </Section>

      <Section className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>Why retailers use it</Eyebrow>
        <Pillars items={PILLARS} />
      </Section>

      <DoneForYouBand />

      <Section className="py-20">
        <div className="max-w-2xl">
          <Eyebrow>Storefront customer service</Eyebrow>
          <h2 className="reveal mt-4 display-section text-gray-900">
            The questions your floor staff answer all day
          </h2>
          <p className="mt-3 text-gray-600">
            Answered by Lumi on the phone, around the clock, from your own
            store details.
          </p>
        </div>
        <CapabilityGrid items={CAPABILITIES} />
      </Section>

      <LocationScale />

      <WebsiteChatBand
        heading="Answer shoppers on your website, too"
        body="Plenty of customers check your site before they visit. The website widget puts the same agent in a chat bubble there, answering hours, stock and policy questions for each store."
        points={WIDGET_POINTS}
        storeName="Harborview Outfitters"
        greeting="Hi! Ask me about store hours, stock or returns."
      />

      <SeoPairing
        audience="Retail Stores"
        heading="Get every location found: on Google, on the map and in AI answers"
        body="Shoppers search before they drive. Full SEO + AI Search covers your website and each store's local rankings in one plan, and adding a store costs less than buying Local SEO for it on its own."
        recommend="bundle"
        reasons={[
          "Site SEO: weekly audits, technical checks and fixes drafted for your approval",
          "Local SEO for each store: map pack rankings and a geo grid around every location",
          "Competitor tracking for each store's own market",
          "AI search optimization for ChatGPT and Google's AI Overviews, included free",
        ]}
      />

      <CallLengthPolicy closing="Most store calls are an hours or stock question that takes under a minute. The cap exists for the call that has gone wrong: a disputed return belongs with your staff, and Lumi hands it over rather than talking in circles." />

      <PricingGrid blurb="The same phone plans as everywhere else, with extra numbers and locations as add-ons when you need them. Every plan comes with a set number of calls and no setup fee." />

      <FaqList items={FAQS} heading="What retailers ask" />

      <SplitCta
        heading="Give every store a front desk that never closes"
        body="Tell us about your stores, your hours and your busiest questions. We build it, and Lumi starts answering for every location."
        contactSource="/solutions/retail"
      />
    </MarketingShell>
  );
}
