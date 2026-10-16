// "/products" — the overview of everything LumiLink sells (2026-10-16).
//
// The Products menu had no landing spot of its own; RogIQ's "Platform"
// overview is the model (docs/rogiq-site-plan.md item 1). Short on purpose:
// the product cards (shared with the landing page, so prices and blurbs can't
// drift), how the products fit together, and the two-path ending. Detail
// lives on each product's own page.

import { MarketingShell } from "@/components/marketing/shell";
import {
  Accent,
  Check,
  Eyebrow,
  Section,
  SplitCta,
} from "@/components/marketing/blocks";
import { AutomationFeedMockup } from "@/components/marketing/dashboard-mockups";
import { PRODUCT_CARDS } from "@/components/marketing/landing";
import Link from "next/link";

export const PRODUCTS_METADATA = {
  title: "Products: AI Phone Agent, Website Chat, SEO + AI Search | LumiLink",
  description:
    "Everything LumiLink does: an AI phone agent that books jobs, website chat, and SEO that gets you found on Google and in AI search. One dashboard, built for you.",
};

const FLOW = [
  {
    n: "01",
    title: "Get Found",
    body: "SEO + AI Search puts you in Google's results, the local map pack, and the answers ChatGPT and Google's AI give.",
  },
  {
    n: "02",
    title: "Get Answered",
    body: "The phone agent and website chat pick up every call and visitor, quote from your prices and book the job.",
  },
  {
    n: "03",
    title: "See Everything",
    body: "Calls, chats, bookings, rankings and reports land in one dashboard, and anything that needs you lands in one queue.",
  },
];

export function ProductsOverview() {
  return (
    <MarketingShell>
      <Section className="bg-hero-glow pb-20 pt-16 md:pb-28 md:pt-24">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <Eyebrow>Products</Eyebrow>
            <h1 className="mt-4 display-hero text-gray-900">
              Found, Answered, Booked. <Accent>One Dashboard.</Accent>
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-gray-600">
              Each LumiLink product does one job well, and together they cover
              the whole path from a customer searching to a job on your
              calendar. Start with one. Add the rest when you&rsquo;re ready.
            </p>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500">
              <li className="flex items-center gap-2">
                <Check /> One Account
              </li>
              <li className="flex items-center gap-2">
                <Check /> One Dashboard
              </li>
              <li className="flex items-center gap-2">
                <Check /> We Build It For You
              </li>
            </ul>
          </div>
          <AutomationFeedMockup
            caption="Your dashboard — everything LumiLink handled today"
            className="min-w-0"
          />
        </div>
      </Section>

      <Section className="border-t border-gray-200 py-20">
        <div className="grid gap-6 md:grid-cols-3">
          {PRODUCT_CARDS.map((p) => (
            <Link
              key={p.title}
              href={p.href}
              className="reveal group flex flex-col rounded-xl border border-gray-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-lumi-400 hover:shadow-md"
            >
              <span className="w-max rounded-full bg-lumi-50 px-2.5 py-0.5 text-xs font-semibold text-lumi-700">
                {p.tag}
              </span>
              <h2 className="mt-4 text-lg font-semibold text-gray-900">{p.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">{p.body}</p>
              <ul className="mt-4 flex-1 space-y-1.5">
                {p.bullets.map((b) => (
                  <li key={b} className="flex gap-2 text-sm text-gray-700">
                    <Check /> {b}
                  </li>
                ))}
              </ul>
              <p className="mt-5 text-sm font-medium text-gray-900">{p.price}</p>
              <p className="mt-3 text-sm font-medium text-lumi-700 group-hover:underline">
                {p.cta}{" "}&rarr;
              </p>
            </Link>
          ))}
        </div>
      </Section>

      <Section className="border-t border-gray-200 bg-gray-50 py-20">
        <Eyebrow>How It Fits Together</Eyebrow>
        <h2 className="reveal mt-4 max-w-2xl display-section text-gray-900">
          From Search To Booked Job, Without You In The Middle
        </h2>
        <div className="mt-12 grid gap-10 md:grid-cols-3">
          {FLOW.map((f) => (
            <div key={f.n} className="reveal">
              <p className="text-sm font-semibold text-lumi-600">{f.n}</p>
              <h3 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">{f.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <SplitCta
        heading="Start With The One That Hurts Most"
        body="Pick a product, tell us how you work, and we build it. Everything you add later lands in the same dashboard."
        contactSource="/products"
      />
    </MarketingShell>
  );
}
