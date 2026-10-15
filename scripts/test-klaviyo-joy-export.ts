// =============================================================================
// test-klaviyo-joy-export.ts — unit tests for scripts/klaviyo-joy-export-lib.ts:
// Klaviyo profile -> row, CSV quoting, dedupe, and that the CSV reads back
// cleanly through the Joy importer's parser.
//
//   npx tsx scripts/test-klaviyo-joy-export.ts
//
// No network, no database.
// =============================================================================

import { dedupe, rowFromProfile, toCsv } from "./klaviyo-joy-export-lib.ts";
import { parseJoyExport } from "./joy-import-lib.ts";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, got?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
  }
}

function eq(label: string, got: unknown, want: unknown) {
  ok(label, JSON.stringify(got) === JSON.stringify(want), got);
}

function main() {
  const maya = { attributes: { email: " Maya@Example.com ", first_name: "Maya", last_name: "Lopez, Jr.", properties: { "Joy Loyalty Points": 1468, "Joy Vip tier": "Silver", Birthday: "04/18/1992" } } };
  eq("row: from profile, email lowercased, numbers as text", rowFromProfile(maya),
    { row: { email: "maya@example.com", first: "Maya", last: "Lopez, Jr.", points: "1468", tier: "Silver", birthday: "04/18/1992" } });
  eq("row: dateOfBirth when Birthday is missing",
    (rowFromProfile({ attributes: { email: "a@b.co", properties: { "Joy Loyalty Points": "0", dateOfBirth: "01/02/1990" } } }) as { row: { birthday: string } }).row.birthday, "01/02/1990");
  eq("skip: no email", rowFromProfile({ attributes: { properties: { "Joy Loyalty Points": 5 } } }), { skip: "no email" });
  eq("skip: no points property", rowFromProfile({ attributes: { email: "a@b.co", properties: {} } }), { skip: "no Joy Loyalty Points" });
  eq("row: zero points kept", (rowFromProfile({ attributes: { email: "z@b.co", properties: { "Joy Loyalty Points": 0 } } }) as { row: { points: string } }).row.points, "0");

  const rows = [
    (rowFromProfile(maya) as { row: never }).row,
    { email: "maya@example.com", first: "Dup", last: "", points: "1", tier: "Bronze", birthday: "" },
    { email: "q@example.com", first: 'Q "Quote"', last: "", points: "1,250", tier: "Gold", birthday: "" },
  ];
  const d = dedupe(rows);
  eq("dedupe: one row per email, first kept", [d.rows.length, d.duplicates, d.rows[0].first], [2, 1, "Maya"]);

  const csv = toCsv(d.rows);
  ok("csv: commas and quotes escaped", csv.includes('"Lopez, Jr."') && csv.includes('"Q ""Quote"""') && csv.includes('"1,250"'), csv);
  const parsed = parseJoyExport(csv);
  eq("round trip: the importer reads it", parsed.rows.map((r) => [r.email, r.last_name, r.points, r.tier_name, r.birthday]), [
    ["maya@example.com", "Lopez, Jr.", 1468, "Silver", "1992-04-18"],
    ["q@example.com", null, 1250, "Gold", null],
  ]);
  eq("round trip: no problems", parsed.problems, []);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
