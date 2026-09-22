// Shown in place of an SEO page when the tenant has no usable `seo` entitlement.
// Not FeatureLock: featureMeta() has no 'seo' entry (SEO has no tier picker yet,
// see lib/entitlements.ts) and would fall back to the voice card.

import Link from "next/link";
import type { FeatureState } from "@/lib/entitlements";

const COPY: Record<FeatureState, string> = {
  locked: "Local SEO isn't on your plan yet.",
  setup: "Payment received. We're setting up local SEO now and it will unlock automatically.",
  canceled: "The local SEO plan was canceled.",
  past_due: "There's a billing issue on the local SEO plan.",
  active: "",
};

export function SeoLocked({ state }: { state: FeatureState }) {
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-gray-900">Local SEO</h1>
      <p className="mt-2 text-sm text-gray-600">{COPY[state]}</p>
      <Link
        href="/billing"
        className="mt-5 inline-block rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
      >
        Plans &amp; billing
      </Link>
    </div>
  );
}
