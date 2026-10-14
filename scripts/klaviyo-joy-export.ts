// =============================================================================
// klaviyo-joy-export.ts — pull Joy's member balances and tiers out of Klaviyo
// (Joy syncs "Joy Loyalty Points" / "Joy Vip tier" onto every member's
// profile) into a CSV that scripts/joy-import.ts reads. Used because Joy's
// own API needs the Ultimate plan. Runbook: docs/loyalty/CUTOVER.md.
//
//   npx tsx --env-file=.env.local scripts/klaviyo-joy-export.ts <out.csv> [--segments id,id,id]
//
// Needs KLAVIYO_API_KEY (a private key with profiles:read and segments:read).
// --segments: the Klaviyo segments that hold Joy members. Default: Tsunami's
// "Wave Rewards: Bronze / Silver / Gold VIP Members" (VSKL8f, QWq9sQ, VmMXUE),
// each defined as Joy Vip tier = that tier.
//
// The CSV is customer PII: it must be written OUTSIDE the repo (refused
// otherwise), and deleted when the import/compare is done. Output here is
// counts only.
// =============================================================================

import { writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { dedupe, type Profile, type Row, rowFromProfile, toCsv } from "./klaviyo-joy-export-lib.ts";
import { parseJoyExport } from "./joy-import-lib.ts";

const REVISION = "2026-07-15";
const DEFAULT_SEGMENTS = ["VSKL8f", "QWq9sQ", "VmMXUE"];

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, key: string): Promise<{ data: Profile[]; links?: { next?: string | null } }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Klaviyo-API-Key ${key}`, accept: "application/vnd.api+json", revision: REVISION } });
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get("retry-after")) || 2;
      await sleep(Math.min(wait, 30) * 1000);
      continue;
    }
    const body = await res.text();
    if (!res.ok) die(`Klaviyo ${res.status}: ${body.slice(0, 300)}`);
    return JSON.parse(body);
  }
  die("Klaviyo kept throttling");
}

async function main() {
  const out = process.argv[2];
  if (!out || out.startsWith("--")) die("usage: klaviyo-joy-export.ts <out.csv> [--segments id,id,id]");
  const repo = resolve(".");
  const target = resolve(out);
  if (target === repo || target.startsWith(repo + sep)) die(`write the export OUTSIDE the repo (customer PII): ${target}`);
  const key = process.env.KLAVIYO_API_KEY;
  if (!key) die("KLAVIYO_API_KEY is not set (run with --env-file=.env.local)");
  const i = process.argv.indexOf("--segments");
  const segments = i > -1 ? String(process.argv[i + 1] ?? "").split(",").filter(Boolean) : DEFAULT_SEGMENTS;

  const rows: Row[] = [];
  const skipped = new Map<string, number>();
  for (const seg of segments) {
    let url: string | null | undefined =
      `https://a.klaviyo.com/api/segments/${seg}/profiles?fields[profile]=email,first_name,last_name,properties&page[size]=100`;
    let n = 0;
    while (url) {
      const page = await get(url, key);
      for (const p of page.data) {
        const r = rowFromProfile(p);
        if ("row" in r) { rows.push(r.row); n++; } else skipped.set(r.skip, (skipped.get(r.skip) ?? 0) + 1);
      }
      url = page.links?.next;
    }
    console.log(`segment ${seg}: ${n} profiles`);
  }

  const { rows: unique, duplicates } = dedupe(rows);
  const csv = toCsv(unique);
  writeFileSync(target, csv, "utf8");

  // Read it back exactly as joy-import.ts will.
  const parsed = parseJoyExport(csv);
  const tiers = new Map<string, number>();
  for (const r of parsed.rows) tiers.set(r.tier_name ?? "(none)", (tiers.get(r.tier_name ?? "(none)") ?? 0) + 1);
  console.log(`\nwrote ${unique.length} members to ${target}`);
  console.log(`tiers: ${[...tiers].map(([t, c]) => `${t} ${c}`).join(", ")}`);
  console.log(`points total ${parsed.rows.reduce((a, r) => a + r.points, 0).toLocaleString("en-US")}, with a birthday ${parsed.rows.filter((r) => r.birthday).length}`);
  if (duplicates) console.log(`duplicates across segments (first kept): ${duplicates}`);
  for (const [why, c] of skipped) console.log(`skipped (${why}): ${c}`);
  console.log(`importer check: ${parsed.rows.length} usable rows, ${parsed.problems.length} problems`);
  const kinds = new Map<string, number>();
  for (const p of parsed.problems) { const k = p.message.replace(/".*"/, '"…"').replace(/\(.*\)/, "(…)"); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
  for (const [k, c] of kinds) console.log(`  ${c} x ${k}`);
  console.log(`\nNext: npx tsx scripts/joy-import.ts ${out} --program <id> --kind import|compare --taken-at ${new Date().toISOString()}`);
  console.log("Delete the file when done.");
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
