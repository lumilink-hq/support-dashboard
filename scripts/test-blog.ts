// =============================================================================
// test-blog.ts — unit tests for lib/blog.ts, plus a check of every real post.
//
//   npx tsx scripts/test-blog.ts
//
// The body whitelist is what makes /blog/<slug> safe to render as raw HTML,
// so it gets the most cases. The last section parses every file in
// content/blog, so a malformed post fails `npm run check` instead of the page.
// =============================================================================

import { checkMarkup, getAllPosts, parsePost } from "../lib/blog.ts";

let failures = 0;

function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function throws(label: string, fn: () => unknown, expect: string) {
  try {
    fn();
    ok(label, false, "did not throw");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(label, msg.includes(expect), msg);
  }
}

const post = (header: string, body = "<h2>Why</h2><p>Because.</p>") =>
  `---\n${header}\n---\n${body}\n`;

const BASE = "title: A Title\ndescription: A description.\ndate: 2026-10-06";

// ---------------------------------------------------------------------------
console.log("\nbody whitelist (same rule as seo-content's ALLOWED_TAG)");
// ---------------------------------------------------------------------------
ok("allows the module 16 tags", checkMarkup("<h2>a</h2><h3>b</h3><p><strong>c</strong> <em>d</em></p><ul><li>e</li></ul><ol><li>f</li></ol>") === null);
ok("refuses a link", checkMarkup('<p><a href="https://x">x</a></p>') !== null);
ok("refuses a script", checkMarkup("<script>alert(1)</script>") !== null);
ok("refuses an attribute on an allowed tag", checkMarkup('<p onclick="x">a</p>') !== null);
ok("refuses an img", checkMarkup('<img src="x">') !== null);
ok("refuses an unclosed tag", checkMarkup("<p>a") !== null);
ok("refuses a mismatched close", checkMarkup("<p><em>a</p></em>") !== null);
ok("refuses a stray <", checkMarkup("<p>1 < 2</p>") !== null);
ok("allows an escaped &lt;", checkMarkup("<p>1 &lt; 2</p>") === null);

// ---------------------------------------------------------------------------
console.log("\nparsePost");
// ---------------------------------------------------------------------------
{
  const p = parsePost("missed-calls", post(BASE));
  ok("reads the header", p.title === "A Title" && p.description === "A description." && p.date === "2026-10-06");
  ok("keeps the body", p.html === "<h2>Why</h2><p>Because.</p>");
  ok("optional fields default to null", p.updated === null && p.image === null && p.imageAlt === null);
}
ok("CRLF and a BOM are fine", parsePost("x", "﻿" + post(BASE).replace(/\n/g, "\r\n")).title === "A Title");
ok("a colon in the title is kept", parsePost("x", post(BASE.replace("A Title", "SEO: A Guide"))).title === "SEO: A Guide");
{
  const p = parsePost("x", post(`${BASE}\nupdated: 2026-10-20\nimage: https://cdn.example/a.png\nimageAlt: A van`));
  ok("reads optional fields", p.updated === "2026-10-20" && p.image === "https://cdn.example/a.png" && p.imageAlt === "A van");
}

throws("refuses a bad slug", () => parsePost("Missed_Calls", post(BASE)), "file name");
throws("refuses a missing header", () => parsePost("x", "<p>a</p>"), "header block");
throws("refuses a missing title", () => parsePost("x", post("description: d\ndate: 2026-10-06")), "title is required");
throws("refuses a missing description", () => parsePost("x", post("title: t\ndate: 2026-10-06")), "description is required");
throws("refuses an impossible date", () => parsePost("x", post(BASE.replace("2026-10-06", "2026-02-30"))), "real YYYY-MM-DD");
throws("refuses an unknown key (typo guard)", () => parsePost("x", post(`${BASE}\ndesciption: x`)), "unknown header key");
throws("refuses updated before date", () => parsePost("x", post(`${BASE}\nupdated: 2026-10-01`)), "earlier than date");
throws("refuses an http image", () => parsePost("x", post(`${BASE}\nimage: http://x/a.png\nimageAlt: a`)), "https://");
throws("refuses an image with no alt", () => parsePost("x", post(`${BASE}\nimage: https://x/a.png`)), "imageAlt is required");
throws("refuses an empty body", () => parsePost("x", post(BASE, "")), "body is empty");
throws("refuses a link in the body, naming the file", () => parsePost("x", post(BASE, '<p><a href="/">x</a></p>')), "content/blog/x.html");

// ---------------------------------------------------------------------------
console.log("\nevery post in content/blog");
// ---------------------------------------------------------------------------
{
  let posts: ReturnType<typeof getAllPosts> = [];
  try {
    posts = getAllPosts();
    ok(`all ${posts.length} post(s) parse`, true);
  } catch (e) {
    ok("all posts parse", false, e instanceof Error ? e.message : e);
  }
  for (let i = 1; i < posts.length; i++) {
    if (posts[i - 1].date < posts[i].date) ok("newest first", false, [posts[i - 1].slug, posts[i].slug]);
  }
}

console.log(failures === 0 ? "\nAll blog tests passed.\n" : `\n${failures} blog test(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
