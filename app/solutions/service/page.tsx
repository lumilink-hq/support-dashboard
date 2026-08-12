// "/solutions/service" — the trades / HVAC vertical page.
//
// Same shape as /solutions/ecommerce: public, indexable, no signed-in redirect.
// Markup lives in components/marketing/service.tsx.

import type { Metadata } from "next";
import { SERVICE_METADATA, ServiceSolution } from "@/components/marketing/service";

export const metadata: Metadata = {
  ...SERVICE_METADATA,
  alternates: { canonical: "/solutions/service" },
};

export default function ServiceSolutionPage() {
  return <ServiceSolution />;
}
