// The product catalogue: what LumiLink sells, as one list both the dashboard
// and the marketing site read from.
//
// PRODUCTS, NOT INDUSTRIES. "Online stores" and "service businesses" are who a
// customer is (SOLUTIONS below); a product is what they buy, and it maps 1:1
// to an entitlement feature. The dashboard sidebar groups its pages by
// product, and the marketing nav's Products and Solutions menus both read
// from this file.
//
// WEBSITE CHAT IS AN ADD-ON, NOT A PRODUCT (user, 2026-09-23): it rides a
// phone plan, so it lives in lib/addons.ts and on /pricing, not here.
//
// NO PRICES HERE. They stay where billing reads them (lib/entitlements.ts,
// lib/addons.ts, lib/seo-pricing.ts); copying one in here is how a page ends
// up quoting a number Stripe doesn't charge.
//
// Client-safe: imported by the sidebar ("use client"), so type-only imports
// from lib/entitlements.ts (which pulls in the server Supabase client).

import type { Feature } from "@/lib/entitlements";

/** Entitlement features that are sold as products today. Email is paused. */
export type ProductKey = Extract<Feature, "voice" | "seo">;

export type DashboardPage = { href: string; label: string; soon?: boolean };

export type Product = {
  key: ProductKey;
  name: string;
  blurb: string;
  /** Public page that explains the product. */
  marketingHref: string;
  /** Dashboard pages this product unlocks, in sidebar order. */
  pages: DashboardPage[];
};

export const PRODUCTS: Product[] = [
  {
    key: "voice",
    name: "Phone Agent",
    blurb: "Answers every call, books jobs and captures leads, 24/7.",
    // No product page of its own; the landing page is about this product.
    // The marketing shell swaps "/" for "/home" when someone is signed in,
    // because "/" redirects them into the dashboard.
    marketingHref: "/",
    pages: [
      { href: "/conversations", label: "Conversations" },
      { href: "/appointments", label: "Appointments" },
      { href: "/leads", label: "Leads" },
      { href: "/review-queue", label: "Review Queue" },
      { href: "/services", label: "Services" },
      { href: "/knowledge-base", label: "Knowledge base", soon: true },
    ],
  },
  {
    key: "seo",
    name: "Local SEO",
    blurb: "Audits, rank tracking and approved fixes for every location.",
    marketingHref: "/products/seo",
    pages: [
      { href: "/seo", label: "Overview" },
      { href: "/seo-approvals", label: "Approvals" },
      { href: "/seo/reports", label: "Reports" },
    ],
  },
];

/**
 * Who the customer is: the industry pages under /solutions. Each pitches the
 * products that fit it. The creators landing page (/lp/creator-support) is
 * deliberately NOT here: it stays a standalone campaign page (user,
 * 2026-09-23).
 */
export const SOLUTIONS: { name: string; blurb: string; href: string }[] = [
  {
    name: "Online Stores",
    blurb: "Order lookups and product questions, answered 24/7.",
    href: "/solutions/ecommerce",
  },
  {
    name: "Service Businesses",
    blurb: "Every call answered and every job on the calendar.",
    href: "/solutions/service",
  },
];

/** Pages every workspace has, whatever it has bought. */
export const WORKSPACE_PAGES: DashboardPage[] = [
  { href: "/settings", label: "Settings" },
  { href: "/billing", label: "Plans & billing" },
];

/**
 * Where "Add <product>" sends a signed-in client whose entitlement for it
 * isn't usable. `products` is clients.products: what the workspace has SET UP,
 * which is not the same as paid for (0059).
 *
 *  - Not set up yet: /onboarding/add, which adds it to the workspace and
 *    starts its onboarding steps (SEO needs locations before a seat count
 *    means anything).
 *  - Set up but not paid: straight to its checkout. Voice checkout is the
 *    tier picker on /plans; SEO is the per-location form on /billing.
 */
export function addProductHref(key: ProductKey, products: ProductKey[]): string {
  if (!products.includes(key)) return `/onboarding/add?product=${key}`;
  return key === "voice" ? "/plans" : "/billing#seo";
}

export function productByKey(key: ProductKey): Product {
  const p = PRODUCTS.find((x) => x.key === key);
  if (!p) throw new Error(`Unknown product: ${key}`);
  return p;
}
