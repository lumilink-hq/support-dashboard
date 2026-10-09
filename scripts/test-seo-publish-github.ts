// =============================================================================
// test-seo-publish-github.ts — the GitHub publisher's pure rules
// (seo-publish/github-lib.ts) and its Contents API client (github.ts) against
// an in-memory fake GitHub. No network.
//
//   npx tsx scripts/test-seo-publish-github.ts
// =============================================================================

import {
  articleFile,
  decideGithub,
  freeSlug,
  githubManualInstructions,
  overridablePath,
  parseOverrides,
  pathOnSite,
  revertOverride,
  serializeOverrides,
  setOverride,
} from "../supabase/functions/seo-publish/github-lib.ts";
import { checkRepo, deleteFile, GithubError, readFile, writeFile, type GhCtx } from "../supabase/functions/seo-publish/github.ts";
import { parsePost } from "../lib/blog.ts";

let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
async function rejects(label: string, p: Promise<unknown>, kind: string) {
  try {
    await p;
    ok(label, false, "did not throw");
  } catch (e) {
    ok(label, e instanceof GithubError && e.kind === kind, e instanceof GithubError ? e.kind : String(e));
  }
}

const conn = { status: "healthy", site_hosts: ["www.lumilinkhub.com"] };

console.log("\ndecideGithub");
ok("title on a supported page: api", JSON.stringify(decideGithub({ target_field: "title_tag", target_url: "https://www.lumilinkhub.com/pricing" }, conn)) === JSON.stringify({ mode: "api", path: "/pricing", key: "title" }));
ok("meta on the homepage: api", (decideGithub({ target_field: "meta_description", target_url: "https://lumilinkhub.com/" }, conn) as { path?: string }).path === "/");
ok("a blog post: api", decideGithub({ target_field: "title_tag", target_url: "https://www.lumilinkhub.com/blog/show-up-in-chatgpt" }, conn).mode === "api");
ok("a trailing slash is the same page", (decideGithub({ target_field: "title_tag", target_url: "https://www.lumilinkhub.com/pricing/" }, conn) as { path?: string }).path === "/pricing");
const reason = (f: string, u: string | null, c: typeof conn | null = conn) => (decideGithub({ target_field: f, target_url: u }, c) as { reason?: string }).reason;
ok("H1 is a code change", reason("h1", "https://www.lumilinkhub.com/pricing") === "code_change");
ok("schema is a code change", reason("local_business_schema", "https://www.lumilinkhub.com/") === "code_change");
ok("a page without the hook: manual", reason("title_tag", "https://www.lumilinkhub.com/demo/orders") === "page_not_overridable");
ok("another site: manual", reason("title_tag", "https://smith.ai/pricing") === "url_not_on_site");
ok("revoked: manual", reason("title_tag", "https://www.lumilinkhub.com/pricing", { ...conn, status: "revoked" }) === "connection_revoked");
ok("no connection: manual", reason("title_tag", "https://www.lumilinkhub.com/pricing", null) === "no_site_connection");
ok("pathOnSite ignores www and query", pathOnSite("https://lumilinkhub.com/story?utm=x", ["www.lumilinkhub.com"]) === "/story");
ok("overridablePath refuses a nested blog path", !overridablePath("/blog/a/b"));

console.log("\noverrides file");
{
  const start = parseOverrides('{"/pricing":{"title":"Old"},"bad":{"title":"x"},"/x":{"title":3}}');
  ok("lenient parse drops junk", JSON.stringify(start) === JSON.stringify({ "/pricing": { title: "Old" } }), start);
  ok("bad JSON is empty", JSON.stringify(parseOverrides("{nope")) === "{}");
  const { next, prior } = setOverride(start, "/pricing", "description", "New desc.");
  ok("set records the prior (none)", prior === null && next["/pricing"].title === "Old" && next["/pricing"].description === "New desc.");
  const s1 = serializeOverrides({ "/z": { title: "Z" }, "/a": { description: "A", title: "T" } });
  ok("serialised sorted, title before description, trailing newline", s1 === '{\n  "/a": {\n    "title": "T",\n    "description": "A"\n  },\n  "/z": {\n    "title": "Z"\n  }\n}\n', s1);
  const undone = revertOverride(next, "/pricing", "description", "New desc.", null);
  ok("revert removes a key that wasn't there", undone !== "drift" && !("description" in undone.next["/pricing"]));
  const restored = revertOverride(setOverride(start, "/pricing", "title", "New").next, "/pricing", "title", "New", "Old");
  ok("revert restores the prior value", restored !== "drift" && restored.next["/pricing"].title === "Old");
  const empty = revertOverride({ "/story": { title: "Mine" } }, "/story", "title", "Mine", null);
  ok("revert drops an emptied page entry", empty !== "drift" && !("/story" in empty.next));
  ok("revert refuses when someone changed it since", revertOverride(next, "/pricing", "description", "Something else", null) === "drift");
}

console.log("\narticle file");
{
  const file = articleFile({
    title: "How to Show Up in ChatGPT",
    meta_description: "Six steps\nto get cited.",
    body_html: "<h2>One</h2><p>Text.</p>",
    date: "2026-10-09",
    image: { url: "https://cdn.example/a.png", alt: "A laptop" },
  });
  const post = parsePost("how-to-show-up-in-chatgpt", file);
  ok("lib/blog.ts reads what the publisher writes", post.title === "How to Show Up in ChatGPT" && post.date === "2026-10-09" && post.image === "https://cdn.example/a.png" && post.imageAlt === "A laptop");
  ok("a line break in the meta can't break the header", post.description === "Six steps to get cited.");
  const noImg = parsePost("x", articleFile({ title: "T title here", meta_description: "D", body_html: "<p>x</p>", date: "2026-10-09", image: { url: "http://insecure", alt: "a" } }));
  ok("a non-https image is left out rather than failing the blog", noImg.image === null);
  ok("freeSlug skips taken slugs", freeSlug("a", (s) => s === "a" || s === "a-2") === "a-3");
  const m = githubManualInstructions({ target_field: "h1", target_url: "https://www.lumilinkhub.com/pricing", proposed: "New H1" }, "code_change");
  ok("manual steps name the page and give the text", m.steps[0].includes("/pricing") && m.copy.text === "New H1");
}

// -----------------------------------------------------------------------------
// github.ts against a fake GitHub
// -----------------------------------------------------------------------------
type FakeFile = { sha: string; text: string };
function fakeGithub(opts: { token?: string; push?: boolean; failFirst?: number; rateLimitFirst?: number } = {}) {
  const files = new Map<string, FakeFile>();
  let n = 0;
  let fails = opts.failFirst ?? 0;
  let limited = opts.rateLimitFirst ?? 0;
  const commits: string[] = [];
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === null ? "" : JSON.stringify(body), { status, headers });
  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (fails > 0) {
      fails--;
      return json(502, { message: "bad gateway" });
    }
    if (limited > 0) {
      limited--;
      return json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" });
    }
    if (auth !== `Bearer ${opts.token ?? "good"}`) return json(401, { message: "Bad credentials" });
    if (url.pathname === "/repos/o/r") return json(200, { permissions: { push: opts.push ?? true }, default_branch: "main" });
    const m = url.pathname.match(/^\/repos\/o\/r\/contents\/(.+)$/);
    if (!m) return json(404, { message: "Not Found" });
    const path = decodeURIComponent(m[1]);
    const cur = files.get(path);
    if (method === "GET") return cur ? json(200, { type: "file", sha: cur.sha, encoding: "base64", content: Buffer.from(cur.text).toString("base64") }) : json(404, { message: "Not Found" });
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (opts.push === false) return json(403, { message: "Resource not accessible by personal access token" });
    if (method === "PUT") {
      if ((cur?.sha ?? null) !== (body.sha ?? null)) return json(409, { message: `${path} does not match ${body.sha}` });
      const sha = `sha${++n}`;
      files.set(path, { sha, text: Buffer.from(body.content, "base64").toString("utf8") });
      commits.push(body.message);
      return json(cur ? 200 : 201, { content: { sha }, commit: { sha: `c${n}` } });
    }
    if (method === "DELETE") {
      if (!cur || cur.sha !== body.sha) return json(409, { message: "sha mismatch" });
      files.delete(path);
      commits.push(body.message);
      return json(200, { commit: { sha: `c${++n}` } });
    }
    return json(404, { message: "Not Found" });
  };
  return { files, commits, fetch: f };
}
const ctxFor = (gh: ReturnType<typeof fakeGithub>, token = "good"): GhCtx => ({ repo: "o/r", branch: "main", token, fetch: gh.fetch, sleep: async () => {}, apiBase: "https://api.test" });

// tsx runs this as CommonJS, which has no top-level await.
async function main() {
console.log("\ngithub.ts");
{
  const gh = fakeGithub();
  const ctx = ctxFor(gh);
  ok("checkRepo reports push", (await checkRepo(ctx)).push === true);
  ok("a missing file reads as null", (await readFile(ctx, "content/seo-overrides.json")) === null);
  const w = await writeFile(ctx, "content/blog/a.html", "héllo — “quotes”\n", "add a", null);
  const r = await readFile(ctx, "content/blog/a.html");
  ok("UTF-8 survives the base64 round trip", r?.text === "héllo — “quotes”\n" && r.sha === w.sha);
  await rejects("writing over a file with a stale sha is a conflict", writeFile(ctx, "content/blog/a.html", "x", "m", "stale"), "conflict");
  await rejects("creating a file that exists is a conflict", writeFile(ctx, "content/blog/a.html", "x", "m", null), "conflict");
  await writeFile(ctx, "content/blog/a.html", "v2", "update a", w.sha);
  ok("replace with the current sha works", (await readFile(ctx, "content/blog/a.html"))?.text === "v2");
  const cur = await readFile(ctx, "content/blog/a.html");
  await deleteFile(ctx, "content/blog/a.html", cur!.sha, "remove a");
  ok("delete removes it", (await readFile(ctx, "content/blog/a.html")) === null && gh.commits.length === 3);
  await rejects("a bad token is auth", checkRepo(ctxFor(gh, "bad")), "auth");
}
{
  const gh = fakeGithub({ push: false });
  ok("read-only token: checkRepo says no push", (await checkRepo(ctxFor(gh))).push === false);
  await rejects("read-only token: a write is scope", writeFile(ctxFor(gh), "content/x", "x", "m", null), "scope");
}
{
  const gh = fakeGithub({ failFirst: 2 });
  ok("5xx is retried, then succeeds", (await checkRepo(ctxFor(gh))).push === true);
  const limited = fakeGithub({ rateLimitFirst: 1 });
  ok("a rate-limit 403 is retried, not read as scope", (await checkRepo(ctxFor(limited))).push === true);
  await rejects("five failures in a row is transient", checkRepo(ctxFor(fakeGithub({ failFirst: 9 }))), "transient");
}
}

main().then(() => {
  console.log(failures === 0 ? "\nAll GitHub publisher tests passed.\n" : `\n${failures} GitHub publisher test(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
});
