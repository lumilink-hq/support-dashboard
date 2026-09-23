// =============================================================================
// /onboarding/add?product=… — add a product to an existing workspace.
//
// Where the dashboard sidebar's "Add <product>" row and a signed-in visitor's
// CTA on /products/seo land (addProductHref, lib/catalog.ts). Before this
// existed (2026-09-23) a phone client couldn't set up Local SEO at all:
// locations were only asked during an SEO signup's onboarding.
//
// One confirmation, not a wizard: say what the product is and costs and what
// happens next, then addProduct (actions.ts) writes clients.products and hands
// over to the product's own steps or checkout.
// =============================================================================

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentClientId, STARTER_PLAN } from "@/lib/entitlements";
import { productByKey, type ProductKey } from "@/lib/catalog";
import { readProfile } from "@/lib/onboarding";
import { SEO_PRICE_PER_LOCATION_USD } from "@/lib/seo-pricing";
import { addProduct } from "../actions";

export const metadata: Metadata = { title: "Add a product | LumiLink" };

const DETAILS: Record<ProductKey, { price: string; next: string[] }> = {
  voice: {
    price: `Plans from $${STARTER_PLAN.monthlyUsd} a month.`,
    next: [
      "Pick a plan.",
      "Tell us your hours, services and prices, and how Lumi should sound.",
      "We set up your phone number and Lumi starts answering.",
    ],
  },
  seo: {
    price: `$${SEO_PRICE_PER_LOCATION_USD.toLocaleString("en-US")} per location per month.`,
    next: [
      "Add the locations you want ranked, a few keywords, and competitors.",
      "Choose how many locations to pay for on Plans & billing.",
      "We run the first audit and rank check, and your reports start.",
    ],
  },
};

export default async function AddProductPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string; error?: string }>;
}) {
  const { product: raw, error } = await searchParams;
  if (raw !== "voice" && raw !== "seo") redirect("/onboarding");
  const key = raw as ProductKey;

  const clientId = await getCurrentClientId();
  if (!clientId) {
    redirect(`/login?next=${encodeURIComponent(`/onboarding/add?product=${key}`)}`);
  }

  const supabase = await createClient();
  const { data: client } = await supabase
    .from("clients")
    .select("name, business_type, products")
    .eq("id", clientId)
    .maybeSingle();
  const profile = readProfile(client);

  // Already set up: resume its steps (or its checkout) rather than asking again.
  if (profile.products.includes(key)) {
    redirect(key === "seo" ? "/onboarding?step=seo_locations" : "/plans");
  }

  const product = productByKey(key);
  const details = DETAILS[key];
  const needsIndustry = key === "voice" && !profile.industry;
  const backHref = profile.products.includes("voice") ? "/conversations" : "/settings";

  return (
    <main className="min-h-full bg-gray-50 py-10">
      <div className="mx-auto max-w-lg px-6">
        <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Add to {client?.name ?? "your workspace"}
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-gray-900">
            {product.name}
          </h1>
          <p className="mt-2 text-sm text-gray-600">{product.blurb}</p>
          <p className="mt-2 text-sm font-medium text-gray-900">{details.price}</p>
          <Link
            href={product.marketingHref === "/" ? "/home" : product.marketingHref}
            className="mt-1 inline-block text-sm text-gray-500 underline underline-offset-4 hover:text-gray-900"
          >
            What&rsquo;s included
          </Link>

          <h2 className="mt-6 text-sm font-semibold text-gray-900">What happens next</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-gray-600">
            {details.next.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>

          <form action={addProduct} className="mt-6">
            <input type="hidden" name="product" value={key} />

            {needsIndustry ? (
              // The phone agent's mode (scheduling or orders) comes from the
              // industry, and this workspace was never asked (0059).
              <fieldset className="mb-5">
                <legend className="text-sm font-medium text-gray-700">
                  What does your business do?
                </legend>
                {error === "industry" ? (
                  <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                    Choose one so Lumi knows what callers will ask for.
                  </p>
                ) : null}
                <div className="mt-2 space-y-2">
                  {[
                    {
                      value: "service",
                      title: "We book appointments",
                      body: "Callers want to book a job or get a price.",
                    },
                    {
                      value: "ecommerce",
                      title: "We sell online",
                      body: "Callers ask where their order is, or about a product.",
                    },
                  ].map((o) => (
                    <label
                      key={o.value}
                      className="flex cursor-pointer gap-3 rounded-md border border-gray-300 p-3 hover:bg-gray-50 has-[:checked]:border-gray-900 has-[:checked]:bg-gray-50"
                    >
                      <input type="radio" name="business_type" value={o.value} className="mt-0.5" />
                      <span>
                        <span className="block text-sm font-medium text-gray-900">{o.title}</span>
                        <span className="block text-xs text-gray-500">{o.body}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
              >
                Add {product.name}
              </button>
              <Link href={backHref} className="text-sm text-gray-500 underline hover:text-gray-900">
                Not now
              </Link>
            </div>
            <p className="mt-3 text-xs text-gray-400">
              Nothing is charged until you check out.
            </p>
          </form>
        </div>
      </div>
    </main>
  );
}
