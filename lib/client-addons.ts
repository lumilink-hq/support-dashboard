// Which add-ons (lib/addons.ts) the signed-in client actually holds, from the
// client_addons table (0039). Kept separate from lib/addons.ts, which is the
// static, marketing-safe catalogue imported by client components — this file
// does a server-side, RLS-scoped read and has no business being pulled into a
// landing page bundle.

import { createClient } from "@/lib/supabase/server";

export type ClientAddonStatus = "pending" | "active" | "past_due" | "canceled";

export type ClientAddonRow = {
  addon_key: string;
  status: ClientAddonStatus;
  current_period_end: string | null;
};

// UI state for an add-on the tenant may or may not hold. Absence of a row =
// never bought. Mirrors featureState() in lib/entitlements.ts exactly — same
// status vocabulary, same states — kept as its own tiny copy rather than a
// shared import so add-ons and features stay decoupled tables.
export type ClientAddonState = "none" | "setup" | "active" | "past_due" | "canceled";

export function addonState(row: ClientAddonRow | undefined): ClientAddonState {
  if (!row) return "none";
  switch (row.status) {
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "pending":
      return "setup";
    case "canceled":
      return "canceled";
    default:
      return "none";
  }
}

// An add-on is usable (shown as active, not a buy button) when active or in
// the past_due grace period — same rule as isUsable() for features.
export function addonIsUsable(state: ClientAddonState): boolean {
  return state === "active" || state === "past_due";
}

// All of the caller's add-ons, keyed by addon_key (missing = never bought).
// RLS on client_addons scopes this to the signed-in user's own tenant.
export async function getClientAddons(): Promise<
  Record<string, ClientAddonRow>
> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("client_addons")
    .select("addon_key, status, current_period_end");
  const map: Record<string, ClientAddonRow> = {};
  for (const r of (data ?? []) as ClientAddonRow[]) map[r.addon_key] = r;
  return map;
}
