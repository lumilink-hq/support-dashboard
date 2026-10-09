// =============================================================================
// github-lib.ts — the pure half of the GitHub publisher (2026-10-09): what an
// approved draft becomes in a Next.js site's repository. No network, no Deno,
// so scripts/test-seo-publish-github.ts runs it under plain tsx, and the Next
// app imports GITHUB_OVERRIDE_PATHS and the overrides format from here.
//
// Built for LumiLink's own site (lumilink-hq/support-dashboard, served at
// www.lumilinkhub.com), which isn't Shopify, so until now every approved fix
// and article came back as "Do by hand" and was applied by editing code.
//
// WHAT IT WRITES
//   * An article → content/blog/<slug>.html, in the header format lib/blog.ts
//     reads, with the body exactly as drafted (seo-content's tag whitelist is
//     the blog's whitelist, so no conversion).
//   * A page title or meta description → one entry in content/seo-overrides.json
//     ({"/pricing": {"title": "...", "description": "..."}}), which the page's
//     metadata reads through lib/seo-overrides.ts (withSeoOverrides).
//   * An H1 or structured data → manual: both live in page code.
// Each write is a commit to the branch Railway deploys from, so "published"
// means committed; the site shows it a couple of minutes later.
//
// ROLLBACK refuses when the file or entry is no longer what LumiLink wrote
// (someone edited it since), the same drift rule as the Shopify adapter.
// =============================================================================

/**
 * Pages whose <title> and meta description read content/seo-overrides.json.
 * scripts/test-seo-overrides.ts checks every one of these page files calls
 * withSeoOverrides, so an override is never written to a page that ignores it.
 */
export const GITHUB_OVERRIDE_PATHS = [
  "/",
  "/pricing",
  "/products/seo",
  "/solutions/service",
  "/solutions/ecommerce",
  "/story",
  "/contact",
  "/legal/privacy",
  "/legal/terms",
  "/blog",
] as const;

/** Blog posts (/blog/<slug>) read overrides too, through their generateMetadata. */
export function overridablePath(path: string): boolean {
  return (GITHUB_OVERRIDE_PATHS as readonly string[]).includes(path) || /^\/blog\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path);
}

export const OVERRIDES_FILE = "content/seo-overrides.json";
export const BLOG_DIR = "content/blog";

export type OverrideKey = "title" | "description";
export type Overrides = Record<string, Partial<Record<OverrideKey, string>>>;

export type GithubDecision =
  | { mode: "api"; path: string; key: OverrideKey }
  | { mode: "manual"; reason: GithubManualReason };

export type GithubManualReason = "no_site_connection" | "connection_revoked" | "code_change" | "page_not_overridable" | "url_not_on_site" | "field_not_supported";

export const GITHUB_WHY: Record<GithubManualReason, string> = {
  no_site_connection: "This site isn't connected to LumiLink for publishing yet.",
  connection_revoked: "LumiLink's access to the site's GitHub repository was revoked or has expired.",
  code_change: "This lives in the page's code, so it needs a developer.",
  page_not_overridable: "This page doesn't read LumiLink's title and description overrides yet, so it needs a code change.",
  url_not_on_site: "This address isn't on the website LumiLink publishes to.",
  field_not_supported: "LumiLink can't apply this kind of change automatically yet.",
};

/** The site's own path for a URL on it ("/pricing"), or null when it's elsewhere. */
export function pathOnSite(url: string, siteHosts: string[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
  if (!siteHosts.map(strip).includes(strip(u.host))) return null;
  const p = u.pathname.replace(/\/+$/, "");
  return p || "/";
}

export function decideGithub(
  action: { target_field: string | null; target_url: string | null },
  conn: { status: string; site_hosts: string[] } | null,
): GithubDecision {
  const field = action.target_field ?? "";
  if (field === "h1" || field === "local_business_schema") return { mode: "manual", reason: "code_change" };
  const key: OverrideKey | null = field === "title_tag" ? "title" : field === "meta_description" ? "description" : null;
  if (!key) return { mode: "manual", reason: "field_not_supported" };
  if (!conn) return { mode: "manual", reason: "no_site_connection" };
  if (conn.status === "revoked") return { mode: "manual", reason: "connection_revoked" };
  const path = action.target_url ? pathOnSite(action.target_url, conn.site_hosts) : null;
  if (!path) return { mode: "manual", reason: "url_not_on_site" };
  if (!overridablePath(path)) return { mode: "manual", reason: "page_not_overridable" };
  return { mode: "api", path, key };
}

// -----------------------------------------------------------------------------
// content/seo-overrides.json
// -----------------------------------------------------------------------------

/** Lenient read: anything that isn't an object of string fields is dropped. */
export function parseOverrides(text: string | null): Overrides {
  if (!text) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Overrides = {};
  for (const [path, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!path.startsWith("/") || !v || typeof v !== "object") continue;
    const entry: Partial<Record<OverrideKey, string>> = {};
    for (const k of ["title", "description"] as const) {
      const s = (v as Record<string, unknown>)[k];
      if (typeof s === "string" && s.trim()) entry[k] = s;
    }
    if (Object.keys(entry).length) out[path] = entry;
  }
  return out;
}

/** Stable output (sorted paths, two-space indent, trailing newline) so commits diff cleanly. */
export function serializeOverrides(o: Overrides): string {
  const sorted: Overrides = {};
  for (const path of Object.keys(o).sort()) {
    const e = o[path];
    const entry: Partial<Record<OverrideKey, string>> = {};
    if (e.title) entry.title = e.title;
    if (e.description) entry.description = e.description;
    if (Object.keys(entry).length) sorted[path] = entry;
  }
  return JSON.stringify(sorted, null, 2) + "\n";
}

/** Set one value; returns the new map and what was there before (null = nothing). */
export function setOverride(o: Overrides, path: string, key: OverrideKey, value: string): { next: Overrides; prior: string | null } {
  const prior = o[path]?.[key] ?? null;
  return { next: { ...o, [path]: { ...(o[path] ?? {}), [key]: value } }, prior };
}

/**
 * Undo a write: put `prior` back (or remove the key). "drift" when the stored
 * value is no longer what LumiLink wrote, so a person's later edit is kept.
 */
export function revertOverride(o: Overrides, path: string, key: OverrideKey, written: string, prior: string | null): { next: Overrides } | "drift" {
  const current = o[path]?.[key] ?? null;
  if (current !== written) return "drift";
  const entry = { ...(o[path] ?? {}) };
  if (prior === null) delete entry[key];
  else entry[key] = prior;
  const next = { ...o };
  if (Object.keys(entry).length) next[path] = entry;
  else delete next[path];
  return { next };
}

// -----------------------------------------------------------------------------
// content/blog/<slug>.html
// -----------------------------------------------------------------------------

/** One header line's value: a single line, trimmed. */
const line = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();

export function articleFile(a: {
  title: string;
  meta_description: string;
  body_html: string;
  date: string; // YYYY-MM-DD
  image?: { url: string; alt: string } | null;
}): string {
  const header = [`title: ${line(a.title)}`, `description: ${line(a.meta_description)}`, `date: ${a.date}`];
  if (a.image && /^https:\/\//.test(a.image.url) && a.image.alt.trim()) {
    header.push(`image: ${line(a.image.url)}`, `imageAlt: ${line(a.image.alt)}`);
  }
  return `---\n${header.join("\n")}\n---\n${a.body_html.trim()}\n`;
}

/** First free slug: "how-to-x", then "how-to-x-2", ... */
export function freeSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) {
    const s = `${base}-${i}`.slice(0, 64).replace(/-+$/, "");
    if (!taken(s)) return s;
  }
  return `${base}-${Date.now()}`;
}

export function blogPath(slug: string): string {
  return `${BLOG_DIR}/${slug}.html`;
}

export function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Manual steps for a GitHub site: there's no admin to click through. */
export function githubManualInstructions(
  action: { target_field: string | null; target_url: string | null; proposed: string },
  reason: GithubManualReason,
) {
  const field = action.target_field ?? "";
  const label =
    field === "h1" ? "Main heading (H1)" : field === "local_business_schema" ? "Structured data block" : field === "title_tag" ? "Page title" : "Meta description";
  return {
    reason,
    why: GITHUB_WHY[reason],
    steps: [
      `Change the ${label.toLowerCase()} of ${action.target_url ?? "the page"} in the site's code to the text below.`,
      "Commit and push to the branch the site deploys from; it's live a couple of minutes later.",
    ],
    copy: { label, text: field === "local_business_schema" ? `<script type="application/ld+json">\n${action.proposed}\n</script>` : action.proposed },
  };
}
