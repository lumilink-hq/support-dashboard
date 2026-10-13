// =============================================================================
// seo-publish/reviews.ts — module 4 part 3: posting an approved reply to a
// Google review, and taking it down again. Google My Business API v4
// (mybusiness.googleapis.com), the only API that serves reviews.
// `fetch` and `sleep` are injected (scripts/test-seo-review-replies.ts).
//
// NEVER OVERWRITES. Before posting, the review is read: if it already has a
// reply (the owner answered on Google meanwhile), nothing is posted. If the
// reply is exactly ours (a retry after a crash), it's a no-op.
//
// ROLLBACK deletes the reply only while it is still exactly what LumiLink
// posted; a reply edited on Google since is the owner's and stays.
//
// Errors and backoff reuse seo-publish/gbp.ts's GbpError kinds (rule 6).
// =============================================================================

import { GbpError } from "./gbp.ts";

export type ReviewCtx = {
  token: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Test only: replaces https://mybusiness.googleapis.com */
  base?: string;
  maxRetries?: number;
};

export type ReviewRef = { account_name: string; location_name: string; review_id: string };

function reviewUrl(ctx: ReviewCtx, ref: ReviewRef): string {
  if (!/^accounts\/[^/?#]+$/.test(ref.account_name) || !/^locations\/[^/?#]+$/.test(ref.location_name) || !/^[A-Za-z0-9_-]+$/.test(ref.review_id)) {
    throw new GbpError("not_found", "bad review reference");
  }
  const base = (ctx.base ?? "https://mybusiness.googleapis.com").replace(/\/+$/, "");
  const loc = ref.location_name.split("/")[1];
  return `${base}/v4/${ref.account_name}/locations/${loc}/reviews/${ref.review_id}`;
}

async function call(ctx: ReviewCtx, method: "GET" | "PUT" | "DELETE", url: string, body?: unknown): Promise<Record<string, unknown>> {
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

/** The review's current reply on Google, or null. */
export async function readReply(ctx: ReviewCtx, ref: ReviewRef): Promise<string | null> {
  const r = await call(ctx, "GET", reviewUrl(ctx, ref));
  const reply = (r.reviewReply as { comment?: string } | undefined)?.comment;
  return typeof reply === "string" && reply.trim() ? reply : null;
}

export type PostResult = { noop: boolean; verified: boolean };

export async function postReply(ctx: ReviewCtx, ref: ReviewRef, text: string): Promise<PostResult> {
  const existing = await readReply(ctx, ref);
  if (existing !== null) {
    if (existing.trim() === text.trim()) return { noop: true, verified: true };
    throw new GbpError("drift", "this review already has a reply on Google, so LumiLink didn't post another");
  }
  await call(ctx, "PUT", `${reviewUrl(ctx, ref)}/reply`, { comment: text });
  const after = await readReply(ctx, ref);
  return { noop: false, verified: (after ?? "").trim() === text.trim() };
}

/** Take our reply down, unless it was changed on Google since. */
export async function deleteReply(ctx: ReviewCtx, ref: ReviewRef, written: string): Promise<{ noop: boolean }> {
  const live = await readReply(ctx, ref);
  if (live === null) return { noop: true };
  if (live.trim() !== written.trim()) {
    throw new GbpError("drift", "the reply was edited on Google since LumiLink posted it, so LumiLink won't delete it");
  }
  await call(ctx, "DELETE", `${reviewUrl(ctx, ref)}/reply`);
  return { noop: false };
}
