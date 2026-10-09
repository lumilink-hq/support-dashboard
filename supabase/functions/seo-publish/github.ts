// =============================================================================
// github.ts — the network half of the GitHub publisher: the repository
// Contents API (read, write and delete one file, each a commit) and the
// heartbeat. `fetch` and `sleep` come in through the context so
// scripts/test-seo-publish-github.ts can drive it with a fake GitHub.
//
// The credential is a fine-grained personal access token limited to the one
// repository with "Contents: read and write" (stored in Vault like the
// Shopify token; see scripts/connect-github-site.sql).
// =============================================================================

export type GithubErrorKind = "auth" | "scope" | "not_found" | "conflict" | "transient";

export class GithubError extends Error {
  constructor(public kind: GithubErrorKind, message: string) {
    super(message);
  }
}

export type GhCtx = {
  repo: string; // owner/name
  branch: string;
  token: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Defaults to https://api.github.com; a local mock in testing (SEO_GITHUB_API_URL). */
  apiBase?: string;
};

const DEFAULT_API = "https://api.github.com";
const api = (ctx: GhCtx) => (ctx.apiBase || DEFAULT_API).replace(/\/+$/, "");
const MAX_TRIES = 4;

function b64encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64decode(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

async function call<T>(ctx: GhCtx, method: string, url: string, body?: unknown): Promise<{ status: number; data: T | null }> {
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let res: Response;
    try {
      res = await ctx.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "LumiLink-SEO-Publisher",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      await ctx.sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
    if (res.status >= 500 || rateLimited) {
      lastError = `GitHub ${res.status}`;
      await ctx.sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    const text = await res.text();
    const data = text ? (JSON.parse(text) as T) : null;
    const message = (data as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new GithubError("auth", `GitHub rejected the token: ${message}`);
    if (res.status === 403) throw new GithubError("scope", `The token can't do this: ${message}`);
    if (res.status === 409 || res.status === 422) throw new GithubError("conflict", `GitHub refused the write: ${message}`);
    if (res.status === 404) return { status: 404, data: null };
    if (res.status >= 400) throw new GithubError("transient", `GitHub ${res.status}: ${message}`);
    return { status: res.status, data };
  }
  throw new GithubError("transient", lastError || "GitHub did not answer");
}

/** Heartbeat: can this token push to the repository? */
export async function checkRepo(ctx: GhCtx): Promise<{ push: boolean; defaultBranch: string | null }> {
  const r = await call<{ permissions?: { push?: boolean }; default_branch?: string }>(ctx, "GET", `${api(ctx)}/repos/${ctx.repo}`);
  if (r.status === 404) throw new GithubError("not_found", `Repository ${ctx.repo} not found, or the token can't see it`);
  return { push: !!r.data?.permissions?.push, defaultBranch: r.data?.default_branch ?? null };
}

export type RepoFile = { sha: string; text: string };

export async function readFile(ctx: GhCtx, path: string): Promise<RepoFile | null> {
  const r = await call<{ sha: string; content?: string; encoding?: string; type?: string }>(
    ctx,
    "GET",
    `${api(ctx)}/repos/${ctx.repo}/contents/${enc(path)}?ref=${encodeURIComponent(ctx.branch)}`,
  );
  if (r.status === 404 || !r.data) return null;
  if (r.data.type && r.data.type !== "file") throw new GithubError("conflict", `${path} is not a file`);
  return { sha: r.data.sha, text: r.data.encoding === "base64" && r.data.content ? b64decode(r.data.content) : "" };
}

/** Create (sha null) or replace (sha of the version read) one file: one commit. */
export async function writeFile(ctx: GhCtx, path: string, text: string, message: string, sha: string | null): Promise<{ sha: string; commit: string }> {
  const r = await call<{ content: { sha: string }; commit: { sha: string } }>(ctx, "PUT", `${api(ctx)}/repos/${ctx.repo}/contents/${enc(path)}`, {
    message,
    content: b64encode(text),
    branch: ctx.branch,
    ...(sha ? { sha } : {}),
  });
  if (!r.data) throw new GithubError("not_found", `Could not write ${path}: branch ${ctx.branch} not found`);
  return { sha: r.data.content.sha, commit: r.data.commit.sha };
}

export async function deleteFile(ctx: GhCtx, path: string, sha: string, message: string): Promise<{ commit: string } | null> {
  const r = await call<{ commit: { sha: string } }>(ctx, "DELETE", `${api(ctx)}/repos/${ctx.repo}/contents/${enc(path)}`, {
    message,
    sha,
    branch: ctx.branch,
  });
  return r.data ? { commit: r.data.commit.sha } : null;
}
