// =============================================================================
// test-seo-gbp-posts.ts — Business Profile posts: the drafting rules
// (seo-draft/posts.ts) and publishing/deleting (seo-publish/posts.ts) against
// a fake Google. No network, no Deno, no database.
//
//   npx tsx scripts/test-seo-gbp-posts.ts
// =============================================================================

import { buildPostPayload, POST_SYSTEM_PROMPT, POST_THEMES, postIdempotencyKey, themeFor, validateGbpPost } from "../supabase/functions/seo-draft/posts.ts";
import { createPost, deletePost, type PostCtx } from "../supabase/functions/seo-publish/posts.ts";
import { GbpError } from "../supabase/functions/seo-publish/gbp.ts";
import { emptyDetails } from "../supabase/functions/seo-content/details.ts";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean, got?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
  }
}
function eq(label: string, got: unknown, want: unknown) {
  ok(label, JSON.stringify(got) === JSON.stringify(want), got);
}

const details = { ...emptyDetails(), landmarks: ["the Hollywood Bowl"], service_areas: ["Los Feliz"], services: ["Free parking", "ATM on site"], licensed: true };
const ctx = { businessName: "PACKS Hollywood", details, avoidOpenings: ["Our Cahuenga Boulevard store is just minutes from the Bowl."] };
const good =
  "Heading to a show at the Hollywood Bowl this weekend? Our Cahuenga Boulevard store is a short drive away, with an ATM on site and a team that is happy to help first-time visitors find their way around.";

async function main() {
  // --- themes, prompt, payload -------------------------------------------------
  const weeks = [0, 1, 2, 3].map((w) => themeFor(new Date(Date.UTC(2026, 10, 2) + w * 7 * 86_400_000)));
  eq("themes rotate through all four, one a week", [...new Set(weeks)].sort(), [...POST_THEMES].sort());
  ok("theme offset gives a different theme", themeFor(new Date(), 0) !== themeFor(new Date(), 1));
  ok("prompt: regulated goods, no products or calls to action", /Never mention or describe any product/.test(POST_SYSTEM_PROMPT) && /No calls to action/.test(POST_SYSTEM_PROMPT));
  const payload = JSON.parse(buildPostPayload({ name: "PACKS Hollywood", city: "Los Angeles", theme: "neighbourhood", details, avoidOpenings: ["Hello Hollywood friends and neighbours, welcome"] }));
  eq("payload: our facts and the theme", [payload.business_name, payload.theme, payload.nearby_landmarks], ["PACKS Hollywood", "neighbourhood", ["the Hollywood Bowl"]]);
  eq("payload: openings shortened to compare", payload.avoid_openings, ["hello hollywood friends and neighbours"]);
  eq("key: one per store per week", postIdempotencyKey("loc1", new Date(Date.UTC(2026, 10, 2))), postIdempotencyKey("loc1", new Date(Date.UTC(2026, 10, 3))));

  // --- validator: the restricted-content line ---------------------------------
  ok("valid: neighbourhood post", validateGbpPost(good, ctx).ok, validateGbpPost(good, ctx));
  const product = (s: string) => validateGbpPost(`${good} ${s}`, { ...ctx, avoidOpenings: [] });
  for (const word of ["Try our new pre-rolls.", "Fresh flower in stock.", "Gummies are back.", "High THC options.", "Our vapes are popular.", "Sativa lovers welcome."]) {
    ok(`refused: product (${word})`, !product(word).ok && /regulated products/.test((product(word) as { reason: string }).reason), product(word));
  }
  for (const cta of ["Order ahead today.", "Shop now.", "Check our menu.", "Call us today.", "Buy in store.", "Limited time only."]) {
    ok(`refused: call to action (${cta})`, !product(cta).ok, product(cta));
  }
  eq("refused: price", product("Everything $20 this week.").ok, false);
  eq("refused: health claim", product("It helps relieve stress.").ok, false);
  eq("refused: link", product("See packsclub.com.").ok, false);
  eq("refused: phone", product("Questions? (323) 555-0100.").ok, false);
  eq("refused: same opening as a recent post", validateGbpPost("Our Cahuenga Boulevard store is just minutes from the Bowl, so stop by and say hello to the team on your way.", ctx).reason, "post opens the same way as a recent post");
  eq("refused: unbacked claim", validateGbpPost(good + " We're family-owned.", { ...ctx, avoidOpenings: [] }).ok, false);
  ok("allowed: a claim the intake vouches for", validateGbpPost(good + " We're a licensed store.", { ...ctx, avoidOpenings: [] }).ok);
  eq("refused: too short", validateGbpPost("Come say hi at our Hollywood store.", ctx).ok, false);
  eq("refused: model said too thin", validateGbpPost("INSUFFICIENT_FACTS", ctx).reason, "model reported insufficient facts");

  // --- publishing against a fake Google ----------------------------------------
  type Call = { method: string; url: string; body?: unknown };
  function fakeGoogle(opts: { existing?: { name: string; summary: string }[]; status?: number }) {
    const state = { posts: [...(opts.existing ?? [])], calls: [] as Call[] };
    const doFetch = (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      state.calls.push({ method: String(init.method), url, body });
      if (opts.status) return new Response(JSON.stringify({ error: { message: "nope" } }), { status: opts.status });
      const u = new URL(url);
      if (init.method === "GET" && u.pathname.endsWith("/localPosts")) return new Response(JSON.stringify({ localPosts: state.posts }), { status: 200 });
      if (init.method === "POST") {
        const p = { name: `accounts/9/locations/1/localPosts/p${state.posts.length + 1}`, summary: body.summary, state: "LIVE" };
        state.posts.push(p);
        return new Response(JSON.stringify(p), { status: 200 });
      }
      const p = state.posts.find((x) => u.pathname.endsWith(x.name));
      if (!p) return new Response(JSON.stringify({ error: { message: "gone" } }), { status: 404 });
      if (init.method === "DELETE") {
        state.posts = state.posts.filter((x) => x !== p);
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify(p), { status: 200 });
    }) as unknown as typeof fetch;
    return { state, ctx: { token: "t", fetch: doFetch, sleep: async () => {}, base: "https://fake" } as PostCtx };
  }
  {
    const g = fakeGoogle({});
    const r = await createPost(g.ctx, "accounts/9", "locations/1", good);
    eq("create: new post", [r.noop, r.state, r.name], [false, "LIVE", "accounts/9/locations/1/localPosts/p1"]);
    const post = g.state.calls.find((c) => c.method === "POST")!;
    eq("create: endpoint", post.url, "https://fake/v4/accounts/9/locations/1/localPosts");
    eq("create: plain update, no button, link or image", post.body, { languageCode: "en-US", summary: good, topicType: "STANDARD" });
    const again = await createPost(g.ctx, "accounts/9", "locations/1", good);
    eq("create: a retry finds it and doesn't post twice", [again.noop, g.state.posts.length], [true, 1]);
    eq("delete: removes ours", await deletePost(g.ctx, "accounts/9/locations/1/localPosts/p1", good), { noop: false });
    eq("delete: gone", g.state.posts.length, 0);
    eq("delete: already gone is a no-op", await deletePost(g.ctx, "accounts/9/locations/1/localPosts/p1", good), { noop: true });
  }
  {
    const g = fakeGoogle({ existing: [{ name: "accounts/9/locations/1/localPosts/p1", summary: "Edited by the owner." }] });
    let kind = "";
    try {
      await deletePost(g.ctx, "accounts/9/locations/1/localPosts/p1", good);
    } catch (e) {
      kind = e instanceof GbpError ? e.kind : "other";
    }
    eq("delete: refuses after an edit on Google", [kind, g.state.posts.length], ["drift", 1]);
  }
  {
    const g = fakeGoogle({ status: 400 });
    let kind = "";
    try {
      await createPost(g.ctx, "accounts/9", "locations/1", good);
    } catch (e) {
      kind = e instanceof GbpError ? e.kind : "other";
    }
    eq("create: Google refusing is reported, not retried", [kind, g.state.calls.length], ["user", 1]);
  }
  {
    let threw = false;
    try {
      await deletePost(fakeGoogle({}).ctx, "../../accounts", good);
    } catch {
      threw = true;
    }
    ok("delete: a malformed post name is refused before any call", threw);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
