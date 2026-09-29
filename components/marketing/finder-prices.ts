// The prices the plan finder (plan-finder.tsx, a client component) quotes,
// read on the server from the same sources /billing uses. Shared by /pricing
// and the homepage so the two quizzes can't recommend different numbers.

import type { FinderPrices } from "@/components/marketing/plan-finder";
import { availableAddons } from "@/lib/addons";
import { PLAN_TIERS } from "@/lib/entitlements";
import { SEO_EXTRA_LOCATION, seoPlanByKey } from "@/lib/seo-pricing";

export function finderPrices(): FinderPrices {
  const addons = availableAddons();
  const addonPrice = (key: string) => addons.find((a) => a.key === key)?.monthlyUsd ?? null;
  return {
    phoneTiers: PLAN_TIERS.map((t) => ({
      key: t.key,
      label: t.label,
      monthlyUsd: t.monthlyUsd,
      // The advertised count, from the tier's own first highlight
      // ("About 90 calls a month (100 minutes)"), so the quiz and the plan
      // card can't disagree.
      calls: Number(/(\d+) calls/.exec(t.highlights[0])?.[1] ?? 0),
      volume: t.highlights[0],
    })),
    websiteChatUsd: addonPrice("website_chat"),
    workflowUsd: addonPrice("advanced_workflow"),
    integrationUsd: addonPrice("managed_integration"),
    seoWebsiteUsd: seoPlanByKey("website").monthlyUsd,
    seoLocalUsd: seoPlanByKey("local").monthlyUsd,
    seoBundleUsd: seoPlanByKey("bundle").monthlyUsd,
    seoExtraLocationUsd: SEO_EXTRA_LOCATION.monthlyUsd,
  };
}
