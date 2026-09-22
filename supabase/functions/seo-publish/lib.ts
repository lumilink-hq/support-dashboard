// =============================================================================
// seo-publish/lib.ts — module 5 (plan.md): the pure half of the website
// adapter. No network, no database, no Deno APIs, so scripts/test-seo-publish.ts
// runs it under plain tsx.
//
// WHAT SHOPIFY'S ADMIN API CAN AND CAN'T DO HERE (checked against shopify.dev,
// 2026-09-21; see plan.md module 5):
//   * Title tag and meta description are metafields (namespace "global", keys
//     "title_tag" / "description_tag") on pages, products, collections and
//     articles. THIS is the automated path.
//   * The HOMEPAGE title and description live in Online Store > Preferences and
//     have no mutation. Manual.
//   * Theme files (where JSON-LD and a template's H1 live) need write_themes AND
//     an exemption Shopify grants case by case. Manual.
//   * An H1 on a page/product/collection is normally the resource's own title,
//     which is also its navigation label and catalog name, so changing it to fix
//     an SEO finding has side effects. Manual, on purpose.
// Everything that isn't automated becomes step-by-step instructions a
// non-developer can follow (plan.md's "export-only fallback"), never a silent
// drop.
// =============================================================================

export type ResourceKind = "home" | "page" | "product" | "collection" | "article" | "other";

export type UrlClass = {
  kind: ResourceKind;
  handle: string | null;
  blogHandle: string | null;
};

// A Shopify handle is lowercase letters, digits, hyphens; be a little wider
// (underscores, dots, percent-encoding) but never anything that could alter a
// search query string.
const SAFE_HANDLE = /^[a-z0-9][a-z0-9._%-]*$/i;
const ROOTS = new Set(["pages", "products", "collections", "blogs"]);

/** null when the URL can't be parsed at all. */
export function classifyUrl(url: string): UrlClass | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  let segs = path.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });

  // Shopify Markets adds a locale prefix (/en-ca/products/x). Strip it only when
  // what follows is a known root, so a page literally called "fr" isn't eaten.
  if (segs.length > 1 && /^[a-z]{2}(-[a-z0-9]{2,4})?$/i.test(segs[0]) && ROOTS.has(segs[1])) {
    segs = segs.slice(1);
  }

  const other: UrlClass = { kind: "other", handle: null, blogHandle: null };
  if (segs.length === 0) return { kind: "home", handle: null, blogHandle: null };

  const handleOf = (s: string | undefined) => (s && SAFE_HANDLE.test(s) ? s : null);

  switch (segs[0]) {
    case "pages":
      return segs.length === 2 && handleOf(segs[1])
        ? { kind: "page", handle: segs[1], blogHandle: null }
        : other;
    case "products":
      return segs.length === 2 && handleOf(segs[1])
        ? { kind: "product", handle: segs[1], blogHandle: null }
        : other;
    case "collections":
      // /collections/c/products/p is the product p seen through collection c.
      if (segs.length === 4 && segs[2] === "products" && handleOf(segs[3])) {
        return { kind: "product", handle: segs[3], blogHandle: null };
      }
      return segs.length === 2 && handleOf(segs[1])
        ? { kind: "collection", handle: segs[1], blogHandle: null }
        : other;
    case "blogs":
      return segs.length === 3 && handleOf(segs[1]) && handleOf(segs[2])
        ? { kind: "article", handle: segs[2], blogHandle: segs[1] }
        : other;
    default:
      return other;
  }
}

// -----------------------------------------------------------------------------
// Capabilities
// -----------------------------------------------------------------------------

export type SeoMetafieldKey = "title_tag" | "description_tag";

const METAFIELD_FOR: Record<string, SeoMetafieldKey> = {
  title_tag: "title_tag",
  meta_description: "description_tag",
};

const API_KINDS: ReadonlySet<ResourceKind> = new Set(["page", "product", "collection", "article"]);

/** Any one of each inner array satisfies that kind (Shopify accepts either
 * write_content or write_online_store_pages for pages). write_X implies read_X. */
const SCOPES_FOR: Record<string, string[]> = {
  product: ["write_products"],
  collection: ["write_products"],
  page: ["write_content", "write_online_store_pages"],
  article: ["write_content"],
};

export function scopeSatisfied(granted: string[], kind: ResourceKind): boolean {
  const need = SCOPES_FOR[kind];
  return !need || need.some((s) => granted.includes(s));
}

/** What the connection needs to be "healthy": every kind the adapter writes. */
export function connectionStatusFromScopes(granted: string[]): "healthy" | "degraded" {
  const ok = (["product", "page", "article"] as const).every((k) => scopeSatisfied(granted, k));
  return ok ? "healthy" : "degraded";
}

export function missingScopes(granted: string[]): string[] {
  const out: string[] = [];
  if (!granted.includes("write_products")) out.push("write_products");
  if (!granted.includes("write_content") && !granted.includes("write_online_store_pages")) {
    out.push("write_content");
  }
  return out;
}

// -----------------------------------------------------------------------------
// The routing decision
// -----------------------------------------------------------------------------

export type ConnectionFacts = {
  status: string;
  granted_scopes: string[];
  shop_domain: string;
  primary_domain: string | null;
};

export type Decision =
  | { mode: "api"; kind: ResourceKind; handle: string; blogHandle: string | null; key: SeoMetafieldKey }
  | { mode: "manual"; reason: ManualReason; detail?: string };

export type ManualReason =
  | "no_site_connection"
  | "connection_revoked"
  | "unrecognised_url"
  | "homepage_has_no_api"
  | "theme_write_needs_shopify_exemption"
  | "h1_comes_from_the_theme"
  | "field_not_supported"
  | "url_not_on_connected_store"
  | "missing_scope"
  | "resource_not_found"
  | "resource_lookup_failed";

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Does the URL belong to the connected store? Writing by handle into the wrong
 * store would change someone else's page of the same name. */
export function urlOnStore(url: string, c: Pick<ConnectionFacts, "shop_domain" | "primary_domain">): boolean {
  const host = hostOf(url);
  if (!host) return false;
  const stripWww = (h: string) => h.replace(/^www\./, "");
  const ours = [c.shop_domain, c.primary_domain].filter(Boolean).map((d) => stripWww(String(d).toLowerCase()));
  return ours.includes(stripWww(host));
}

export function decide(
  action: { target_field: string | null; target_url: string | null },
  conn: ConnectionFacts | null,
): Decision {
  const field = action.target_field ?? "";

  // These never go through the API, connection or not, so say why precisely.
  if (field === "local_business_schema") return { mode: "manual", reason: "theme_write_needs_shopify_exemption" };
  if (field === "h1") return { mode: "manual", reason: "h1_comes_from_the_theme" };
  if (!(field in METAFIELD_FOR)) return { mode: "manual", reason: "field_not_supported" };

  if (!conn) return { mode: "manual", reason: "no_site_connection" };
  if (conn.status === "revoked") return { mode: "manual", reason: "connection_revoked" };
  if (!action.target_url) return { mode: "manual", reason: "unrecognised_url" };

  const cls = classifyUrl(action.target_url);
  if (!cls) return { mode: "manual", reason: "unrecognised_url" };
  if (cls.kind === "home") return { mode: "manual", reason: "homepage_has_no_api" };
  if (!API_KINDS.has(cls.kind) || !cls.handle) return { mode: "manual", reason: "unrecognised_url" };
  if (!urlOnStore(action.target_url, conn)) return { mode: "manual", reason: "url_not_on_connected_store" };

  // An empty scope list means "never checked", not "no scopes": try the call and
  // let Shopify answer, rather than refuse on a heartbeat that hasn't run yet.
  if (conn.granted_scopes.length > 0 && !scopeSatisfied(conn.granted_scopes, cls.kind)) {
    return { mode: "manual", reason: "missing_scope", detail: SCOPES_FOR[cls.kind]?.join(" or ") };
  }

  return { mode: "api", kind: cls.kind, handle: cls.handle, blogHandle: cls.blogHandle, key: METAFIELD_FOR[field] };
}

// -----------------------------------------------------------------------------
// Manual instructions (the export-only fallback)
// -----------------------------------------------------------------------------

export type ManualInstructions = {
  reason: ManualReason;
  /** One line on why LumiLink didn't apply it itself. */
  why: string;
  steps: string[];
  /** The exact text to paste. */
  copy: { label: string; text: string };
  /** More things to paste or fetch (an article has a meta description and an image). */
  extra?: { label: string; text: string }[];
};

const WHY: Record<ManualReason, string> = {
  no_site_connection: "This site isn't connected to LumiLink for publishing yet.",
  connection_revoked: "LumiLink's access to your Shopify store was revoked or has expired.",
  unrecognised_url: "LumiLink couldn't tell which Shopify page this address is.",
  homepage_has_no_api: "Shopify doesn't let apps change the homepage title and description.",
  theme_write_needs_shopify_exemption: "Shopify only lets an app edit theme code with a special exemption, so this one is a copy-and-paste.",
  h1_comes_from_the_theme: "The main heading comes from your theme and page title, so changing it has side effects we'd rather you confirm.",
  field_not_supported: "LumiLink can't apply this kind of change automatically yet.",
  url_not_on_connected_store: "This address isn't on the store LumiLink is connected to.",
  missing_scope: "LumiLink's Shopify access doesn't include permission to edit this kind of page.",
  resource_not_found: "LumiLink couldn't find this page in your Shopify store.",
  resource_lookup_failed: "LumiLink couldn't look this page up in your Shopify store.",
};

const SEARCH_LISTING_STEPS = (fieldLabel: string) => [
  "In Shopify admin, open the page, product, collection or blog post this address points to.",
  "Scroll to “Search engine listing” and choose “Edit”.",
  `Paste the text below into “${fieldLabel}”, then save.`,
];

export function manualInstructions(
  action: { target_field: string | null; target_url: string | null; proposed: string },
  reason: ManualReason,
  detail?: string,
): ManualInstructions {
  const field = action.target_field ?? "";
  const cls = action.target_url ? classifyUrl(action.target_url) : null;
  const why = WHY[reason] + (detail ? ` (needs ${detail})` : "");

  if (field === "local_business_schema") {
    return {
      reason,
      why,
      steps: [
        "This adds structured data that helps Google show your business details. It is a theme change, so if you have a developer, hand them this.",
        "In Shopify admin go to Online Store > Themes, then next to your live theme choose ⋯ > Edit code.",
        "Open layout/theme.liquid.",
        "Find the closing </head> tag and paste the block below on the line just above it. Save.",
        "Don't remove any other structured data (script tags of type application/ld+json) that's already there without checking with us.",
      ],
      copy: { label: "Structured data block", text: `<script type="application/ld+json">\n${action.proposed}\n</script>` },
    };
  }

  if (field === "h1") {
    const editTitle = cls && ["page", "product", "collection", "article"].includes(cls.kind);
    return {
      reason,
      why,
      steps: editTitle
        ? [
            "In Shopify admin, open the page, product, collection or blog post this address points to.",
            "Most themes use its title as the main heading. Change the title to the text below and save.",
            "Note the title also appears in your menus and, for products, your catalog, so check those still read well.",
          ]
        : [
            "In Shopify admin go to Online Store > Themes > Customize and open the page this address points to.",
            "Find the main heading section, set its text to the text below, and save.",
          ],
      copy: { label: "Main heading (H1)", text: action.proposed },
    };
  }

  const label = field === "title_tag" ? "Page title" : "Meta description";
  if (cls?.kind === "home") {
    return {
      reason,
      why,
      steps: [
        "In Shopify admin go to Online Store > Preferences.",
        `Under “Title and meta description”, paste the text below into “${label === "Page title" ? "Homepage title" : "Homepage meta description"}” and save.`,
      ],
      copy: { label, text: action.proposed },
    };
  }

  return {
    reason,
    why,
    steps: SEARCH_LISTING_STEPS(label),
    copy: { label, text: action.proposed },
  };
}

// -----------------------------------------------------------------------------
// Small pure helpers used by the function and its tests
// -----------------------------------------------------------------------------

/** publish_result is written BEFORE the store is touched; see 0055's header. */
export type PriorState = { id: string | null; value: string | null; recorded_at: string };

export function priorFromPublishResult(pr: unknown): PriorState | null {
  const p = (pr as { previous_override?: PriorState } | null)?.previous_override;
  if (!p || typeof p !== "object" || !("value" in p)) return null;
  return p;
}

// -----------------------------------------------------------------------------
// Articles (module 16 -> module 5). An article is not a field on an existing
// page: the adapter creates a blog post and, on rollback, deletes it.
// -----------------------------------------------------------------------------

/** URL handle for a new article. Deterministic from the title, so a retry after a
 * crash can find the article it already created (see shopify.ts publishArticle)
 * instead of publishing a second copy. */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 60).replace(/-+$/g, "") || "article";
}

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };

/** Body reduced to its words, so "did someone edit this article?" compares what
 * a reader sees rather than how Shopify happened to re-serialise the markup. */
export function wordsOf(html: string): string[] {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENT[m] ?? m)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function bodyMatches(a: string, b: string): boolean {
  const x = wordsOf(a), y = wordsOf(b);
  return x.length === y.length && x.every((w, i) => w === y[i]);
}

export type ArticleProposal = {
  title: string;
  meta_description: string;
  body_html: string;
  keyword?: string;
  image: { url: string; alt: string } | null;
};

export function articleFromProposal(pv: unknown): ArticleProposal | null {
  const p = pv as Partial<ArticleProposal> | null;
  if (!p || typeof p.title !== "string" || typeof p.body_html !== "string" || typeof p.meta_description !== "string") return null;
  const img = p.image && typeof p.image.url === "string" && typeof p.image.alt === "string" ? { url: p.image.url, alt: p.image.alt } : null;
  return { title: p.title, meta_description: p.meta_description, body_html: p.body_html, keyword: p.keyword, image: img };
}

/** The same routing question as decide(), for an article: is there a working,
 * write-scoped connection to publish through? */
export function decideArticle(conn: ConnectionFacts | null): { mode: "api" } | { mode: "manual"; reason: ManualReason; detail?: string } {
  if (!conn) return { mode: "manual", reason: "no_site_connection" };
  if (conn.status === "revoked") return { mode: "manual", reason: "connection_revoked" };
  if (conn.granted_scopes.length > 0 && !scopeSatisfied(conn.granted_scopes, "article")) {
    return { mode: "manual", reason: "missing_scope", detail: "write_content" };
  }
  return { mode: "api" };
}

export function articleManualInstructions(p: ArticleProposal, reason: ManualReason, detail?: string): ManualInstructions {
  const why = WHY[reason] + (detail ? ` (needs ${detail})` : "");
  const steps = [
    "In Shopify admin go to Online Store > Blog posts and choose “Create blog post”.",
    `Set the title to: ${p.title}`,
    "In the content box, switch to the code view (the “<>” button) and paste the article body below.",
    p.image
      ? `Under Featured image, upload the image from the link below and set its alt text to: ${p.image.alt}`
      : "This article has no image; add one of your own if you like.",
    "Under “Search engine listing”, choose Edit and paste the meta description below.",
    "Choose the blog you want it in, then Save (or Publish).",
  ];
  const extra = [{ label: "Meta description", text: p.meta_description }];
  if (p.image) extra.push({ label: "Image (right-click and save, then upload)", text: p.image.url });
  return { reason, why, steps, copy: { label: "Article body (HTML)", text: p.body_html }, extra };
}
