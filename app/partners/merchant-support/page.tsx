// "/partners/merchant-support" — LP-1. Referral-only: noindex, not in the nav.
// Markup lives in components/marketing/partners/merchant-support.tsx.

import type { Metadata } from "next";
import {
  MERCHANT_SUPPORT_METADATA,
  MerchantSupportPartner,
} from "@/components/marketing/partners/merchant-support";

export const metadata: Metadata = {
  ...MERCHANT_SUPPORT_METADATA,
  robots: { index: false, follow: false },
  alternates: { canonical: "/partners/merchant-support" },
};

export default function MerchantSupportPartnerPage() {
  return <MerchantSupportPartner />;
}
