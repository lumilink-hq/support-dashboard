// CSS mockups of a CLIENT'S branded storefront support surfaces — the phone
// line and chat widget as a customer sees them, not the internal dashboard
// (see dashboard-mockups.tsx for that).
//
// WHY THIS EXISTS (2026-08-31). /solutions/ecommerce used to show real
// screenshots of two actual clients' storefronts by name (Tsunami,
// BudClub) — genuine social proof, but it put a real company's name and
// branding on a public marketing page. The founder's call: drop the named
// social proof entirely, in favor of showing the CAPABILITY (your branding,
// our support line running underneath it) with invented store identities.
// This is honest either way it's read — it never claims to be a real,
// named client, just what the surface looks like once it's yours.

import { MockupFrame } from "@/components/marketing/dashboard-mockups";

const ACCENTS = {
  slate: { bar: "bg-slate-800", chip: "bg-slate-100 text-slate-700" },
  green: { bar: "bg-emerald-800", chip: "bg-emerald-100 text-emerald-700" },
} as const;

/** A client's branded order-support page — the header, the number, "Powered by LumiLink." */
export function StorefrontSupportMockup({
  storeName,
  tagline,
  phone,
  accent,
  caption,
  className,
}: {
  storeName: string;
  tagline: string;
  phone: string;
  accent: keyof typeof ACCENTS;
  caption: string;
  className?: string;
}) {
  const a = ACCENTS[accent];
  return (
    <MockupFrame caption={caption} className={className}>
      <div className={`-m-5 mb-0 rounded-t-xl px-5 py-3 sm:-m-6 sm:mb-0 sm:px-6 ${a.bar}`}>
        <p className="text-sm font-semibold tracking-tight text-white">
          {storeName}
        </p>
        <p className="text-xs text-white/70">{tagline}</p>
      </div>

      <div className="pt-5 sm:pt-6">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${a.chip}`}
        >
          Powered by LumiLink
        </span>

        <p className="mt-3 text-sm text-gray-600">
          Order questions? Call or text and we&rsquo;ll pull it up.
        </p>
        <p
          aria-hidden
          className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-1.5 font-mono text-sm font-medium text-white"
        >
          ☎ {phone}
        </p>
      </div>
    </MockupFrame>
  );
}

/** The floating website chat widget, collapsed launcher plus one preview message. */
export function WidgetPreviewMockup({
  storeName,
  accent,
  caption,
  className,
}: {
  storeName: string;
  accent: keyof typeof ACCENTS;
  caption: string;
  className?: string;
}) {
  const a = ACCENTS[accent];
  return (
    <MockupFrame caption={caption} className={className}>
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium text-gray-400">{storeName}</p>
        <span
          aria-hidden
          className={`grid h-9 w-9 place-items-center rounded-full text-white shadow-md ${a.bar}`}
        >
          💬
        </span>
      </div>

      <div className="mt-3 w-full max-w-[240px] rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
        <p className="text-[10px] font-semibold text-gray-400">
          {storeName} Support
        </p>
        <div className="mt-2 rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-700">
          Hi! Ask me about an order, and I&rsquo;ll pull up the real status.
        </div>
        <div className="mt-2 rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-400">
          Type a message…
        </div>
      </div>
    </MockupFrame>
  );
}
