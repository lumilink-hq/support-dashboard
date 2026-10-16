// "/products/phone-agent" — the AI Phone Agent product page (2026-10-16).
//
// Public (the "/products" prefix in lib/route-access.ts), indexable, no
// signed-in redirect. Markup lives in components/marketing/phone-agent.tsx.

import type { Metadata } from "next";
import { PHONE_AGENT_METADATA, PhoneAgentProduct } from "@/components/marketing/phone-agent";
import { withSeoOverrides } from "@/lib/seo-overrides";

export const metadata: Metadata = withSeoOverrides("/products/phone-agent", {
  ...PHONE_AGENT_METADATA,
  alternates: { canonical: "/products/phone-agent" },
});

export default function PhoneAgentPage() {
  return <PhoneAgentProduct />;
}
