// "/demo/orders" — the customer-service demo.
//
// Counterpart to /demo, which demos scheduling for a home-service company. This
// one demos order lookup and product questions for an online store.
//
// The tenant is Northlake Supply, a FICTIONAL store seeded by
// supabase/seed/demo_orders_client.sql. Deliberately not a real client: pointing
// a public demo at Bud Club or Tsunami would expose a paying customer's
// inventory, and order lookup would either fail on the question that matters or
// read real people's orders aloud to strangers.
//
// PHONE VS BROWSER. The browser widget routes by `client_slug`, and only
// demo-flagged tenants resolve that way, so it can never reach a real client.
// The phone path routes by DIALLED NUMBER, and resolve_client_by_number returns
// exactly one client — so a single number cannot serve both demos. That is why
// this page ran browser-only until 2026-08-12: rather than advertise a number
// that reaches the wrong agent, it advertised none.
//
// RESOLVED. Each vertical now has its own line, in lib/demo.ts. This one must be
// held by `northlake-demo` in clients.phone_number — see
// scripts/assign-demo-numbers.sql.

import type { Metadata } from "next";
import Link from "next/link";
import { LumiWidget } from "@/components/lumi-widget";
import { DEMO_LINES } from "@/lib/demo";

export const metadata: Metadata = {
  title: "Meet Lumi — the AI agent that answers order questions | LumiLink",
  description:
    "Try Lumi, the AI phone agent for online stores. Ask about an order, a delivery, or what's in stock at our demo store, by phone or in your browser.",
};

const DEMO_AGENT_ID = process.env.NEXT_PUBLIC_ELEVENLABS_ORDERS_AGENT_ID;
const DEMO_CLIENT_SLUG = DEMO_LINES.ecommerce.slug;
const PHONE_TEL = DEMO_LINES.ecommerce.tel;
const PHONE_DISPLAY = DEMO_LINES.ecommerce.display;

// Seeded by demo_orders_client.sql. Each one reaches a different branch, so a
// visitor picking any of them sees something worth seeing.
const PROMPTS = [
  {
    n: 1,
    q: "Where's my order? It's 1001.",
    s: "Lumi finds it, reads the status, and gives the tracking number.",
  },
  {
    n: 2,
    q: "I ordered a few days ago and haven't heard anything. Order 1003.",
    s: "That one is on hold. Lumi says so and takes a callback instead of guessing.",
  },
  {
    n: 3,
    q: "Do you have the Summit Down Jacket in a medium?",
    s: "It's sold out. Lumi says so and offers what is actually in stock.",
  },
];

const CATALOG = [
  { name: "Ridgeline 2P Tent", tag: "$249" },
  { name: "Trailhead 45L Pack", tag: "from $179" },
  { name: "Basecamp Stove", tag: "$64" },
  { name: "Summit Down Jacket", tag: "$289", soldOut: true },
];

export default function OrdersDemoPage() {
  const hasPhone = Boolean(PHONE_TEL);

  return (
    <div className="min-h-full bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-5xl px-5">
        <header className="flex items-center justify-between py-5">
          <Link
            href="/"
            className="flex items-center gap-2.5 font-bold tracking-tight"
          >
            <span className="h-5 w-5 rounded-md bg-gradient-to-br from-blue-600 to-orange-500" />
            LumiLink
          </Link>
          <span className="text-[13px] text-slate-500">Live demo</span>
        </header>

        <section className="relative mt-2 overflow-hidden rounded-3xl bg-gradient-to-br from-[#0f2a1f] via-[#14532d] to-emerald-600 px-8 py-14 text-white sm:px-10">
          <span className="inline-block rounded-full bg-white/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-emerald-200">
            AI support for online stores
          </span>
          <h1 className="mt-4 max-w-[18ch] text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl">
            Lumi answers &ldquo;where&rsquo;s my order?&rdquo; so you don&rsquo;t
            have to.
          </h1>
          <p className="mt-3 max-w-[52ch] text-lg text-emerald-100">
            Order status, delivery questions, and what&rsquo;s in stock. Try it
            on our demo store, <strong>Northlake Supply</strong>.
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3.5">
            {hasPhone ? (
              <a
                href={`tel:${PHONE_TEL}`}
                className="inline-flex items-center gap-2.5 rounded-xl bg-orange-500 px-5 py-3.5 text-[17px] font-bold text-white shadow-lg shadow-orange-500/30 hover:brightness-105"
              >
                Call the demo line — {PHONE_DISPLAY}
              </a>
            ) : null}
            <a
              href="#try"
              className="inline-flex items-center gap-2.5 rounded-xl border border-white/25 bg-white/10 px-5 py-3.5 text-[17px] font-bold text-white hover:bg-white/15"
            >
              See what to try
            </a>
          </div>

          <p className="mt-4 text-sm text-emerald-200">
            {DEMO_AGENT_ID
              ? "Tap the chat bubble in the corner to talk to Lumi right in your browser."
              : "Browser demo is being switched on. Book a call and we'll run it with you live."}
          </p>
        </section>

        <section id="try" className="mt-12 scroll-mt-6">
          <h2 className="text-2xl font-semibold tracking-tight">
            Try it — a few things to ask
          </h2>
          <p className="mt-1.5 max-w-[60ch] text-slate-500">
            These reach a real seeded store, so the answers are real lookups
            rather than a script.
          </p>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {PROMPTS.map((p) => (
              <div
                key={p.n}
                className="rounded-2xl border border-slate-200 bg-white p-5"
              >
                <span className="grid h-7 w-7 place-items-center rounded-full bg-emerald-600 text-sm font-bold text-white">
                  {p.n}
                </span>
                <p className="mt-3 font-medium text-slate-900">
                  &ldquo;{p.q}&rdquo;
                </p>
                <p className="mt-1.5 text-sm text-slate-500">{p.s}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl font-semibold tracking-tight">
            What the demo store sells
          </h2>
          <p className="mt-1.5 max-w-[60ch] text-slate-500">
            Lumi answers from this catalog. The jacket is sold out on purpose, so
            you can hear what happens when the answer is no.
          </p>
          <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CATALOG.map((item) => (
              <li
                key={item.name}
                className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3"
              >
                <span className="font-medium text-slate-900">
                  {item.name}
                  {item.soldOut ? (
                    <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 align-middle text-[11px] font-bold text-slate-600">
                      Sold out
                    </span>
                  ) : null}
                </span>
                <span className="text-sm text-slate-500">{item.tag}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-16 mt-12 rounded-2xl border border-slate-200 bg-white px-8 py-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">
            Want this answering for your store?
          </h2>
          <p className="mx-auto mt-2 max-w-[46ch] text-slate-500">
            We connect it to your real catalog and orders, then you hear it
            before your customers do.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/plans"
              className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-bold text-white hover:bg-slate-800"
            >
              See plans
            </Link>
            <Link
              href="/"
              className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50"
            >
              How it works
            </Link>
          </div>
        </section>
      </div>

      {DEMO_AGENT_ID ? (
        <LumiWidget agentId={DEMO_AGENT_ID} clientSlug={DEMO_CLIENT_SLUG} />
      ) : null}
    </div>
  );
}
