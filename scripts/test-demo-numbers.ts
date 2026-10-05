// Guards the rule that a paying client's phone number never appears on a public
// page. /demo/hvac hardcoded Tsunami's line for weeks and nothing caught it —
// a comment saying "don't" does not survive a copy-paste, a failing check does.
//
//   npx tsx scripts/test-demo-numbers.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_NUMBERS_DO_NOT_PUBLISH, DEMO_LINES } from "../lib/demo";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** Every source file under the public-facing trees. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|html)$/.test(p)) out.push(p);
  }
  return out;
}

const files = [
  ...walk("app"),
  ...walk("components"),
  ...walk("demo"),
].filter((f) => f !== "lib/demo.ts");

console.log("no client number is printed on a public page");
for (const forbidden of CLIENT_NUMBERS_DO_NOT_PUBLISH) {
  // Match the digits in any punctuation: +12135332469, (213) 533-2469, 213.533.2469
  const digits = forbidden.replace(/\D/g, "").slice(-10);
  const loose = new RegExp(digits.split("").join("\\D*"));
  const hits = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    // A line that only mentions it in prose (a comment recording the incident)
    // is fine; a tel: link or a rendered string is not.
    return src
      .split("\n")
      .some((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && loose.test(l));
  });
  check(`${forbidden} appears in no rendered markup`, hits.length === 0, hits.join(", "));
}

console.log("\ndemo lines are configured and distinct");
check("ecommerce line set", Boolean(DEMO_LINES.ecommerce.tel));
check("service line set", Boolean(DEMO_LINES.service.tel));
check(
  "the two verticals use DIFFERENT numbers",
  DEMO_LINES.ecommerce.tel !== DEMO_LINES.service.tel,
  "resolve_client_by_number returns one client — a shared number sends one vertical to the wrong agent",
);
check(
  "the two verticals use different tenants",
  DEMO_LINES.ecommerce.slug !== DEMO_LINES.service.slug,
);
for (const [k, v] of Object.entries(DEMO_LINES)) {
  check(`${k} tel is E.164`, /^\+\d{10,15}$/.test(v.tel), v.tel);
  check(
    `${k} display matches tel`,
    v.display.replace(/\D/g, "") === v.tel.replace(/\D/g, "").slice(-10),
    `${v.display} vs ${v.tel}`,
  );
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
