// "/lp/creator-support" — direct pitch to creators/course sellers/coaches.
// Noindex, unlinked from the nav: not one of the two verticals currently
// featured on the homepage, reached instead by a link sent directly to a
// targeted contact. Markup lives in components/marketing/creator-support.tsx.

import type { Metadata } from "next";
import {
  CREATOR_SUPPORT_METADATA,
  CreatorSupportSolution,
} from "@/components/marketing/creator-support";

export const metadata: Metadata = {
  ...CREATOR_SUPPORT_METADATA,
  robots: { index: false, follow: false },
  alternates: { canonical: "/lp/creator-support" },
};

export default function CreatorSupportPage() {
  return <CreatorSupportSolution />;
}
