// =============================================================================
// test-seo-publish.ts — unit tests for the seo-publish adapter (module 5).
//
//   npx tsx scripts/test-seo-publish.ts
//
// No network, no Deno, no database. Shopify is an in-memory fake that answers
// the same GraphQL the adapter sends. The fake was written from Shopify's docs,
// not from a live store, so these tests prove the adapter's LOGIC (routing,
// retry, ordering, rollback safety); they cannot prove Shopify accepts the
// queries. That needs a real store and token (plan.md, module 5).
// =============================================================================

import {
  articleFromProposal,
  articleManualInstructions,
  bodyMatches,
  classifyUrl,
  connectionStatusFromScopes,
  decideArticle,
  decide,
  manualInstructions,
  missingScopes,
  priorFromPublishResult,
  scopeSatisfied,
  slugify,
  wordsOf,
  urlOnStore,
  type ConnectionFacts,
} from "../supabase/functions/seo-publish/lib.ts";
import {
  applyChange,
  checkConnection,
  chooseBlog,
  deleteArticle,
  gql,
  listBlogs,
  publishArticle,
  readArticle,
  readOverride,
  resolveResource,
  revertChange,
  ShopifyError,
  type Ctx,
} from "../supabase/functions/seo-publish/shopify.ts";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, got?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${got === undefined ? "" : `  (got: ${JSON.stringify(got)})`}`);
  }
}

async function rejects(p: Promise<unknown>): Promise<ShopifyError | Error | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as Error;
  }
}

// -----------------------------------------------------------------------------
// The fake store
// -----------------------------------------------------------------------------

type Res = { gid: string; kind: "product" | "collection" | "page" | "article"; handle: string; blog?: string; title?: string; body?: string; published?: boolean; imageUrl?: string; mf: Map<string, { id: string; value: string }> };

class FakeShopify {
  resources: Res[] = [];
  scopes = ["write_products", "write_content"];
  primaryHost: string | null = "shop.example.com";
  // knobs
  throttleNext = 0;
  statusNext: number[] = []; // consumed one per request
  networkFailNext = 0;
  dropWrites = false; // accept a write but do not keep it
  userErrorOnSet: string | null = null;
  retryAfter: string | null = null;
  blogs: { id: string; handle: string; title: string }[] = [{ id: "gid://shopify/Blog/1", handle: "news", title: "News" }];
  rejectImages = false; // articleCreate refuses any image URL
  dropArticleCreate = false; // articleCreate says ok but keeps nothing
  // observation
  calls: string[] = []; // operation names, in order
  private n = 0;

  add(kind: Res["kind"], handle: string, blog?: string, override?: { key: string; value: string }): Res {
    const r: Res = { gid: `gid://shopify/${kind}/${++this.n}`, kind, handle, blog, mf: new Map() };
    if (override) r.mf.set(override.key, { id: `gid://shopify/Metafield/${++this.n}`, value: override.value });
    this.resources.push(r);
    return r;
  }

  fetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    const q: string = body.query;
    const v = body.variables ?? {};

    if (this.networkFailNext > 0) {
      this.networkFailNext--;
      throw new TypeError("connection reset");
    }
    const forced = this.statusNext.shift();
    if (forced) return new Response("{}", { status: forced, headers: this.retryAfter ? { "Retry-After": this.retryAfter } : {} });
    if (this.throttleNext > 0) {
      this.throttleNext--;
      return Response.json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] });
    }

    const ok = (data: unknown) => Response.json({ data });
    const find = (kind: Res["kind"], handle: string) => this.resources.find((r) => r.kind === kind && r.handle === handle);

    if (q.includes("currentAppInstallation")) {
      this.calls.push("check");
      return ok({
        shop: { primaryDomain: this.primaryHost ? { host: this.primaryHost } : null },
        currentAppInstallation: { accessScopes: this.scopes.map((handle) => ({ handle })) },
      });
    }
    if (q.includes("productByIdentifier")) {
      this.calls.push("resolve");
      const r = find("product", v.h);
      return ok({ productByIdentifier: r ? { id: r.gid } : null });
    }
    if (q.includes("collectionByIdentifier")) {
      this.calls.push("resolve");
      const r = find("collection", v.h);
      return ok({ collectionByIdentifier: r ? { id: r.gid } : null });
    }
    if (q.includes("blogs(")) {
      this.calls.push("blogs");
      return ok({ blogs: { nodes: this.blogs } });
    }
    if (q.includes("... on Article")) {
      this.calls.push("read-article");
      const r = this.resources.find((x) => x.gid === v.id && x.kind === "article");
      return ok({ node: r ? { id: r.gid, title: r.title ?? "", body: r.body ?? "", handle: r.handle, isPublished: r.published ?? true, blog: { handle: r.blog ?? "" } } : null });
    }
    if (q.includes("articleCreate")) {
      this.calls.push("article-create");
      const a = v.a;
      if (this.rejectImages && a.image) return ok({ articleCreate: { article: null, userErrors: [{ field: ["article", "image"], message: "Image URL is not valid" }] } });
      const blog = this.blogs.find((b) => b.id === a.blogId);
      let handle = a.handle as string;
      while (this.resources.some((x) => x.kind === "article" && x.blog === blog?.handle && x.handle === handle)) handle += "-1";
      const r = this.add("article", handle, blog?.handle);
      if (!this.dropArticleCreate) {
        r.title = a.title; r.body = a.body; r.published = a.isPublished; r.imageUrl = a.image?.url;
        for (const m of a.metafields ?? []) r.mf.set(m.key, { id: `gid://shopify/Metafield/${++this.n}`, value: m.value });
      } else {
        this.resources.pop();
      }
      return ok({ articleCreate: { article: { id: r.gid, handle }, userErrors: [] } });
    }
    if (q.includes("articleDelete")) {
      this.calls.push("article-delete");
      const i = this.resources.findIndex((x) => x.gid === v.id && x.kind === "article");
      if (i >= 0) this.resources.splice(i, 1);
      return ok({ articleDelete: { deletedArticleId: i >= 0 ? v.id : null, userErrors: [] } });
    }
    if (q.includes("pages(")) {
      this.calls.push("resolve");
      const h = String(v.q).replace("handle:", "");
      // A real search is fuzzy: return prefix matches too, so the adapter's
      // exact-handle check is exercised.
      const nodes = this.resources.filter((r) => r.kind === "page" && r.handle.startsWith(h)).map((r) => ({ id: r.gid, handle: r.handle }));
      return ok({ pages: { nodes } });
    }
    if (q.includes("articles(")) {
      this.calls.push("resolve");
      const h = String(v.q).replace("handle:", "");
      const nodes = this.resources.filter((r) => r.kind === "article" && r.handle === h).map((r) => ({ id: r.gid, handle: r.handle, blog: { handle: r.blog ?? "" } }));
      return ok({ articles: { nodes } });
    }
    if (q.includes("node(id")) {
      this.calls.push("read");
      const r = this.resources.find((x) => x.gid === v.id);
      return ok({ node: r ? { metafield: r.mf.get(v.k) ?? null } : null });
    }
    if (q.includes("metafieldsSet")) {
      this.calls.push("write");
      if (this.userErrorOnSet) return ok({ metafieldsSet: { userErrors: [{ field: ["metafields", "0", "value"], message: this.userErrorOnSet }] } });
      const m = v.m[0];
      const r = this.resources.find((x) => x.gid === m.ownerId);
      if (r && !this.dropWrites) r.mf.set(m.key, { id: r.mf.get(m.key)?.id ?? `gid://shopify/Metafield/${++this.n}`, value: m.value });
      return ok({ metafieldsSet: { userErrors: [] } });
    }
    if (q.includes("metafieldsDelete")) {
      this.calls.push("delete");
      const m = v.m[0];
      this.resources.find((x) => x.gid === m.ownerId)?.mf.delete(m.key);
      return ok({ metafieldsDelete: { userErrors: [] } });
    }
    return Response.json({ errors: [{ message: "unknown query in fake" }] });
  };

  ctx(over: Partial<Ctx> = {}): Ctx & { slept: number[] } {
    const slept: number[] = [];
    return { shop: "shop.myshopify.com", token: "shpat_test", fetch: this.fetch, sleep: async (ms) => void slept.push(ms), slept, ...over } as Ctx & { slept: number[] };
  }
}

async function main() {
const conn: ConnectionFacts = {
  status: "healthy",
  granted_scopes: ["write_products", "write_content"],
  shop_domain: "shop.myshopify.com",
  primary_domain: "shop.example.com",
};

// -----------------------------------------------------------------------------
console.log("classifyUrl");
// -----------------------------------------------------------------------------
{
  const c = (u: string) => classifyUrl(u);
  ok("root is home", c("https://shop.example.com/")?.kind === "home");
  ok("bare host is home", c("https://shop.example.com")?.kind === "home");
  ok("page", JSON.stringify(c("https://shop.example.com/pages/about-us")) === '{"kind":"page","handle":"about-us","blogHandle":null}');
  ok("product", c("https://shop.example.com/products/blue-widget")?.handle === "blue-widget");
  ok("product seen through a collection is the product", c("https://shop.example.com/collections/sale/products/blue-widget")?.kind === "product" && c("https://shop.example.com/collections/sale/products/blue-widget")?.handle === "blue-widget");
  ok("collection", c("https://shop.example.com/collections/sale")?.kind === "collection");
  ok("article carries its blog", JSON.stringify(c("https://shop.example.com/blogs/news/spring-tips")) === '{"kind":"article","handle":"spring-tips","blogHandle":"news"}');
  ok("a blog index is not an article", c("https://shop.example.com/blogs/news")?.kind === "other");
  ok("locale prefix is stripped before a known root", c("https://shop.example.com/en-ca/products/blue-widget")?.handle === "blue-widget");
  ok("a page literally named fr is not mistaken for a locale", c("https://shop.example.com/pages/fr")?.handle === "fr");
  ok("query and hash are ignored", c("https://shop.example.com/products/blue-widget?variant=1#x")?.handle === "blue-widget");
  ok("percent-encoded handle is decoded", c("https://shop.example.com/pages/caf%C3%A9")?.kind === "other"); // non-ascii handle: refuse rather than guess
  ok("a handle that could alter a search query is refused", c("https://shop.example.com/pages/x%20OR%20title:y")?.kind === "other");
  ok("cart is other", c("https://shop.example.com/cart")?.kind === "other");
  ok("junk is null", c("not a url") === null);
}

// -----------------------------------------------------------------------------
console.log("scopes");
// -----------------------------------------------------------------------------
{
  ok("products need write_products", scopeSatisfied(["write_products"], "product") && !scopeSatisfied(["write_content"], "product"));
  ok("pages accept either content scope", scopeSatisfied(["write_online_store_pages"], "page") && scopeSatisfied(["write_content"], "page"));
  ok("articles need write_content", scopeSatisfied(["write_content"], "article") && !scopeSatisfied(["write_online_store_pages"], "article"));
  ok("healthy with the write scopes", connectionStatusFromScopes(["write_products", "write_content"]) === "healthy");
  ok("read-only scopes are degraded", connectionStatusFromScopes(["read_products", "read_content"]) === "degraded");
  ok("missingScopes names what's missing", JSON.stringify(missingScopes(["write_products"])) === '["write_content"]');
}

// -----------------------------------------------------------------------------
console.log("decide (routing)");
// -----------------------------------------------------------------------------
{
  const act = (target_field: string, target_url: string | null) => ({ target_field, target_url });
  const d1 = decide(act("title_tag", "https://shop.example.com/products/blue-widget"), conn);
  ok("a product title goes through the API", d1.mode === "api" && d1.key === "title_tag" && d1.kind === "product");
  const d2 = decide(act("meta_description", "https://shop.example.com/pages/about"), conn);
  ok("a page meta description goes through the API as description_tag", d2.mode === "api" && d2.key === "description_tag");
  ok("the homepage is manual", (decide(act("title_tag", "https://shop.example.com/"), conn) as any).reason === "homepage_has_no_api");
  ok("schema is manual", (decide(act("local_business_schema", "https://shop.example.com/"), conn) as any).reason === "theme_write_needs_shopify_exemption");
  ok("schema is manual even with no connection at all", (decide(act("local_business_schema", "https://shop.example.com/"), null) as any).reason === "theme_write_needs_shopify_exemption");
  ok("h1 is manual", (decide(act("h1", "https://shop.example.com/pages/about"), conn) as any).reason === "h1_comes_from_the_theme");
  ok("no connection is manual", (decide(act("title_tag", "https://shop.example.com/pages/about"), null) as any).reason === "no_site_connection");
  ok("a revoked connection is manual", (decide(act("title_tag", "https://shop.example.com/pages/about"), { ...conn, status: "revoked" }) as any).reason === "connection_revoked");
  ok("a transient-error connection is still attempted", decide(act("title_tag", "https://shop.example.com/pages/about"), { ...conn, status: "error" }).mode === "api");
  ok("a URL on another store is manual", (decide(act("title_tag", "https://other-shop.com/pages/about"), conn) as any).reason === "url_not_on_connected_store");
  ok("the myshopify domain also counts as this store", decide(act("title_tag", "https://shop.myshopify.com/pages/about"), conn).mode === "api");
  ok("www is ignored when matching the store", decide(act("title_tag", "https://www.shop.example.com/pages/about"), conn).mode === "api");
  ok("a missing scope is manual and names the scope", (() => {
    const d = decide(act("title_tag", "https://shop.example.com/products/x"), { ...conn, granted_scopes: ["write_content"] }) as any;
    return d.reason === "missing_scope" && d.detail === "write_products";
  })());
  ok("never-checked (no scopes recorded) is attempted, not refused", decide(act("title_tag", "https://shop.example.com/products/x"), { ...conn, granted_scopes: [] }).mode === "api");
  ok("an unknown field is manual", (decide(act("canonical", "https://shop.example.com/pages/about"), conn) as any).reason === "field_not_supported");
  ok("no target URL is manual", (decide(act("title_tag", null), conn) as any).reason === "unrecognised_url");
  ok("a cart URL is manual", (decide(act("title_tag", "https://shop.example.com/cart"), conn) as any).reason === "unrecognised_url");
  ok("urlOnStore rejects junk", !urlOnStore("nope", conn));
}

// -----------------------------------------------------------------------------
console.log("manualInstructions");
// -----------------------------------------------------------------------------
{
  const home = manualInstructions({ target_field: "title_tag", target_url: "https://shop.example.com/", proposed: "Acme: Drains in Tulsa" }, "homepage_has_no_api");
  ok("homepage title points at Online Store > Preferences", home.steps.some((s) => s.includes("Online Store > Preferences")) && home.copy.text === "Acme: Drains in Tulsa");
  const page = manualInstructions({ target_field: "meta_description", target_url: "https://shop.example.com/pages/about", proposed: "x".repeat(60) }, "missing_scope", "write_content");
  ok("a page falls back to the Search engine listing steps", page.steps.some((s) => s.includes("Search engine listing")) && page.why.includes("write_content"));
  const schema = manualInstructions({ target_field: "local_business_schema", target_url: "https://shop.example.com/", proposed: '{"@type":"LocalBusiness"}' }, "theme_write_needs_shopify_exemption");
  ok("schema is wrapped in a script tag and points at theme.liquid", schema.copy.text.startsWith('<script type="application/ld+json">') && schema.copy.text.endsWith("</script>") && schema.steps.some((s) => s.includes("layout/theme.liquid")));
  const h1 = manualInstructions({ target_field: "h1", target_url: "https://shop.example.com/pages/about", proposed: "About Acme" }, "h1_comes_from_the_theme");
  ok("h1 warns about the title's side effects", h1.steps.some((s) => s.includes("menus")));
  ok("every reason has a why", (["no_site_connection", "connection_revoked", "unrecognised_url", "homepage_has_no_api", "theme_write_needs_shopify_exemption", "h1_comes_from_the_theme", "field_not_supported", "url_not_on_connected_store", "missing_scope", "resource_not_found", "resource_lookup_failed"] as const).every((r) => manualInstructions({ target_field: "title_tag", target_url: null, proposed: "x" }, r).why.length > 10));
}

// -----------------------------------------------------------------------------
console.log("gql: errors, retry, backoff (rule 6)");
// -----------------------------------------------------------------------------
{
  const s = new FakeShopify();
  s.throttleNext = 3;
  const ctx = s.ctx();
  const out = await checkConnection(ctx);
  ok("throttling is retried until it succeeds", out.scopes.length === 2);
  ok("backoff doubles each time", JSON.stringify(ctx.slept) === "[500,1000,2000]", ctx.slept);

  const s2 = new FakeShopify();
  s2.throttleNext = 99;
  const c2 = s2.ctx({ maxRetries: 2 });
  const e2 = await rejects(checkConnection(c2));
  ok("throttling forever gives up with kind 'throttled'", e2 instanceof ShopifyError && e2.kind === "throttled", (e2 as any)?.kind);
  ok("and it made exactly maxRetries+1 attempts", c2.slept.length === 2);

  const s3 = new FakeShopify();
  s3.statusNext = [401];
  const e3 = await rejects(checkConnection(s3.ctx()));
  ok("401 is 'auth' and is NOT retried", e3 instanceof ShopifyError && e3.kind === "auth" && s3.calls.length === 0);

  const s4 = new FakeShopify();
  s4.statusNext = [403];
  const e4 = await rejects(checkConnection(s4.ctx()));
  ok("403 is 'scope', not 'auth'", e4 instanceof ShopifyError && e4.kind === "scope");

  const s5 = new FakeShopify();
  s5.statusNext = [502, 503];
  const c5 = s5.ctx();
  ok("5xx is retried then succeeds", (await checkConnection(c5)).scopes.length === 2 && c5.slept.length === 2);

  const s6 = new FakeShopify();
  s6.networkFailNext = 2;
  ok("a network error is retried", (await checkConnection(s6.ctx())).scopes.length === 2);

  const s7 = new FakeShopify();
  s7.statusNext = [429];
  s7.retryAfter = "3";
  const c7 = s7.ctx();
  await checkConnection(c7);
  ok("Retry-After is honoured when it is longer than the backoff", c7.slept[0] === 3000, c7.slept);

  const e8 = await rejects(gql({ ...new FakeShopify().ctx(), fetch: async () => Response.json({ errors: [{ message: "x", extensions: { code: "ACCESS_DENIED" } }] }) }, "query { a }"));
  ok("ACCESS_DENIED in a 200 body is 'scope'", e8 instanceof ShopifyError && e8.kind === "scope");

  const e9 = await rejects(gql({ ...new FakeShopify().ctx(), fetch: async () => Response.json({ errors: [{ message: "Field 'nope' doesn't exist" }] }) }, "query { a }"));
  ok("another GraphQL error in a 200 body is 'graphql' and not retried", e9 instanceof ShopifyError && e9.kind === "graphql");

  const s10 = new FakeShopify();
  s10.primaryHost = null;
  ok("a shop with no primary domain doesn't crash the heartbeat", (await checkConnection(s10.ctx())).primaryHost === null);
}

// -----------------------------------------------------------------------------
console.log("resolveResource");
// -----------------------------------------------------------------------------
{
  const s = new FakeShopify();
  const about = s.add("page", "about");
  s.add("page", "about-us-extra");
  const prod = s.add("product", "blue-widget");
  const col = s.add("collection", "sale");
  const news = s.add("article", "spring-tips", "news");
  s.add("article", "spring-tips", "recipes");
  const ctx = s.ctx();
  ok("product", (await resolveResource(ctx, { kind: "product", handle: "blue-widget", blogHandle: null })) === prod.gid);
  ok("collection", (await resolveResource(ctx, { kind: "collection", handle: "sale", blogHandle: null })) === col.gid);
  ok("page needs the EXACT handle even when search returns near matches", (await resolveResource(ctx, { kind: "page", handle: "about", blogHandle: null })) === about.gid);
  ok("article is picked by blog handle", (await resolveResource(ctx, { kind: "article", handle: "spring-tips", blogHandle: "news" })) === news.gid);
  ok("an article in the wrong blog is not found", (await resolveResource(ctx, { kind: "article", handle: "spring-tips", blogHandle: "other" })) === null);
  ok("a missing product is null", (await resolveResource(ctx, { kind: "product", handle: "nope", blogHandle: null })) === null);
  ok("home has no resource", (await resolveResource(ctx, { kind: "home", handle: null, blogHandle: null })) === null);
}

// -----------------------------------------------------------------------------
console.log("applyChange");
// -----------------------------------------------------------------------------
{
  const target = { kind: "product" as const, handle: "blue-widget", blogHandle: null, key: "title_tag" as const };

  // Fresh write, no override yet.
  {
    const s = new FakeShopify();
    const r = s.add("product", "blue-widget");
    const order: string[] = [];
    const res = await applyChange(s.ctx(), target, "Blue Widget | Acme", null, async (p) => {
      order.push(`persist:${s.calls.length}`);
      ok("prior is recorded as null when no override existed", p.value === null && p.id === null);
    });
    ok("the prior state was persisted BEFORE the write", order.length === 1 && !s.calls.slice(0, Number(order[0].split(":")[1])).includes("write"), { order, calls: s.calls });
    ok("the write landed and was verified", r.mf.get("title_tag")?.value === "Blue Widget | Acme" && res.noop === false);
    ok("call order is resolve, read, write, read", JSON.stringify(s.calls) === '["resolve","read","write","read"]', s.calls);
  }

  // Existing override is what gets recorded.
  {
    const s = new FakeShopify();
    s.add("product", "blue-widget", undefined, { key: "title_tag", value: "Old override" });
    let saved: any = null;
    const res = await applyChange(s.ctx(), target, "New title here", null, async (p) => void (saved = p));
    ok("an existing override is recorded as the prior", saved?.value === "Old override" && res.prior.value === "Old override");
  }

  // Retry after the write already landed: the original prior must survive.
  {
    const s = new FakeShopify();
    const r = s.add("product", "blue-widget", undefined, { key: "title_tag", value: "New title here" });
    let persisted = false;
    const original = { id: null, value: "The very first value", recorded_at: "t0" };
    const res = await applyChange(s.ctx(), target, "New title here", original, async () => void (persisted = true));
    ok("a retry keeps the recorded prior, not the value it just read", res.prior.value === "The very first value" && !persisted);
    ok("a value already in place is a no-op write", res.noop && !s.calls.includes("write") && r.mf.get("title_tag")?.value === "New title here");
  }

  // If persisting fails the write must not happen.
  {
    const s = new FakeShopify();
    s.add("product", "blue-widget");
    const e = await rejects(applyChange(s.ctx(), target, "New title here", null, async () => { throw new Error("db down"); }));
    ok("if the prior can't be saved, nothing is written", e?.message === "db down" && !s.calls.includes("write"));
  }

  // Not found.
  {
    const s = new FakeShopify();
    const e = await rejects(applyChange(s.ctx(), target, "x".repeat(20), null, async () => {}));
    ok("a missing resource is 'not_found'", e instanceof ShopifyError && e.kind === "not_found");
  }

  // The store accepts but does not keep the write.
  {
    const s = new FakeShopify();
    s.add("product", "blue-widget");
    s.dropWrites = true;
    const e = await rejects(applyChange(s.ctx(), target, "New title here", null, async () => {}));
    ok("a write the store didn't keep is caught by the read-back", e instanceof ShopifyError && /did not keep/.test(e.message));
  }

  // userErrors.
  {
    const s = new FakeShopify();
    s.add("product", "blue-widget");
    s.userErrorOnSet = "Value is too long";
    const e = await rejects(applyChange(s.ctx(), target, "New title here", null, async () => {}));
    ok("mutation userErrors become kind 'user' with Shopify's message", e instanceof ShopifyError && e.kind === "user" && e.message.includes("too long"));
  }

  // Scope error on the mutation.
  {
    const s = new FakeShopify();
    s.add("product", "blue-widget");
    const inner = s.fetch;
    s.fetch = async (u, i) => {
      if (String((i as any).body).includes("metafieldsSet")) return Response.json({ errors: [{ message: "denied", extensions: { code: "ACCESS_DENIED" } }] });
      return inner(u, i);
    };
    const e = await rejects(applyChange(s.ctx(), target, "New title here", null, async () => {}));
    ok("a scope refusal on the write is kind 'scope'", e instanceof ShopifyError && e.kind === "scope");
  }
}

// -----------------------------------------------------------------------------
console.log("revertChange (rollback)");
// -----------------------------------------------------------------------------
{
  const written = "New title here";

  {
    const s = new FakeShopify();
    const r = s.add("product", "blue-widget", undefined, { key: "title_tag", value: written });
    await revertChange(s.ctx(), r.gid, "title_tag", written, { id: "m", value: "Old override", recorded_at: "t" });
    ok("restores the old override", r.mf.get("title_tag")?.value === "Old override");
  }
  {
    const s = new FakeShopify();
    const r = s.add("product", "blue-widget", undefined, { key: "title_tag", value: written });
    await revertChange(s.ctx(), r.gid, "title_tag", written, { id: null, value: null, recorded_at: "t" });
    ok("deletes the override when there was none before", !r.mf.has("title_tag") && s.calls.includes("delete"));
  }
  {
    const s = new FakeShopify();
    const r = s.add("product", "blue-widget", undefined, { key: "title_tag", value: "Someone edited this by hand" });
    const e = await rejects(revertChange(s.ctx(), r.gid, "title_tag", written, { id: null, value: null, recorded_at: "t" }));
    ok("refuses to overwrite a value someone changed since (drift)", e instanceof ShopifyError && e.kind === "drift");
    ok("and leaves their value alone", r.mf.get("title_tag")?.value === "Someone edited this by hand" && !s.calls.includes("delete") && !s.calls.includes("write"));
  }
  {
    const s = new FakeShopify();
    const r = s.add("product", "blue-widget");
    await revertChange(s.ctx(), r.gid, "title_tag", written, { id: null, value: null, recorded_at: "t" });
    ok("already back where it started is a no-op", !s.calls.includes("delete") && !s.calls.includes("write"));
  }
  {
    const s = new FakeShopify();
    const e = await rejects(revertChange(s.ctx(), "gid://shopify/product/999", "title_tag", written, { id: null, value: null, recorded_at: "t" }));
    ok("a deleted resource is 'not_found'", e instanceof ShopifyError && e.kind === "not_found");
  }
  {
    const s = new FakeShopify();
    const r = s.add("product", "blue-widget", undefined, { key: "title_tag", value: written });
    s.dropWrites = true;
    const e = await rejects(revertChange(s.ctx(), r.gid, "title_tag", written, { id: "m", value: "Old override", recorded_at: "t" }));
    ok("a restore the store didn't keep is caught", e instanceof ShopifyError && /did not keep/.test(e.message));
  }
}

// -----------------------------------------------------------------------------
console.log("full round trip");
// -----------------------------------------------------------------------------
{
  const s = new FakeShopify();
  const r = s.add("page", "about", undefined, { key: "description_tag", value: "Old description that is fine" });
  const d = decide({ target_field: "meta_description", target_url: "https://shop.example.com/pages/about" }, conn);
  if (d.mode !== "api") throw new Error("expected api");
  let saved: any = null;
  const res = await applyChange(s.ctx(), d, "A new meta description for the about page.", null, async (p) => void (saved = p));
  ok("published", r.mf.get("description_tag")?.value === "A new meta description for the about page.");
  const pr = { previous_override: saved, written: "A new meta description for the about page." };
  ok("the prior state round-trips through publish_result", priorFromPublishResult(pr)?.value === "Old description that is fine");
  await revertChange(s.ctx(), res.resource_id, d.key, "A new meta description for the about page.", priorFromPublishResult(pr)!);
  ok("rolled back to exactly what it was", r.mf.get("description_tag")?.value === "Old description that is fine");
  ok("priorFromPublishResult tolerates junk", priorFromPublishResult(null) === null && priorFromPublishResult({}) === null && priorFromPublishResult({ previous_override: "x" }) === null);
}


  // -----------------------------------------------------------------------------
  console.log("articles: helpers");
  // -----------------------------------------------------------------------------
  {
    ok("slugify lowercases, strips punctuation and accents", slugify("How to Clear a Slow Drain — Before It Backs Up!") === "how-to-clear-a-slow-drain-before-it-backs-up" && slugify("Café Guide") === "cafe-guide");
    ok("slugify caps length without a trailing hyphen", slugify("word ".repeat(30)).length <= 60 && !slugify("word ".repeat(30)).endsWith("-"));
    ok("slugify never returns empty", slugify("!!!") === "article");
    ok("wordsOf ignores markup, entities and case", JSON.stringify(wordsOf("<p>Hello &amp; <strong>World</strong></p>")) === '["hello","world"]');
    ok("bodyMatches ignores how the markup was re-serialised", bodyMatches("<p>One two</p><p>three</p>", "<p>One two</p>\n<p>three</p>"));
    ok("bodyMatches notices a changed word", !bodyMatches("<p>One two three</p>", "<p>One two four</p>"));
    ok("chooseBlog: the named one wins", chooseBlog([{ id: "1", handle: "a", title: "A" }, { id: "2", handle: "b", title: "B" }], "b")?.id === "2");
    ok("chooseBlog: a lone blog is used", chooseBlog([{ id: "1", handle: "x", title: "X" }])?.id === "1");
    ok("chooseBlog: prefers 'news' among several", chooseBlog([{ id: "1", handle: "a", title: "A" }, { id: "2", handle: "news", title: "N" }])?.id === "2");
    ok("chooseBlog: none means null", chooseBlog([]) === null);
    ok("articleFromProposal reads a well-formed proposal", articleFromProposal({ title: "T", meta_description: "M", body_html: "<p>x</p>", image: { url: "https://x/y.webp", alt: "a" } })?.image?.alt === "a");
    ok("articleFromProposal tolerates junk and a missing image", articleFromProposal(null) === null && articleFromProposal({ title: 1 }) === null && articleFromProposal({ title: "T", meta_description: "M", body_html: "b" })?.image === null);
    ok("decideArticle: api when healthy", decideArticle(conn).mode === "api");
    ok("decideArticle: no connection is manual", (decideArticle(null) as any).reason === "no_site_connection");
    ok("decideArticle: revoked is manual", (decideArticle({ ...conn, status: "revoked" }) as any).reason === "connection_revoked");
    ok("decideArticle: articles need write_content specifically", (decideArticle({ ...conn, granted_scopes: ["write_online_store_pages"] }) as any).reason === "missing_scope");
    ok("decideArticle: never-checked (no scopes) is attempted", decideArticle({ ...conn, granted_scopes: [] }).mode === "api");
    const mi = articleManualInstructions({ title: "T", meta_description: "Meta text", body_html: "<p>x</p>", image: { url: "https://x/y.webp", alt: "alt text" } }, "connection_revoked");
    ok("manual article steps carry the body, meta description and image link", mi.copy.text === "<p>x</p>" && mi.extra?.some((e) => e.text === "Meta text") === true && mi.extra?.some((e) => e.text === "https://x/y.webp") === true && mi.steps.some((x) => x.includes("Blog posts")));
    ok("manual article steps without an image say so", articleManualInstructions({ title: "T", meta_description: "M", body_html: "b", image: null }, "no_site_connection").steps.some((x) => /no image/.test(x)));
  }

  // -----------------------------------------------------------------------------
  console.log("articles: publish and rollback");
  // -----------------------------------------------------------------------------
  {
    const article = { title: "How to Clear a Slow Drain", meta_description: "A plain guide to slow drains and what to try first.", body_html: "<p>Slow drains build up over time.</p><h2>Try this</h2><p>Use a plunger.</p>", image: { url: "https://x.supabase.co/storage/v1/object/public/seo-content-images/c/1.webp", alt: "A plunger" } };

    // Happy path
    {
      const s = new FakeShopify();
      const r = await publishArticle(s.ctx(), { article, author: "Acme Plumbing" });
      const stored = s.resources.find((x) => x.kind === "article")!;
      ok("publishes a live article in the store's blog", r.blog_handle === "news" && stored.published === true && stored.title === article.title && r.adopted === false);
      ok("with a deterministic handle from the title", r.handle === "how-to-clear-a-slow-drain");
      ok("the featured image was attached", stored.imageUrl === article.image.url && r.image_error === null);
      ok("the meta description was set on the SEO field and read back", stored.mf.get("description_tag")?.value === article.meta_description && r.meta_verified === true);
      ok("call order is blogs, create, read-back", s.calls.indexOf("blogs") < s.calls.indexOf("article-create") && s.calls.indexOf("article-create") < s.calls.lastIndexOf("read-article"), s.calls);
    }
    // Retry after a crash: adopt, don't duplicate.
    {
      const s = new FakeShopify();
      await publishArticle(s.ctx(), { article, author: "A" });
      const again = await publishArticle(s.ctx(), { article, author: "A" });
      ok("a retry adopts the article it already created instead of publishing a second copy", again.adopted === true && s.resources.filter((x) => x.kind === "article").length === 1 && s.calls.filter((c) => c === "article-create").length === 1);
    }
    // A different article already holds the handle: ours is created, not adopted.
    {
      const s = new FakeShopify();
      const other = s.add("article", "how-to-clear-a-slow-drain", "news");
      other.title = "Someone else's post";
      other.body = "<p>Totally different.</p>";
      const r = await publishArticle(s.ctx(), { article, author: "A" });
      ok("an unrelated article with the same handle is left alone and ours gets a different handle", r.adopted === false && r.handle === "how-to-clear-a-slow-drain-1" && other.title === "Someone else's post");
    }
    // Same handle and title but the body was edited: not adopted (it isn't ours any more).
    {
      const s = new FakeShopify();
      await publishArticle(s.ctx(), { article, author: "A" });
      s.resources.find((x) => x.kind === "article")!.body = "<p>Edited by a human.</p>";
      const r = await publishArticle(s.ctx(), { article, author: "A" });
      ok("an existing article whose body no longer matches is not adopted", r.adopted === false && s.resources.filter((x) => x.kind === "article").length === 2);
    }
    // Image refused: publish without it and say why.
    {
      const s = new FakeShopify();
      s.rejectImages = true;
      const r = await publishArticle(s.ctx(), { article, author: "A" });
      const stored = s.resources.find((x) => x.kind === "article")!;
      ok("a rejected image doesn't sink the article", stored.imageUrl === undefined && /image/i.test(r.image_error ?? "") && s.calls.filter((c) => c === "article-create").length === 2);
    }
    // No image at all.
    {
      const s = new FakeShopify();
      const r = await publishArticle(s.ctx(), { article: { ...article, image: null }, author: "A" });
      ok("an article with no image publishes normally", r.image_error === null && s.resources.find((x) => x.kind === "article")?.imageUrl === undefined);
    }
    // No blog.
    {
      const s = new FakeShopify();
      s.blogs = [];
      const e = await rejects(publishArticle(s.ctx(), { article, author: "A" }));
      ok("a store with no blog is 'not_found'", e instanceof ShopifyError && e.kind === "not_found");
    }
    // Preferred blog.
    {
      const s = new FakeShopify();
      s.blogs = [{ id: "gid://shopify/Blog/1", handle: "news", title: "News" }, { id: "gid://shopify/Blog/2", handle: "tips", title: "Tips" }];
      const r = await publishArticle(s.ctx(), { article, author: "A", preferredBlog: "tips" });
      ok("a preferred blog is honoured", r.blog_handle === "tips");
    }
    // The store says ok but keeps nothing.
    {
      const s = new FakeShopify();
      s.dropArticleCreate = true;
      const e = await rejects(publishArticle(s.ctx(), { article, author: "A" }));
      ok("an article the store didn't keep is caught by the read-back", e instanceof ShopifyError && /did not keep/.test(e.message));
    }
    // Scope refusal on create.
    {
      const s = new FakeShopify();
      const inner = s.fetch;
      s.fetch = async (u, i) => String((i as any).body).includes("articleCreate") ? Response.json({ errors: [{ message: "denied", extensions: { code: "ACCESS_DENIED" } }] }) : inner(u, i);
      const e = await rejects(publishArticle(s.ctx(), { article, author: "A" }));
      ok("a scope refusal on create is kind 'scope'", e instanceof ShopifyError && e.kind === "scope");
    }
    // Rollback
    {
      const s = new FakeShopify();
      const r = await publishArticle(s.ctx(), { article, author: "A" });
      const out = await deleteArticle(s.ctx(), r.id, { title: article.title, body_html: article.body_html });
      ok("rollback deletes the article", out.already_gone === false && !s.resources.some((x) => x.kind === "article") && s.calls.includes("article-delete"));
    }
    {
      const s = new FakeShopify();
      const r = await publishArticle(s.ctx(), { article, author: "A" });
      const stored = s.resources.find((x) => x.kind === "article")!;
      stored.body = "<p>A human rewrote this.</p>";
      const e = await rejects(deleteArticle(s.ctx(), r.id, { title: article.title, body_html: article.body_html }));
      ok("rollback refuses to delete an article someone edited (drift)", e instanceof ShopifyError && e.kind === "drift" && s.resources.some((x) => x.kind === "article") && !s.calls.includes("article-delete"));
    }
    {
      const s = new FakeShopify();
      const r = await publishArticle(s.ctx(), { article, author: "A" });
      s.resources.find((x) => x.kind === "article")!.title = "Renamed by a human";
      const e = await rejects(deleteArticle(s.ctx(), r.id, { title: article.title, body_html: article.body_html }));
      ok("a changed title is drift too", e instanceof ShopifyError && e.kind === "drift");
    }
    {
      const s = new FakeShopify();
      const out = await deleteArticle(s.ctx(), "gid://shopify/Article/999", { title: "x", body_html: "<p>x</p>" });
      ok("an article that is already gone counts as rolled back", out.already_gone === true && !s.calls.includes("article-delete"));
    }
    {
      const s = new FakeShopify();
      const r = await publishArticle(s.ctx(), { article, author: "A" });
      const stored = s.resources.find((x) => x.kind === "article")!;
      stored.body = "<p>Slow drains build up over time.</p>\n<h2>Try this</h2>\n<p>Use a plunger.</p>";
      const out = await deleteArticle(s.ctx(), r.id, { title: article.title, body_html: article.body_html });
      ok("Shopify re-serialising the markup is not mistaken for an edit", out.already_gone === false);
    }
    {
      const s = new FakeShopify();
      ok("readArticle returns null for something that isn't an article", (await readArticle(s.ctx(), "gid://shopify/Product/1")) === null);
      ok("listBlogs returns the store's blogs", (await listBlogs(s.ctx())).length === 1);
    }
  }

console.log(`\n${passed} passed, ${failed} failed`);
}

main().then(() => process.exit(failed === 0 ? 0 : 1), (e) => { console.error(e); process.exit(1); });
