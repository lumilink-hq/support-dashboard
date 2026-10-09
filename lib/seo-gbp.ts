// What the portal says about Google Business Profile (module 3). Pure, so
// scripts/test-seo-gbp.ts can test it with plain tsx. The sync itself is
// supabase/functions/seo-gbp-sync; this only turns its state into words.

export type GbpSyncRow = {
  status: "pending" | "ok" | "not_connected" | "no_access" | "error";
  locations_count: number;
  last_synced_at: string | null;
  last_error: string | null;
};

export type GbpListingRow = {
  location_name: string;
  title: string | null;
  address_text: string | null;
  store_code: string | null;
  linked_location_id: string | null;
  link_source: "auto" | "manual" | null;
  average_rating: number | string | null;
  total_review_count: number | null;
  reviews_status: "pending" | "ok" | "unavailable" | "error";
  metrics_through: string | null;
  metrics_error: string | null;
  maps_uri: string | null;
  new_review_uri: string | null;
};

/** Store codes longer than this are machine ids (PACKS Hollywood's is 20 digits), not labels a person reads. */
export const STORE_CODE_MAX = 12;

/** "PACKS Fullerton (FUL), 1500 N Harbor Blvd, Fullerton, CA 92835" */
export function listingLabel(l: Pick<GbpListingRow, "title" | "store_code" | "address_text" | "location_name">): string {
  const name = l.title ?? l.location_name;
  const code = l.store_code && l.store_code.length <= STORE_CODE_MAX ? ` (${l.store_code})` : "";
  return l.address_text ? `${name}${code}, ${l.address_text}` : `${name}${code}`;
}

export type GbpState =
  | { kind: "linked"; listing: GbpListingRow }
  | { kind: "message"; text: string; action?: "connect" | "link" };

/**
 * The one thing to tell a location about its profile. `hasScope`: the Google
 * connection includes business.manage. Never pretends to have data it hasn't.
 */
export function gbpState(input: {
  hasScope: boolean;
  sync: GbpSyncRow | null;
  listings: GbpListingRow[];
  locationId: string;
}): GbpState {
  const { hasScope, sync, listings, locationId } = input;
  if (!hasScope) {
    return { kind: "message", text: "Add Google Business Profile in Settings to see views, calls, direction requests and reviews.", action: "connect" };
  }
  const mine = listings.find((l) => l.linked_location_id === locationId);
  if (mine) return { kind: "linked", listing: mine };
  if (!sync || sync.status === "pending") {
    return { kind: "message", text: "Business Profile is connected. The first sync runs within the hour and lists your profiles." };
  }
  if (sync.status === "no_access") {
    return { kind: "message", text: "Google refused access to Business Profile for the connected account. It needs to be an owner or manager of the profile." };
  }
  if (sync.status === "error") {
    return { kind: "message", text: "The last Business Profile sync failed. It retries automatically." };
  }
  if (sync.status === "not_connected") {
    return { kind: "message", text: "Add Google Business Profile in Settings to see views, calls, direction requests and reviews.", action: "connect" };
  }
  if (listings.length === 0) {
    return { kind: "message", text: "The connected Google account doesn't manage any Business Profiles. Reconnect with an account that is an owner or manager." };
  }
  return { kind: "message", text: "Choose which Business Profile is this location's in Settings.", action: "link" };
}

/** "4.6 from 312 reviews", or null when reviews haven't synced. */
export function ratingLine(l: Pick<GbpListingRow, "average_rating" | "total_review_count" | "reviews_status">): string | null {
  if (l.reviews_status !== "ok" || l.total_review_count === null) return null;
  if (l.total_review_count === 0) return "No reviews yet";
  const avg = l.average_rating === null ? null : Number(l.average_rating);
  const n = `${l.total_review_count} review${l.total_review_count === 1 ? "" : "s"}`;
  return avg !== null && Number.isFinite(avg) ? `${avg.toFixed(1)} from ${n}` : n;
}

export function reviewsNote(l: Pick<GbpListingRow, "reviews_status">): string | null {
  if (l.reviews_status === "unavailable") return "Reviews aren't available yet: the reviews API isn't enabled for LumiLink's Google project, or the profile isn't verified.";
  if (l.reviews_status === "pending") return "Reviews sync on the next run.";
  if (l.reviews_status === "error") return "The last review sync failed. It retries automatically.";
  return null;
}

export const LINK_RESULT: Record<string, { ok: boolean; text: string }> = {
  ok: { ok: true, text: "Saved. Its data syncs within the hour." },
  not_found: { ok: false, text: "That profile is no longer listed. It may have been removed from the Google account." },
  location_not_found: { ok: false, text: "That location no longer exists." },
};
