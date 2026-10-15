// =============================================================================
// joy-import.ts — load a Joy export into LL Loyalty (0207) and import it or
// compare against it. Runbook: docs/loyalty/CUTOVER.md.
//
//   npx tsx scripts/joy-import.ts <export.csv> --program <id> --kind import|compare --taken-at <ISO>
//       DRY RUN (default): parses and reports, no network.
//   ... --apply
//       Loads the rows and runs the import or compare. Needs, EXPLICITLY:
//         LOYALTY_SUPABASE_URL   e.g. https://<ref>.supabase.co (or the local stack)
//         LOYALTY_SERVICE_KEY    that project's service role key
//       Deliberately not NEXT_PUBLIC_SUPABASE_URL / .env.local, so production
//       is never hit by accident.
//   npx tsx scripts/joy-import.ts --purge <snapshot id>      (with the env above)
//       Deletes the snapshot's rows (names, emails) once you're done with it.
//
// Keep export files OUT of the repo (customer PII). Output masks emails.
// =============================================================================

import { readFileSync } from "node:fs";
import { maskEmail, parseJoyExport, type JoyRow } from "./joy-import-lib.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const url = process.env.LOYALTY_SUPABASE_URL;
  const key = process.env.LOYALTY_SERVICE_KEY;
  if (!url || !key) die("set LOYALTY_SUPABASE_URL and LOYALTY_SERVICE_KEY to apply");
  const res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) die(`${fn}: ${res.status} ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function main() {
  const purge = arg("purge");
  if (purge) {
    const n = await rpc<number>("loyalty_joy_purge", { p_snapshot: purge });
    console.log(`purged ${n} rows from snapshot ${purge}`);
    return;
  }

  const file = process.argv[2];
  const program = arg("program");
  const kind = arg("kind");
  const takenAt = arg("taken-at");
  if (!file || file.startsWith("--")) die("usage: joy-import.ts <export.csv> --program <id> --kind import|compare --taken-at <ISO> [--apply]");
  if (!program || !/^[0-9a-f-]{36}$/i.test(program)) die("--program <loyalty program id> is required");
  if (kind !== "import" && kind !== "compare") die("--kind import|compare is required");
  if (!takenAt || Number.isNaN(Date.parse(takenAt))) die("--taken-at <when the export was downloaded, ISO> is required");

  const parsed = parseJoyExport(readFileSync(file, "utf8"));
  const { rows, problems, mapping } = parsed;
  console.log(`\n${file}: ${rows.length} usable rows, ${problems.length} problems`);
  console.log("columns:");
  for (const [field, i] of Object.entries(mapping.columns)) console.log(`  ${field.padEnd(20)} <- "${parsed.header[i!]}"`);
  if (mapping.unmapped.length) console.log(`  (ignored: ${mapping.unmapped.map((h) => `"${h}"`).join(", ")})`);
  const by = (f: (r: JoyRow) => unknown) => rows.filter((r) => f(r)).length;
  console.log(`with customer id ${by((r) => r.shopify_customer_id)}, email only ${by((r) => !r.shopify_customer_id)}, ` +
    `birthday ${by((r) => r.birthday)}, joined date ${by((r) => r.joined_at)}, activity date ${by((r) => r.last_activity_at)}`);
  const tiers = new Map<string, number>();
  for (const r of rows) tiers.set(r.tier_name ?? "(none)", (tiers.get(r.tier_name ?? "(none)") ?? 0) + 1);
  console.log(`tiers: ${[...tiers].map(([t, n]) => `${t} ${n}`).join(", ")}`);
  console.log(`points total ${rows.reduce((a, r) => a + r.points, 0).toLocaleString("en-US")}`);
  for (const p of problems.slice(0, 20)) console.log(`  row ${p.row_no}: ${p.message}`);
  if (problems.length > 20) console.log(`  … ${problems.length - 20} more`);
  console.log("sample:");
  for (const r of rows.slice(0, 3)) console.log(`  row ${r.row_no}: id ${r.shopify_customer_id ?? "—"} ${maskEmail(r.email)} ${r.points} pts ${r.tier_name ?? ""}`);

  if (!has("apply")) {
    console.log("\nDRY RUN. Nothing was sent. Add --apply (with LOYALTY_SUPABASE_URL / LOYALTY_SERVICE_KEY) to load it.");
    return;
  }

  console.log(`\napplying to ${process.env.LOYALTY_SUPABASE_URL} as a ${kind} snapshot…`);
  const snapshot = await rpc<string>("loyalty_joy_create_snapshot", { p_program: program, p_kind: kind, p_taken_at: takenAt, p_file: file.split(/[\\/]/).pop() });
  for (let i = 0; i < rows.length; i += 500) {
    await rpc<number>("loyalty_joy_add_rows", { p_snapshot: snapshot, p_rows: rows.slice(i, i + 500) });
  }
  const summary = await rpc<Record<string, number>>(kind === "import" ? "loyalty_joy_apply_import" : "loyalty_joy_compare", { p_snapshot: snapshot });
  console.log(`snapshot ${snapshot}`);
  console.log(`summary: ${JSON.stringify(summary)}`);

  const issues = await rpc<Record<string, unknown>[]>("loyalty_joy_mismatches", { p_snapshot: snapshot, p_limit: 50 });
  if (issues.length) {
    console.log(`\n${kind === "import" ? "rows not imported" : "differences"} (worst first, up to 50):`);
    for (const x of issues) {
      console.log(`  row ${x.row_no} ${x.status}: id ${x.shopify_customer_id ?? "—"} ${maskEmail(x.email as string | null)} ` +
        `Joy ${x.joy_points} ${x.joy_tier ?? ""} / ours ${x.our_points ?? "—"} ${x.our_tier ?? ""}${x.message ? ` — ${x.message}` : ""}`);
    }
  }
  console.log(`\nWhen done with it: npx tsx scripts/joy-import.ts --purge ${snapshot}`);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
