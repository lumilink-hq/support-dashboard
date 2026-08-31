// "/partners/ecommerce-community" — LP-4. Referral-only: noindex, not in the
// nav. Markup lives in components/marketing/partners/ecommerce-community.tsx.
//
// See the guardrail comment in that file before this link goes to anyone:
// verified, active, paid communities only — no mass beginner audiences.

import type { Metadata } from "next";
import {
  ECOMMERCE_COMMUNITY_METADATA,
  EcommerceCommunityPartner,
} from "@/components/marketing/partners/ecommerce-community";

export const metadata: Metadata = {
  ...ECOMMERCE_COMMUNITY_METADATA,
  robots: { index: false, follow: false },
  alternates: { canonical: "/partners/ecommerce-community" },
};

export default function EcommerceCommunityPartnerPage() {
  return <EcommerceCommunityPartner />;
}
