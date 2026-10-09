// The additional-category picker on /seo > Settings (module 4 part 2, 0081).
//
// Search goes straight to Google's own category list (Business Information API
// categories.list) with the signed-in client's own Google token
// (get_my_google_access_token, 0047: self-scoped, never the refresh token).
// Google's filter matches the START of a category name ("cannabis" finds
// "Cannabis store", "store" doesn't), so the form says so.
//
// The pure parts (parseCategories, currentCategories, encodePick/decodePick)
// are tested by scripts/test-gbp-categories.ts.

export type GbpCategory = { name: string; displayName: string };

const CATEGORY_ID = /^categories\/gcid:[a-z0-9_]+$/;

export const MAX_ADDITIONAL = 9;

export function parseCategories(payload: unknown): GbpCategory[] {
  const list = (payload as { categories?: unknown[] })?.categories ?? [];
  const out: GbpCategory[] = [];
  for (const c of list as { name?: unknown; displayName?: unknown }[]) {
    if (typeof c?.name === "string" && CATEGORY_ID.test(c.name) && typeof c.displayName === "string" && c.displayName.trim()) {
      out.push({ name: c.name, displayName: c.displayName.trim() });
    }
  }
  return out;
}

/** The profile's categories as the GBP sync stored them (seo_gbp_locations.profile->categories). */
export function currentCategories(categories: unknown): { primary: GbpCategory | null; additional: GbpCategory[] } {
  const c = (categories ?? {}) as { primaryCategory?: unknown; additionalCategories?: unknown[] };
  const primary = parseCategories({ categories: c.primaryCategory ? [c.primaryCategory] : [] })[0] ?? null;
  return { primary, additional: parseCategories({ categories: c.additionalCategories ?? [] }) };
}

/** A checkbox value: id and label together, so the action needs no second lookup. */
export function encodePick(c: GbpCategory): string {
  return `${c.name}|${c.displayName}`;
}

export function decodePick(v: string): GbpCategory | null {
  const i = v.indexOf("|");
  if (i < 0) return null;
  const name = v.slice(0, i);
  const displayName = v.slice(i + 1).trim().slice(0, 100);
  return CATEGORY_ID.test(name) && displayName ? { name, displayName } : null;
}

/** Search query as typed, trimmed; null when there's nothing to search. */
export function cleanQuery(q: string | null | undefined): string | null {
  const s = String(q ?? "").replace(/[^\p{L}\p{N}\s&'-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return s.length >= 2 ? s : null;
}

/** Server only: one page of Google's category list starting with `query`. */
export async function searchCategories(token: string, query: string, regionCode: string): Promise<{ ok: true; categories: GbpCategory[] } | { ok: false; error: string }> {
  const params = new URLSearchParams({
    regionCode: /^[A-Z]{2}$/.test(regionCode) ? regionCode : "US",
    languageCode: "en",
    view: "BASIC",
    pageSize: "30",
    filter: `displayName=${query}`,
  });
  try {
    // GBP_INFO_API_BASE: local testing only, pointing at a mock Google.
    const base = (process.env.GBP_INFO_API_BASE || "https://mybusinessbusinessinformation.googleapis.com").replace(/\/+$/, "");
    const res = await fetch(`${base}/v1/categories?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, error: res.status === 401 ? "Google sign-in has expired; it refreshes every 15 minutes." : `Google answered ${res.status}.` };
    return { ok: true, categories: parseCategories(await res.json()) };
  } catch {
    return { ok: false, error: "Couldn't reach Google." };
  }
}
