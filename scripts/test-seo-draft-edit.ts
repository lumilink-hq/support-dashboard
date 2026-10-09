// =============================================================================
// test-seo-draft-edit.ts — unit tests for lib/seo-draft-edit.ts (editing a
// draft on /seo-approvals before approving it).
//
//   npx tsx scripts/test-seo-draft-edit.ts
// =============================================================================

import { editArticle, editPageFix, editTextToHtml, htmlToEditText } from "../lib/seo-draft-edit.ts";

let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

console.log("\nHTML ⇄ edit text");
{
  const html = "<p>Intro with <strong>bold</strong> and <em>italic</em> &amp; more.</p>\n<h2>First</h2>\n<p>Body.</p>\n<h3>Sub</h3>\n<ul><li>One</li><li>Two</li></ul>\n<ol><li>Step a</li><li>Step b</li></ol>";
  const text = htmlToEditText(html);
  ok("headings become ## / ###", text.includes("## First") && text.includes("### Sub"), text);
  ok("lists become - and 1.", text.includes("- One\n- Two") && text.includes("1. Step a\n2. Step b"), text);
  ok("inline becomes ** and *", text.includes("**bold**") && text.includes("*italic*"), text);
  ok("entities are decoded for editing", text.includes("& more"), text);
  const back = editTextToHtml(text);
  ok("round-trips to the same HTML (ignoring newlines)", back.replace(/\n/g, "") === html.replace(/\n/g, ""), back);
}
{
  const html = editTextToHtml("A <script>alert(1)</script> line\nwrapped\n\n## Head\n\n- a\n* b");
  ok("typed markup is escaped, never passed through", html.includes("&lt;script&gt;") && !html.includes("<script>"), html);
  ok("a wrapped paragraph joins into one <p>", html.startsWith("<p>A &lt;script&gt;alert(1)&lt;/script&gt; line wrapped</p>"), html);
  ok("- and * both start a bullet", html.includes("<ul><li>a</li><li>b</li></ul>"), html);
  ok("a lone * in prose is not italics", editTextToHtml("2 * 3 = 6") === "<p>2 * 3 = 6</p>");
}

console.log("\neditPageFix");
ok("a good title passes", editPageFix("title_tag", "LumiLink AI Receptionist for Small Businesses", null).ok);
{
  const r = editPageFix("title_tag", "Call us at 213-555-0100 today for a quote", null);
  ok("a phone number is refused, as for the model", !r.ok && r.reason.includes("phone"), r);
}
{
  const r = editPageFix("meta_description", "Short", null);
  ok("too short is refused with the length", !r.ok && /characters/.test(r.reason), r);
}
ok("unchanged from the live page is refused", !editPageFix("h1", "Same Heading Here", "same heading here").ok);
ok("schema can't be edited here", !editPageFix("local_business_schema", "{}", null).ok);

console.log("\neditArticle");
{
  const para = "Answering every call matters for a small business because a missed call is often a missed customer who simply rings the next name on the list. ";
  const body = [
    "Most small businesses lose calls at the worst moments, and an AI receptionist helps with that.",
    "## What an AI receptionist does",
    para.repeat(8),
    "## How to choose one",
    para.repeat(8),
    "- Check it books into your calendar\n- Check it hands off to a person",
  ].join("\n\n");
  const ctx = { keyword: "ai receptionist for small business", city: null };
  const r = editArticle({ title: "How an AI Receptionist Helps a Small Business", meta: "What an AI receptionist does for a small business, and the questions to ask before you choose one for your phones.", body }, ctx);
  ok("a valid edited article passes", r.ok, r);
  if (r.ok) {
    ok("the body is whitelisted HTML", r.body_html.startsWith("<p>") && r.body_html.includes("<h2>What an AI receptionist does</h2>"));
    ok("blocks and word count are rebuilt", r.blocks.some((b) => b.type === "li") && r.word_count > 450, r.word_count);
  }
  const claim = editArticle({ title: "How an AI Receptionist Helps a Small Business", meta: "What an AI receptionist does for a small business, and the questions to ask before you choose one for your phones.", body: body + "\n\nWe are fully licensed and insured." }, ctx);
  ok("an unbacked claim is refused, as for the model", !claim.ok, claim);
  const city = editArticle({ title: "How an AI Receptionist Helps a Small Business", meta: "What an AI receptionist does for a small business, and the questions to ask before you choose one for your phones.", body }, { ...ctx, city: "Tulsa" });
  ok("a local business's article must still name its city", !city.ok && city.reason.includes("Tulsa"), city);
  const short = editArticle({ title: "Short", meta: "x", body }, ctx);
  ok("title length is checked", !short.ok && short.reason.startsWith("title"), short);
}

console.log(failures === 0 ? "\nAll draft edit tests passed.\n" : `\n${failures} draft edit test(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
