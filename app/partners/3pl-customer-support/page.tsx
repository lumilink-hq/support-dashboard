// "/partners/3pl-customer-support" — LP-2. Referral-only: noindex, not in the nav.
// Markup lives in components/marketing/partners/threepl-support.tsx.

import type { Metadata } from "next";
import {
  THREEPL_SUPPORT_METADATA,
  ThreePlSupportPartner,
} from "@/components/marketing/partners/threepl-support";

export const metadata: Metadata = {
  ...THREEPL_SUPPORT_METADATA,
  robots: { index: false, follow: false },
  alternates: { canonical: "/partners/3pl-customer-support" },
};

export default function ThreePlSupportPartnerPage() {
  return <ThreePlSupportPartner />;
}
