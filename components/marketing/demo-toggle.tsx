// Client component: the tab toggle used on partner landing pages to walk
// through channels (call, chat, order lookup, ticket, portal) without wiring
// up a real backend demo.
//
// DELIBERATELY LEAF-LEVEL. This renders only the tab strip and content panel
// — no <Section>/<Eyebrow> wrapper, even though every caller wants one. Those
// live in components/marketing/blocks.tsx, which also exports server-only
// helpers (planCtaHref, PricingGrid) that import lib/supabase/server.ts
// (next/headers). Importing blocks.tsx from a "use client" file pulls that
// whole module graph into the client bundle regardless of which export is
// actually used, and Next's RSC compiler rejects next/headers reachable from
// a client entry point. Keeping this component's only import surface to
// React itself avoids that boundary entirely. Callers (server components)
// wrap this in their own <Section>/<Eyebrow>, which they can do safely.
//
// STATIC AND ILLUSTRATIVE ON PURPOSE. Each tab shows representative copy, not
// real order or call data — the live product demos are /demo/orders and
// /demo/hvac. Don't repurpose this for anything that needs to look real.

"use client";

import { useState } from "react";

export function DemoToggle({
  tabs,
}: {
  tabs: { label: string; body: string }[];
}) {
  const [active, setActive] = useState(0);

  return (
    <div>
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-wrap gap-1 border-b border-gray-200 bg-gray-50 p-2">
          {tabs.map((tab, i) => (
            <button
              key={tab.label}
              type="button"
              onClick={() => setActive(i)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                i === active
                  ? "bg-gray-900 text-white"
                  : "text-gray-600 hover:bg-gray-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="p-6">
          <p className="text-sm leading-relaxed text-gray-700">
            {tabs[active].body}
          </p>
        </div>
      </div>
      <p className="mt-3 text-xs text-gray-400">
        Illustrative walkthrough. We&rsquo;ll show the real thing on a pilot call.
      </p>
    </div>
  );
}
