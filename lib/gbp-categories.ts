// A Business Profile's categories as the GBP sync stored them, for the
// read-only card on /seo > Settings.
//
// Until 0089 this also backed an additional-category picker (search Google's
// list, propose a change). Removed: LumiLink no longer edits categories.
//
// Tested by scripts/test-gbp-categories.ts.

export type GbpCategory = { name: string; displayName: string };

const CATEGORY_ID = /^categories\/gcid:[a-z0-9_]+$/;

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
