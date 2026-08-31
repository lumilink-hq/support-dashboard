// "/addons" — the public add-on list (2026-08-30 repositioning brief).
//
// SOURCE OF TRUTH IS lib/addons.ts, NOT A NEW LIST. That file already backs
// /billing's "Build Out Your Plan" section and the /welcome post-purchase
// screen — the whole point of it existing is that those two can't disagree
// about what an add-on costs or is called. This page reuses the same
// availableAddons() call rather than re-describing the catalogue, so a third
// place can't drift from the other two either.
//
// Every add-on's `url` is its own Stripe Payment Link, exactly as /billing
// links it — no client_reference_id, no session-aware routing. That matches
// existing behavior for add-ons specifically (unlike plan checkout, which
// does carry client_reference_id via /plans); see lib/addons.ts's own header
// comment for why a bare Payment Link is fine here.

import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/shell";
import { Eyebrow, Section } from "@/components/marketing/blocks";
import { availableAddons } from "@/lib/addons";

export const metadata: Metadata = {
  title: "Add-Ons | LumiLink",
  description:
    "Optional extras that ride your existing plan: an additional phone line, another location, a managed integration, and more.",
  alternates: { canonical: "/addons" },
};

export default function AddonsPage() {
  const addons = availableAddons();

  return (
    <MarketingShell>
      <Section className="py-20">
        <div className="max-w-2xl">
          <Eyebrow>Add-Ons</Eyebrow>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900">
            Build Out Your Plan
          </h1>
          <p className="mt-3 text-lg text-gray-600">
            Every plan starts with the core agent. Add what your business
            needs from there, billed on the same subscription as your plan.
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {addons.map((a) => (
            <div
              key={a.key}
              className="flex flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-base font-semibold text-gray-900">
                  {a.name}
                </h2>
                <p className="shrink-0 text-sm font-medium text-gray-900">
                  ${a.monthlyUsd}
                  <span className="text-gray-500">/mo</span>
                </p>
              </div>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-gray-600">
                {a.blurb}
              </p>
              <a
                href={a.url}
                className="mt-4 block rounded-md border border-gray-300 px-3 py-2 text-center text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Add To Plan
              </a>
            </div>
          ))}
        </div>

        {/*
          Website Chat exists in lib/addons.ts with available=false — nothing
          meters a browser chat session yet (BUILD-PLAN-2026-08.md §H). Same
          "Building next" framing as the homepage's What Lumi Does section,
          deliberately not offered for sale here.
        */}
        <p className="mt-10 text-sm text-gray-500">
          Building next: Website Chat, so the same agent can answer on your
          site as well as your phone line.
        </p>

        <p className="mt-2 text-sm text-gray-500">
          Don&rsquo;t see what you need?{" "}
          <Link
            href="/contact"
            className="font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700"
          >
            Contact us
          </Link>
          , or see the{" "}
          <Link
            href="/plans"
            className="font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700"
          >
            core plans
          </Link>{" "}
          add-ons build on.
        </p>
      </Section>
    </MarketingShell>
  );
}
