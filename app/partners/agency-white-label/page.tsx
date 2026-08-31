// "/partners/agency-white-label" — LP-3. Referral-only: noindex, not in the nav.
// Markup lives in components/marketing/partners/agency-white-label.tsx.

import type { Metadata } from "next";
import {
  AGENCY_WHITE_LABEL_METADATA,
  AgencyWhiteLabelPartner,
} from "@/components/marketing/partners/agency-white-label";

export const metadata: Metadata = {
  ...AGENCY_WHITE_LABEL_METADATA,
  robots: { index: false, follow: false },
  alternates: { canonical: "/partners/agency-white-label" },
};

export default function AgencyWhiteLabelPartnerPage() {
  return <AgencyWhiteLabelPartner />;
}
