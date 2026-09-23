// "/products/seo" — the Local SEO product page.
//
// Was /solutions/seo until 2026-09-23: /solutions is for industries, /products
// for what you buy (lib/catalog.ts). next.config.ts redirects the old path.
// Public (the "/products" prefix in lib/route-access.ts), indexable, no
// signed-in redirect. Markup lives in components/marketing/seo.tsx.

import type { Metadata } from "next";
import { SEO_METADATA, SeoSolution } from "@/components/marketing/seo";

export const metadata: Metadata = {
  ...SEO_METADATA,
  alternates: { canonical: "/products/seo" },
};

export default function SeoSolutionPage() {
  return <SeoSolution />;
}
