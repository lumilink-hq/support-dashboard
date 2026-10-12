// "/solutions/retail" — the retail-locations vertical page.
//
// Same shape as /solutions/ecommerce: public, indexable, no signed-in redirect.
// Markup lives in components/marketing/retail.tsx.

import type { Metadata } from "next";
import { RETAIL_METADATA, RetailSolution } from "@/components/marketing/retail";
import { withSeoOverrides } from "@/lib/seo-overrides";

export const metadata: Metadata = withSeoOverrides("/solutions/retail", {
  ...RETAIL_METADATA,
  alternates: { canonical: "/solutions/retail" },
});

export default function RetailSolutionPage() {
  return <RetailSolution />;
}
