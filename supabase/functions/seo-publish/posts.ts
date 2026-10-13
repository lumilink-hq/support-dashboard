// =============================================================================
// seo-publish/posts.ts — publishing an approved Google Business Profile post,
// and deleting it. Google My Business API v4 localPosts. `fetch` and `sleep`
// are injected (scripts/test-seo-gbp-posts.ts).
//
// The body is fixed: languageCode, summary, topicType STANDARD. No
// callToAction, no media, no offer or event (seo-draft/posts.ts explains why).
//
// NO DOUBLE POSTS. Before creating, the location's recent posts are listed; a
// post with exactly our text is taken as ours (a retry after a crash).
// DELETE only while the post's text is still exactly what LumiLink posted.
// =============================================================================

import { GbpError } from "./gbp.ts";

export type PostCtx = {
  token: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Test only: replaces https://mybusiness.googleapis.com */
  base?: string;
  maxRetries?: number;
};

type LocalPost = { name?: string; summary?: string; state?: string; searchUrl?: string };

function base(ctx: PostCtx): string {
  return (ctx.base ?? "https://mybusiness.googleapis.com").replace(/\/+$/, "");
}

function parent(accountName: string, locationName: string): string {
  if (!/^accounts\/[^/?#]+$/.test(accountName) || !/^locations\/[^/?#]+$/.test(locationName)) {
    throw new GbpError("not_found", "bad location reference");
  }
  return `${accountName}/locations/${locationName.split("/")[1]}`;
}

async function call(ctx: PostCtx, method: "GET" | "POST" | "DELETE", url: string, body?: unknown): Promise<Record<string, unknown>> {
  const max = ctx.maxRetries ?? 3;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await ctx.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (attempt < max) {
        await ctx.sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new GbpError("transient", `Google request failed: ${String(e)}`);
    }
    if (res.ok) return (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const text = (await res.text().catch(() => "")).slice(0, 300);
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      // not JSON
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < max) {
        await ctx.sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new GbpError("transient", `Google ${res.status}: ${message}`);
    }
    if (res.status === 401) throw new GbpError("auth", `Google 401: ${message}`);
    if (res.status === 403) throw new GbpError("no_access", `Google 403: ${message}`);
    if (res.status === 404) throw new GbpError("not_found", `Google 404: ${message}`);
    throw new GbpError("user", `Google ${res.status}: ${message}`);
  }
}

export type CreateResult = { name: string; state: string | null; searchUrl: string | null; noop: boolean };

export async function createPost(ctx: PostCtx, accountName: string, locationName: string, summary: string): Promise<CreateResult> {
  const p = parent(accountName, locationName);
  const list = await call(ctx, "GET", `${base(ctx)}/v4/${p}/localPosts?pageSize=20`);
  const mine = ((list.localPosts ?? []) as LocalPost[]).find((x) => (x.summary ?? "").trim() === summary.trim() && x.name);
  if (mine) return { name: mine.name!, state: mine.state ?? null, searchUrl: mine.searchUrl ?? null, noop: true };

  const created = (await call(ctx, "POST", `${base(ctx)}/v4/${p}/localPosts`, {
    languageCode: "en-US",
    summary,
    topicType: "STANDARD",
  })) as LocalPost;
  if (!created.name) throw new GbpError("transient", "Google didn't return the new post's name");
  return { name: created.name, state: created.state ?? null, searchUrl: created.searchUrl ?? null, noop: false };
}

/** Delete our post, unless its text was changed on Google since. */
export async function deletePost(ctx: PostCtx, postName: string, written: string): Promise<{ noop: boolean }> {
  if (!/^accounts\/[^/?#]+\/locations\/[^/?#]+\/localPosts\/[^/?#]+$/.test(postName)) throw new GbpError("not_found", "bad post name");
  let live: LocalPost;
  try {
    live = (await call(ctx, "GET", `${base(ctx)}/v4/${postName}`)) as LocalPost;
  } catch (e) {
    if (e instanceof GbpError && e.kind === "not_found") return { noop: true };
    throw e;
  }
  if ((live.summary ?? "").trim() !== written.trim()) {
    throw new GbpError("drift", "the post was edited on Google since LumiLink published it, so LumiLink won't delete it");
  }
  await call(ctx, "DELETE", `${base(ctx)}/v4/${postName}`);
  return { noop: false };
}
