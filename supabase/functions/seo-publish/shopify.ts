// =============================================================================
// seo-publish/shopify.ts — module 5 (plan.md): the Shopify Admin GraphQL side
// of the adapter. `fetch` and `sleep` are injected, so scripts/test-seo-publish.ts
// drives all of it with a fake store: no network, no Deno.
//
// SHOPIFY QUIRKS THIS CODE HAS TO RESPECT
//   * HTTP 200 does not mean success. Query errors and throttling both come back
//     as 200 with an `errors` array, and a mutation's failures are in
//     `userErrors`. Every response body is inspected (same trap as
//     shopifyErrorFrom in product-sync/shopify.ts).
//   * 401 = the token is dead. 403 or ACCESS_DENIED = the token is alive but
//     lacks a scope. They're different problems with different fixes, so they
//     are different error kinds.
//   * Throttling (HTTP 429 or extensions.code THROTTLED) is retried with
//     exponential backoff, honouring Retry-After (rule 6).
//   * Setting a metafield is an UPSERT. Retrying a write that already landed is
//     harmless, but reading "the previous value" after it landed would return the
//     new value, which is why applyChange takes the prior state from the caller
//     and only reads it when the caller has none recorded.
// =============================================================================

import { bodyMatches, slugify, type ArticleProposal, type PriorState, type ResourceKind, type SeoMetafieldKey, type UrlClass } from "./lib.ts";

/** Pinned to product-sync/shopify.ts and voice-order-lookup. Bump all together. */
export const SHOPIFY_API_VERSION = "2026-04";

export type ShopifyErrorKind =
  | "auth" // 401: token rejected or revoked
  | "scope" // token valid, scope missing
  | "throttled" // ran out of retries while throttled
  | "transient" // network / 5xx after retries
  | "not_found"
  | "drift" // the live value is not what we wrote, so we won't overwrite it
  | "user" // mutation userErrors
  | "graphql"; // any other query error

export class ShopifyError extends Error {
  constructor(public kind: ShopifyErrorKind, message: string) {
    super(message);
    this.name = "ShopifyError";
  }
}

export type Ctx = {
  shop: string; // *.myshopify.com
  token: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  maxRetries?: number; // default 5
  baseDelayMs?: number; // default 500
  maxDelayMs?: number; // default 30_000
};

function delayFor(attempt: number, ctx: Ctx, retryAfterHeader: string | null): number {
  const base = ctx.baseDelayMs ?? 500;
  const max = ctx.maxDelayMs ?? 30_000;
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
  const backoff = Math.min(base * 2 ** attempt, max);
  return Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, backoff), max) : backoff;
}

function errorCodes(errors: unknown): string[] {
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => String(e?.extensions?.code ?? e?.message ?? "")).filter(Boolean);
}

/** One GraphQL call with retry. Returns `data`; throws ShopifyError otherwise. */
export async function gql<T = any>(ctx: Ctx, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const url = `https://${ctx.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const maxRetries = ctx.maxRetries ?? 5;
  let lastTransient = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await ctx.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": ctx.token },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      lastTransient = `network error: ${e instanceof Error ? e.message : String(e)}`;
      if (attempt < maxRetries) await ctx.sleep(delayFor(attempt, ctx, null));
      continue;
    }

    if (res.status === 401) throw new ShopifyError("auth", "Shopify rejected the access token (401)");
    if (res.status === 403) throw new ShopifyError("scope", "Shopify refused the request (403): missing scope or app disabled");

    if (res.status === 429 || res.status >= 500) {
      lastTransient = `HTTP ${res.status}`;
      if (attempt < maxRetries) await ctx.sleep(delayFor(attempt, ctx, res.headers.get("Retry-After")));
      continue;
    }

    const body = (await res.json().catch(() => null)) as { data?: T; errors?: unknown } | null;
    if (!body) {
      lastTransient = "unparseable response";
      if (attempt < maxRetries) await ctx.sleep(delayFor(attempt, ctx, null));
      continue;
    }

    const codes = errorCodes(body.errors);
    if (codes.length) {
      if (codes.includes("THROTTLED")) {
        lastTransient = "THROTTLED";
        if (attempt < maxRetries) await ctx.sleep(delayFor(attempt, ctx, res.headers.get("Retry-After")));
        continue;
      }
      if (codes.includes("ACCESS_DENIED")) throw new ShopifyError("scope", `access denied: ${JSON.stringify(body.errors)}`);
      throw new ShopifyError("graphql", codes.join(", "));
    }
    if (body.data === undefined) throw new ShopifyError("graphql", "response had no data");
    return body.data;
  }

  throw new ShopifyError(lastTransient === "THROTTLED" ? "throttled" : "transient", `gave up after ${maxRetries + 1} attempts: ${lastTransient}`);
}

function userErrorsOf(payload: { userErrors?: { field?: string[]; message: string }[] } | null | undefined): string | null {
  const ue = payload?.userErrors;
  if (!ue || ue.length === 0) return null;
  return ue.map((u) => `${u.field?.join(".") ?? ""} ${u.message}`.trim()).join("; ");
}

// -----------------------------------------------------------------------------
// Heartbeat
// -----------------------------------------------------------------------------

export async function checkConnection(ctx: Ctx): Promise<{ scopes: string[]; primaryHost: string | null }> {
  const data = await gql<{
    shop: { primaryDomain?: { host?: string } | null };
    currentAppInstallation: { accessScopes: { handle: string }[] };
  }>(
    ctx,
    `query { shop { primaryDomain { host } } currentAppInstallation { accessScopes { handle } } }`,
  );
  return {
    scopes: (data.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle),
    primaryHost: data.shop?.primaryDomain?.host ?? null,
  };
}

// -----------------------------------------------------------------------------
// Resolve a URL's resource to its GID
// -----------------------------------------------------------------------------

export async function resolveResource(ctx: Ctx, cls: Pick<UrlClass, "kind" | "handle" | "blogHandle">): Promise<string | null> {
  const h = cls.handle;
  if (!h) return null;

  switch (cls.kind as ResourceKind) {
    case "product": {
      const d = await gql<{ productByIdentifier: { id: string } | null }>(
        ctx,
        `query($h: String!) { productByIdentifier(identifier: { handle: $h }) { id } }`,
        { h },
      );
      return d.productByIdentifier?.id ?? null;
    }
    case "collection": {
      const d = await gql<{ collectionByIdentifier: { id: string } | null }>(
        ctx,
        `query($h: String!) { collectionByIdentifier(identifier: { handle: $h }) { id } }`,
        { h },
      );
      return d.collectionByIdentifier?.id ?? null;
    }
    case "page": {
      const d = await gql<{ pages: { nodes: { id: string; handle: string }[] } }>(
        ctx,
        `query($q: String!) { pages(first: 5, query: $q) { nodes { id handle } } }`,
        { q: `handle:${h}` },
      );
      // The search is a filter, not an equality check; insist on the exact handle.
      return d.pages.nodes.find((n) => n.handle === h)?.id ?? null;
    }
    case "article": {
      const d = await gql<{ articles: { nodes: { id: string; handle: string; blog: { handle: string } | null }[] } }>(
        ctx,
        `query($q: String!) { articles(first: 10, query: $q) { nodes { id handle blog { handle } } } }`,
        { q: `handle:${h}` },
      );
      // The same article handle can exist in two blogs; the blog in the URL decides.
      return d.articles.nodes.find((n) => n.handle === h && n.blog?.handle === cls.blogHandle)?.id ?? null;
    }
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// SEO override metafield read / write / delete
// -----------------------------------------------------------------------------

export type Override = { id: string; value: string } | null;

export async function readOverride(ctx: Ctx, gid: string, key: SeoMetafieldKey): Promise<Override> {
  const d = await gql<{ node: { metafield: { id: string; value: string } | null } | null }>(
    ctx,
    `query($id: ID!, $k: String!) { node(id: $id) { ... on HasMetafields { metafield(namespace: "global", key: $k) { id value } } } }`,
    { id: gid, k: key },
  );
  if (!d.node) throw new ShopifyError("not_found", `${gid} no longer exists`);
  return d.node.metafield ?? null;
}

export async function writeOverride(ctx: Ctx, gid: string, key: SeoMetafieldKey, value: string): Promise<void> {
  const d = await gql<{ metafieldsSet: { userErrors: { field?: string[]; message: string }[] } }>(
    ctx,
    `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { id } userErrors { field message } } }`,
    { m: [{ ownerId: gid, namespace: "global", key, type: "single_line_text_field", value }] },
  );
  const err = userErrorsOf(d.metafieldsSet);
  if (err) throw new ShopifyError("user", err);
}

export async function deleteOverride(ctx: Ctx, gid: string, key: SeoMetafieldKey): Promise<void> {
  const d = await gql<{ metafieldsDelete: { userErrors: { field?: string[]; message: string }[] } }>(
    ctx,
    `mutation($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) { deletedMetafields { key } userErrors { field message } } }`,
    { m: [{ ownerId: gid, namespace: "global", key }] },
  );
  const err = userErrorsOf(d.metafieldsDelete);
  if (err) throw new ShopifyError("user", err);
}

// -----------------------------------------------------------------------------
// Apply and revert
// -----------------------------------------------------------------------------

export type ApplyResult = {
  resource_id: string;
  prior: PriorState;
  /** true when the store already held the proposed value and nothing was written */
  noop: boolean;
};

/**
 * Write `proposed` into the SEO override.
 *
 * `recordedPrior` is the prior state persisted by an earlier attempt, if any. It
 * wins over anything read now: on a retry the store may already hold our value.
 * When there is none, the prior state is read and handed to `persistPrior`, and
 * that must complete BEFORE the write, so a crash between the two can never lose
 * the rollback source.
 */
export async function applyChange(
  ctx: Ctx,
  target: { kind: ResourceKind; handle: string; blogHandle: string | null; key: SeoMetafieldKey },
  proposed: string,
  recordedPrior: PriorState | null,
  persistPrior: (p: PriorState) => Promise<void>,
  now: () => string = () => new Date().toISOString(),
): Promise<ApplyResult> {
  const gid = await resolveResource(ctx, target);
  if (!gid) throw new ShopifyError("not_found", `no ${target.kind} with handle "${target.handle}"`);

  let prior = recordedPrior;
  const current = await readOverride(ctx, gid, target.key);
  if (!prior) {
    prior = { id: current?.id ?? null, value: current?.value ?? null, recorded_at: now() };
    await persistPrior(prior);
  }

  if (current?.value === proposed) return { resource_id: gid, prior, noop: true };

  await writeOverride(ctx, gid, target.key, proposed);

  const after = await readOverride(ctx, gid, target.key);
  if (after?.value !== proposed) {
    throw new ShopifyError("graphql", "the store did not keep the new value after the write");
  }
  return { resource_id: gid, prior, noop: false };
}

/**
 * Undo an applied change. Refuses (kind "drift") if the live value is no longer
 * what we wrote: someone edited it since, and restoring the old value would
 * silently destroy their change.
 */
export async function revertChange(
  ctx: Ctx,
  gid: string,
  key: SeoMetafieldKey,
  written: string,
  prior: PriorState,
): Promise<void> {
  const current = await readOverride(ctx, gid, key);
  if ((current?.value ?? null) === (prior.value ?? null)) return; // already back where it started
  if (current?.value !== written) {
    throw new ShopifyError("drift", "the value in Shopify was changed after LumiLink published it, so it was left alone");
  }

  if (prior.value === null) await deleteOverride(ctx, gid, key);
  else await writeOverride(ctx, gid, key, prior.value);

  const after = await readOverride(ctx, gid, key);
  if ((after?.value ?? null) !== (prior.value ?? null)) {
    throw new ShopifyError("graphql", "the store did not keep the restored value");
  }
}

// =============================================================================
// Articles (module 16). A blog post is created, verified, and on rollback deleted.
// =============================================================================


export type Blog = { id: string; handle: string; title: string };

/** Which blog gets the article: the connection's preferred one if it names one,
 * else the store's only blog, else "news" (Shopify's default), else the first. */
export function chooseBlog(blogs: readonly Blog[], preferredHandle?: string | null): Blog | null {
  if (blogs.length === 0) return null;
  if (preferredHandle) {
    const p = blogs.find((b) => b.handle === preferredHandle);
    if (p) return p;
  }
  if (blogs.length === 1) return blogs[0];
  return blogs.find((b) => b.handle === "news") ?? blogs[0];
}

export async function listBlogs(ctx: Ctx): Promise<Blog[]> {
  const d = await gql<{ blogs: { nodes: Blog[] } }>(ctx, `query { blogs(first: 20) { nodes { id handle title } } }`);
  return d.blogs.nodes;
}

export type ArticleState = { id: string; title: string; body: string; handle: string; blogHandle: string; isPublished: boolean };

/** null when the article no longer exists. */
export async function readArticle(ctx: Ctx, gid: string): Promise<ArticleState | null> {
  const d = await gql<{ node: { id: string; title: string; body: string; handle: string; isPublished: boolean; blog: { handle: string } } | null }>(
    ctx,
    `query($id: ID!) { node(id: $id) { ... on Article { id title body handle isPublished blog { handle } } } }`,
    { id: gid },
  );
  const n = d.node;
  if (!n || !n.id) return null;
  return { id: n.id, title: n.title, body: n.body, handle: n.handle, blogHandle: n.blog?.handle ?? "", isPublished: n.isPublished };
}

async function findArticleByHandle(ctx: Ctx, blogHandle: string, handle: string): Promise<ArticleState | null> {
  const d = await gql<{ articles: { nodes: { id: string }[] } }>(
    ctx,
    `query($q: String!) { articles(first: 10, query: $q) { nodes { id } } }`,
    { q: `handle:${handle}` },
  );
  for (const n of d.articles.nodes) {
    const a = await readArticle(ctx, n.id);
    if (a && a.handle === handle && a.blogHandle === blogHandle) return a;
  }
  return null;
}

export type PublishedArticle = {
  id: string;
  handle: string;
  blog_handle: string;
  /** an article with this handle and this exact body already existed, so we adopted it */
  adopted: boolean;
  /** why the image was left out, if it was */
  image_error: string | null;
  /** whether the meta description was read back from the store */
  meta_verified: boolean;
};

/**
 * Create the article, or adopt it if a previous attempt already did.
 *
 * articleCreate is not idempotent, so a crash between "Shopify created it" and
 * "we recorded that" would publish a duplicate on retry. The handle is
 * deterministic from the title, so a retry first looks for an article with that
 * handle in that blog whose body matches ours, and adopts it. (If a DIFFERENT
 * article holds the handle, Shopify gives ours a suffixed handle and we don't
 * adopt anything.)
 *
 * A rejected image URL doesn't sink the article: it is retried once without the
 * image and the reason is returned.
 */
export async function publishArticle(
  ctx: Ctx,
  input: { article: ArticleProposal; author: string; preferredBlog?: string | null },
): Promise<PublishedArticle> {
  const blogs = await listBlogs(ctx);
  const blog = chooseBlog(blogs, input.preferredBlog);
  if (!blog) throw new ShopifyError("not_found", "the store has no blog to publish into");

  const { article } = input;
  const handle = slugify(article.title);

  const existing = await findArticleByHandle(ctx, blog.handle, handle);
  if (existing && bodyMatches(existing.body, article.body_html) && existing.title === article.title) {
    return { id: existing.id, handle: existing.handle, blog_handle: blog.handle, adopted: true, image_error: null, meta_verified: await metaMatches(ctx, existing.id, article.meta_description) };
  }

  const build = (withImage: boolean) => ({
    blogId: blog.id,
    title: article.title,
    handle,
    body: article.body_html,
    summary: article.meta_description,
    isPublished: true,
    author: { name: input.author },
    metafields: [{ namespace: "global", key: "description_tag", type: "single_line_text_field", value: article.meta_description }],
    ...(withImage && article.image ? { image: { url: article.image.url, altText: article.image.alt } } : {}),
  });

  const create = async (withImage: boolean) => {
    const d = await gql<{ articleCreate: { article: { id: string; handle: string } | null; userErrors: { field?: string[]; message: string }[] } }>(
      ctx,
      `mutation($a: ArticleCreateInput!) { articleCreate(article: $a) { article { id handle } userErrors { field message } } }`,
      { a: build(withImage) },
    );
    const err = userErrorsOf(d.articleCreate);
    if (err) throw new ShopifyError("user", err);
    if (!d.articleCreate.article) throw new ShopifyError("graphql", "articleCreate returned no article");
    return d.articleCreate.article;
  };

  let imageError: string | null = null;
  let created: { id: string; handle: string };
  try {
    created = await create(true);
  } catch (e) {
    if (e instanceof ShopifyError && e.kind === "user" && article.image && /image/i.test(e.message)) {
      imageError = `Shopify refused the image: ${e.message}`;
      created = await create(false);
    } else {
      throw e;
    }
  }

  // Read it back: it exists, it is live, in the blog we chose, with our title.
  const after = await readArticle(ctx, created.id);
  if (!after || !after.isPublished || after.blogHandle !== blog.handle || after.title !== article.title) {
    throw new ShopifyError("graphql", "the store did not keep the article as created");
  }
  return { id: created.id, handle: after.handle, blog_handle: blog.handle, adopted: false, image_error: imageError, meta_verified: await metaMatches(ctx, created.id, article.meta_description) };
}

async function metaMatches(ctx: Ctx, gid: string, meta: string): Promise<boolean> {
  try {
    return (await readOverride(ctx, gid, "description_tag"))?.value === meta;
  } catch {
    return false; // the article is live; an unread meta description is noted, not fatal
  }
}

/**
 * Delete a published article. Refuses (kind "drift") if its title or wording is
 * no longer what we published: someone has edited it since, and deleting it would
 * throw their work away. An article that is already gone counts as rolled back.
 */
export async function deleteArticle(ctx: Ctx, gid: string, written: { title: string; body_html: string }): Promise<{ already_gone: boolean }> {
  const current = await readArticle(ctx, gid);
  if (!current) return { already_gone: true };
  if (current.title !== written.title || !bodyMatches(current.body, written.body_html)) {
    throw new ShopifyError("drift", "the article was edited in Shopify after LumiLink published it, so it was left alone");
  }
  const d = await gql<{ articleDelete: { deletedArticleId: string | null; userErrors: { field?: string[]; message: string }[] } }>(
    ctx,
    `mutation($id: ID!) { articleDelete(id: $id) { deletedArticleId userErrors { field message } } }`,
    { id: gid },
  );
  const err = userErrorsOf(d.articleDelete);
  if (err) throw new ShopifyError("user", err);
  if (await readArticle(ctx, gid)) throw new ShopifyError("graphql", "the store did not delete the article");
  return { already_gone: false };
}
