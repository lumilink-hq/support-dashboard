// =============================================================================
// test-joy-import.ts — unit tests for scripts/joy-import-lib.ts (0207): CSV
// parsing, header aliases, row validation and date/points parsing for the
// Joy export.
//
//   npx tsx scripts/test-joy-import.ts
//
// No network, no database.
// =============================================================================

import { mapHeaders, maskEmail, parseBirthday, parseCsv, parseJoyExport, parsePoints, parseTimestamp } from "./joy-import-lib.ts";

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

function throws(label: string, fn: () => unknown, match: RegExp) {
  try {
    fn();
    ok(label, false, "no error");
  } catch (e) {
    ok(label, match.test(String(e)), String(e));
  }
}

function main() {
  eq("csv: quotes, escaped quotes, commas, newline in a field, CRLF, BOM, blank lines",
    parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n\r\n"line1\nline2",3\n'),
    [["a", "b"], ["x, y", 'he said "hi"'], ["line1\nline2", "3"]]);

  const m = mapHeaders(["Customer ID", "Email Address", "First Name", "Last Name", "Point Balance", "VIP Tier", "Date of Birth", "Joined At", "Last Activity", "Joy ID"]);
  eq("headers: aliases, case and punctuation ignored", m.columns, {
    shopify_customer_id: 0, email: 1, first_name: 2, last_name: 3, points: 4, tier_name: 5, birthday: 6, joined_at: 7, last_activity_at: 8,
  });
  eq("headers: unknown columns listed", m.unmapped, ["Joy ID"]);

  // Joy's own export file.
  eq("headers: Joy export", mapHeaders(["Email", "Name", "Membership Type", "Points", "Birthday", "Created Date"]).columns, {
    email: 0, full_name: 1, tier_name: 2, points: 3, birthday: 4, joined_at: 5,
  });
  // A Klaviyo profile export of Joy's synced properties.
  const k = mapHeaders(["Email", "First Name", "Last Name", "Joy Loyalty Points", "Joy Vip tier", "Birthday", "dateOfBirth", "Joy member status"]);
  eq("headers: Klaviyo export", k.columns, { email: 0, first_name: 1, last_name: 2, points: 3, tier_name: 4, birthday: 5 });
  eq("headers: Klaviyo extras ignored (second birthday, member status)", k.unmapped, ["dateOfBirth", "Joy member status"]);
  const kp = parseJoyExport("Email,First Name,Last Name,Joy Loyalty Points,Joy Vip tier,Birthday\nmaya@example.com,Maya,Lopez,1468,Silver,04/18/1992\n");
  eq("klaviyo row: email-only, MM/DD/YYYY birthday", [kp.rows[0].shopify_customer_id, kp.rows[0].email, kp.rows[0].points, kp.rows[0].tier_name, kp.rows[0].birthday],
    [null, "maya@example.com", 1468, "Silver", "1992-04-18"]);

  eq("points: commas", parsePoints("1,234"), 1234);
  eq("points: decimals refused", parsePoints("12.5"), null);
  eq("points: blank refused", parsePoints(""), null);

  eq("birthday: ISO", parseBirthday("1990-04-18"), "1990-04-18");
  eq("birthday: US", parseBirthday("4/18/1990"), "1990-04-18");
  eq("birthday: no year keeps Feb 29", parseBirthday("02/29"), "1904-02-29");
  eq("birthday: impossible date", parseBirthday("02/30/1990"), null);
  eq("timestamp: ISO with zone", parseTimestamp("2026-10-01T09:00:00-07:00"), "2026-10-01T16:00:00.000Z");
  eq("timestamp: US date and time as UTC", parseTimestamp("10/01/2026 09:30"), "2026-10-01T09:30:00.000Z");
  eq("timestamp: junk", parseTimestamp("yesterday"), null);

  const csv = [
    "Email,Name,Customer ID,Points,Tier,Birthday",
    "Alice@Example.com,Alice Ng,10,\"2,150\",Gold,04/18/1990",
    "bob@example.com,Bob,,80,Bronze,",
    "carol@example.com,Carol,gid://shopify/Customer/12,900,Silver,13/40/1990",
    ",No Contact,,5,Bronze,",
    "dave@example.com,Dave,14,-3,Bronze,",
    "eve@example.com,Eve,15,ten,Bronze,",
    "alice2@example.com,Alice Again,10,1,Gold,",
  ].join("\n");
  const p = parseJoyExport(csv);
  eq("rows: usable ones kept", p.rows.map((r) => r.row_no), [2, 3, 4]);
  eq("row: normalized", p.rows[0], {
    row_no: 2, shopify_customer_id: 10, email: "alice@example.com", first_name: "Alice", last_name: "Ng",
    points: 2150, tier_name: "Gold", birthday: "1990-04-18", joined_at: null, last_activity_at: null,
  });
  eq("row: email only", [p.rows[1].shopify_customer_id, p.rows[1].email], [null, "bob@example.com"]);
  eq("row: Shopify gid accepted", p.rows[2].shopify_customer_id, 12);
  eq("problems: each with its spreadsheet row", p.problems.map((x) => `${x.row_no}: ${x.message}`), [
    '4: birthday "13/40/1990" not understood (row kept, birthday skipped)',
    "5: no customer id or email",
    "6: negative points (-3)",
    '7: points "ten" isn\'t a whole number',
    "8: duplicate id:10",
  ]);

  throws("file: needs a points column", () => parseJoyExport("Email,Tier\na@b.co,Gold"), /no points column/);
  throws("file: needs an id or email column", () => parseJoyExport("Name,Points\nA,5"), /no customer id or email/);
  throws("file: empty", () => parseJoyExport(""), /empty/);

  eq("mask: email", maskEmail("alice@example.com"), "a***@example.com");
  eq("mask: none", maskEmail(null), "—");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
