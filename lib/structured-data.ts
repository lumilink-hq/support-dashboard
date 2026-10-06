// Schema.org JSON-LD for the marketing pages, rendered by components/json-ld.tsx.
//
// Only facts the pages already show: no ratings, reviews, phone number or
// social profiles. Google treats markup that disagrees with the visible page as
// spam, so prices come from SEO_PLANS, the same source the plan cards use.
// Add `sameAs` to the organization once LumiLink has public profiles (LinkedIn,
// G2, etc.).
//
// Check changes with https://validator.schema.org/ and
// https://search.google.com/test/rich-results.

import { SEO_EXTRA_LOCATION, SEO_PLANS } from "@/lib/seo-pricing";
import { siteOrigin } from "@/lib/site-pages";

const ORG_DESCRIPTION =
  "AI automation for service businesses and online stores: an agent that answers every call and website visitor, plus SEO and AI search visibility.";

function orgId(origin: string) {
  return `${origin}/#organization`;
}

/** Homepage: who we are, and the site itself. */
export function homeJsonLd() {
  const origin = siteOrigin();
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": orgId(origin),
        name: "LumiLink",
        url: origin,
        // app/icon.png, served at /icon.png. Square, 512px: Google wants a
        // logo at least 112px on each side.
        logo: `${origin}/icon.png`,
        description: ORG_DESCRIPTION,
      },
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        name: "LumiLink",
        url: origin,
        publisher: { "@id": orgId(origin) },
      },
    ],
  };
}

function monthly(price: number, unitText: string) {
  return {
    "@type": "UnitPriceSpecification",
    price,
    priceCurrency: "USD",
    unitText,
    billingDuration: "P1M",
  };
}

/** /products/seo: the service and one offer per plan. */
export function seoServiceJsonLd() {
  const origin = siteOrigin();
  const url = `${origin}/products/seo`;
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    "@id": `${url}#service`,
    name: "SEO + AI Search",
    serviceType: "Search engine optimization",
    description:
      "Get found on Google, in the local map pack and in AI answers from ChatGPT and Google AI Overviews. Weekly audits, rank tracking, AI search visibility, and fixes you approve before anything goes live.",
    url,
    provider: { "@id": orgId(origin) },
    areaServed: { "@type": "Country", name: "United States" },
    offers: SEO_PLANS.map((plan) => ({
      "@type": "Offer",
      name: plan.name,
      url: `${origin}/pricing#seo`,
      priceCurrency: "USD",
      price: plan.monthlyUsd,
      priceSpecification: plan.perLocation
        ? monthly(plan.monthlyUsd, "per location per month")
        : plan.key === "bundle"
          ? [
              monthly(plan.monthlyUsd, "per month, includes one location"),
              monthly(SEO_EXTRA_LOCATION.monthlyUsd, "per extra location per month"),
            ]
          : monthly(plan.monthlyUsd, "per month"),
    })),
  };
}

/**
 * JSON.stringify does not escape "<", so a "</script>" inside any string would
 * end the tag early. Next's JSON-LD guide recommends this replacement.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
