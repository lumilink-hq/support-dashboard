// "/products" — overview of every product. Public (the "/products" prefix in
// lib/route-access.ts), indexable. Markup lives in components/marketing/products.tsx.

import type { Metadata } from "next";
import { PRODUCTS_METADATA, ProductsOverview } from "@/components/marketing/products";
import { withSeoOverrides } from "@/lib/seo-overrides";

export const metadata: Metadata = withSeoOverrides("/products", {
  ...PRODUCTS_METADATA,
  alternates: { canonical: "/products" },
});

export default function ProductsPage() {
  return <ProductsOverview />;
}
