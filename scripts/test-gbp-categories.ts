// test-gbp-categories.ts — lib/gbp-categories.ts (the category picker, 0081).
//   npx tsx scripts/test-gbp-categories.ts
import { cleanQuery, currentCategories, decodePick, encodePick, parseCategories } from "../lib/gbp-categories";

let passed = 0;
let failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label} — got ${JSON.stringify(got)}`);
  }
}

eq("parse: keeps real category ids", parseCategories({ categories: [
  { name: "categories/gcid:cannabis_store", displayName: "Cannabis store" },
  { name: "gcid:bad", displayName: "Bad" },
  { name: "categories/gcid:x", displayName: " " },
  { name: "categories/gcid:Robots", displayName: "Upper" },
] }), [{ name: "categories/gcid:cannabis_store", displayName: "Cannabis store" }]);
eq("parse: empty", parseCategories(null), []);
eq("current: primary and additional", currentCategories({
  primaryCategory: { name: "categories/gcid:cannabis_store", displayName: "Cannabis store" },
  additionalCategories: [{ name: "categories/gcid:cannabis_delivery", displayName: "Cannabis delivery" }],
}), { primary: { name: "categories/gcid:cannabis_store", displayName: "Cannabis store" }, additional: [{ name: "categories/gcid:cannabis_delivery", displayName: "Cannabis delivery" }] });
eq("current: nothing stored", currentCategories(undefined), { primary: null, additional: [] });
const c = { name: "categories/gcid:medical_marijuana_dispensary", displayName: "Medical | marijuana dispensary" };
eq("pick: round trip (a | in the label is fine)", decodePick(encodePick(c)), c);
eq("pick: forged id refused", decodePick("categories/gcid:bank'; drop|Bank"), null);
eq("pick: no label refused", decodePick("categories/gcid:bank|"), null);
eq("query: trimmed", cleanQuery("  cannabis   store "), "cannabis store");
eq("query: symbols stripped", cleanQuery("can<script>"), "can script");
eq("query: too short", cleanQuery("a"), null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
