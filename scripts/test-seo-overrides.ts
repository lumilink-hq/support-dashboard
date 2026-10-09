// =============================================================================
// test-seo-overrides.ts — lib/seo-overrides.ts, and the rule that every page
// the GitHub publisher may write a title or description for actually reads
// content/seo-overrides.json (otherwise an approved fix would be committed and
// silently do nothing).
//
//   npx tsx scripts/test-seo-overrides.ts
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { GITHUB_OVERRIDE_PATHS } from "../supabase/functions/seo-publish/github-lib.ts";
import { applySeoOverrides } from "../lib/seo-overrides.ts";

let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

console.log("\napplySeoOverrides");
{
  const base = { title: "Pricing | LumiLink", description: "Old.", alternates: { canonical: "/pricing" } };
  const none = applySeoOverrides("/pricing", base, {});
  ok("no override: unchanged", none === base);
  const both = applySeoOverrides("/pricing", base, { "/pricing": { title: "New Title | LumiLink", description: "New description." } });
  ok("title and description replaced", both.title === "New Title | LumiLink" && both.description === "New description.");
  ok("everything else kept", (both.alternates as { canonical: string }).canonical === "/pricing");
  const descOnly = applySeoOverrides("/pricing", base, { "/pricing": { description: "Only this." } });
  ok("a description-only override keeps the title", descOnly.title === "Pricing | LumiLink" && descOnly.description === "Only this.");
  const og = applySeoOverrides("/blog/x", { title: "T", openGraph: { type: "article", title: "T" } }, { "/blog/x": { title: "U" } });
  ok("Open Graph title follows", (og.openGraph as { title: string; type: string }).title === "U" && (og.openGraph as { type: string }).type === "article");
  ok("another page's override doesn't apply", applySeoOverrides("/contact", base, { "/pricing": { title: "X" } }) === base);
}

console.log("\nevery overridable page reads the overrides");
const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
for (const p of GITHUB_OVERRIDE_PATHS) {
  const file = path.join(root, "app", ...(p === "/" ? [] : p.slice(1).split("/")), "page.tsx");
  const src = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const call = `withSeoOverrides("${p}"`;
  ok(`${p} → ${path.relative(root, file)} calls ${call}`, src.includes(call));
}
{
  const src = fs.readFileSync(path.join(root, "app", "blog", "[slug]", "page.tsx"), "utf8");
  ok("/blog/<slug> calls withSeoOverrides(`/blog/${post.slug}`", src.includes("withSeoOverrides(`/blog/${post.slug}`"));
}

console.log(failures === 0 ? "\nAll SEO override tests passed.\n" : `\n${failures} SEO override test(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
