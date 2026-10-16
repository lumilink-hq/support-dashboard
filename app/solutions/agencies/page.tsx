// "/solutions/agencies" — agencies and resellers.
//
// Same shape as the industry pages: public, indexable, no signed-in redirect.
// Markup lives in components/marketing/agencies.tsx.

import type { Metadata } from "next";
import { AGENCIES_METADATA, AgenciesSolution } from "@/components/marketing/agencies";
import { withSeoOverrides } from "@/lib/seo-overrides";

export const metadata: Metadata = withSeoOverrides("/solutions/agencies", {
  ...AGENCIES_METADATA,
  alternates: { canonical: "/solutions/agencies" },
});

export default function AgenciesSolutionPage() {
  return <AgenciesSolution />;
}
