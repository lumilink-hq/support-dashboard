// Whether the signed-in tenant may see the SEO product. Unlike featureGate()
// (which is off until ENFORCE_ENTITLEMENTS=1 so existing voice tenants keep full
// access), this is ALWAYS on: SEO is a new product, no legacy tenant has it, and
// showing every client an empty SEO section is the gap this closes.
//
// Reads `entitlements` under the caller's own RLS, so a tenant only ever sees its
// own plan. This gates the UI only; the data is protected by RLS on every seo_*
// table and view regardless.

import { cache } from "react";
import { featureState, getEntitlements, isUsable, type FeatureState } from "@/lib/entitlements";

export const getSeoAccess = cache(async (): Promise<{ allowed: boolean; state: FeatureState }> => {
  const state = featureState((await getEntitlements()).seo);
  return { allowed: isUsable(state), state };
});
