// "/solutions/ecommerce" — the online-store vertical page.
//
// Public and indexable. Unlike "/", it does NOT redirect a signed-in visitor to
// the dashboard: a vertical page is something you send to a prospect and open in
// front of them, and bouncing whoever is logged in on that laptop out of the
// pitch is worse than showing a customer their own marketing site.
//
// Markup lives in components/marketing/ecommerce.tsx, matching the convention
// the landing page set.

import type { Metadata } from "next";
import {
  ECOMMERCE_METADATA,
  EcommerceSolution,
} from "@/components/marketing/ecommerce";

export const metadata: Metadata = {
  ...ECOMMERCE_METADATA,
  alternates: { canonical: "/solutions/ecommerce" },
};

export default function EcommerceSolutionPage() {
  return <EcommerceSolution />;
}
