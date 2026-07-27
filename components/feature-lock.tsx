// Shown in place of a gated page's content when the tenant doesn't hold the
// feature. Presentational only (server component) — the real checkout lives on
// /billing, so this just explains the value and links there.

import Link from "next/link";
import { featureMeta, type Feature, type FeatureState } from "@/lib/entitlements";

const STATE_COPY: Record<
  FeatureState,
  { badge: string; cta: string; note: string }
> = {
  locked: {
    badge: "Locked",
    cta: "See plans & unlock",
    note: "This feature isn't on your plan yet.",
  },
  setup: {
    badge: "Setting up",
    cta: "View setup status",
    note: "Payment received — we're provisioning this now. It'll unlock automatically.",
  },
  canceled: {
    badge: "Canceled",
    cta: "Reactivate",
    note: "This plan was canceled. Reactivate to turn it back on.",
  },
  past_due: {
    badge: "Past due",
    cta: "Fix billing",
    note: "There's a billing issue on this plan.",
  },
  active: { badge: "Active", cta: "Manage plan", note: "" },
};

export function FeatureLock({
  feature,
  state,
}: {
  feature: Feature;
  state: FeatureState;
}) {
  const meta = featureMeta(feature);
  const copy = STATE_COPY[state];
  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">
          {copy.badge}
        </span>
        <h1 className="mt-4 text-xl font-semibold text-gray-900">{meta.label}</h1>
        <p className="mt-1 text-sm font-medium text-gray-500">{meta.tagline}</p>
        <p className="mx-auto mt-4 max-w-md text-sm text-gray-600">{meta.blurb}</p>
        <ul className="mx-auto mt-5 max-w-xs space-y-1.5 text-left">
          {meta.bullets.map((b) => (
            <li key={b} className="flex items-start gap-2 text-sm text-gray-700">
              <span aria-hidden className="mt-0.5 text-green-600">
                ✓
              </span>
              {b}
            </li>
          ))}
        </ul>
        <div className="mt-6">
          <Link
            href="/billing"
            className="inline-flex items-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            {copy.cta}
          </Link>
        </div>
        {copy.note ? (
          <p className="mt-3 text-xs text-gray-400">{copy.note}</p>
        ) : null}
      </div>
    </div>
  );
}
