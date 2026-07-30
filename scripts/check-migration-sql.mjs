#!/usr/bin/env node
// =============================================================================
// check-migration-sql.mjs — catch SQL syntax errors in migrations BEFORE
// `supabase db push` finds them against the live database.
//
//   node scripts/check-migration-sql.mjs                  # all migrations
//   node scripts/check-migration-sql.mjs 0020             # one, by prefix
//
// WHY THIS EXISTS: on 2026-07-29 migration 0020 shipped with a missing comma
// between two CTEs and only failed on push, against production. The static
// checks in use at the time replaced each $$…$$ function body with a placeholder
// before parsing, so SQL *inside* a plpgsql body was never checked at all — which
// is exactly where the bug was.
//
// This is a linter, not a substitute for applying the migration. It checks:
//   1. CTE comma discipline inside function bodies  (the 0020 bug)
//   2. balanced parentheses per statement
//   3. balanced BEGIN/END and $$ delimiters
//   4. grant/revoke/comment signatures matching a declared function
//   5. non-idempotent statements (create trigger / create policy without a
//      preceding drop) — the 0015 bug
// =============================================================================

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";
const filter = process.argv[2] ?? "";
let failures = 0;

const fail = (file, msg) => {
  failures++;
  console.error(`  FAIL ${file}: ${msg}`);
};

function checkFile(file) {
  const src = readFileSync(join(DIR, file), "utf8");
  const bodies = [...src.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1]);

  // 1. CTE comma discipline. `)` followed by `name as (` with no comma between
  //    is the 0020 bug. Comments in between are allowed and must be skipped.
  bodies.forEach((body, i) => {
    const bad = [...body.matchAll(/\)\s*(?:--[^\n]*\n\s*)*([a-z_][a-z0-9_]*)\s+as\s*\(/gi)]
      .map((m) => m[1])
      // `as (` after a closing paren is only legal with a comma; a bare word here
      // is a CTE name. Filter obvious false positives.
      .filter((n) => !["returns", "language"].includes(n.toLowerCase()));
    if (bad.length) fail(file, `body #${i + 1}: CTE missing a comma before ${bad.join(", ")}`);
  });

  // 2. $$ delimiters must pair up.
  const dollars = (src.match(/\$\$/g) ?? []).length;
  if (dollars % 2 !== 0) fail(file, `odd number of $$ delimiters (${dollars})`);

  // 3. BEGIN/END balance inside each plpgsql body.
  bodies.forEach((body, i) => {
    // A plpgsql body may close with `end;`, `end $$`, or a bare trailing `end`.
    // Counting only `end;` produced false positives on every `do $$ begin … end $$`.
    const begins = (body.match(/\bbegin\b/gi) ?? []).length;
    const ends = (body.match(/\bend\b/gi) ?? []).length;
    if (begins > 0 && ends < begins) {
      fail(file, `body #${i + 1}: ${begins} begin vs ${ends} end`);
    }
  });

  // 4. Parenthesis balance, ignoring strings and comments.
  const stripped = src
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/--[^\n]*/g, "")
    .replace(/'(?:[^']|'')*'/g, "''");
  const open = (stripped.match(/\(/g) ?? []).length;
  const close = (stripped.match(/\)/g) ?? []).length;
  if (open !== close) fail(file, `unbalanced parens outside bodies: ${open} ( vs ${close} )`);

  // 5. grant/revoke/comment signatures must match a declared function.
  const declared = new Map();
  for (const m of src.matchAll(/create or replace function (\w+)\(([^)]*)\)/gi)) {
    // Parameter lists carry inline comments ("p_outcome text, -- 'a' | 'b'"),
    // which must be stripped or the comment text is read as the type.
    const types = m[2]
      .replace(/--[^\n]*/g, "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => p.split(/\s+/)[1])
      .filter(Boolean);
    declared.set(m[1], types.join(", "));
  }
  for (const m of src.matchAll(/(?:revoke|grant)\s+execute on function (\w+)\(([^)]*)\)/gi)) {
    const sig = m[2].split(",").map((t) => t.trim()).join(", ");
    if (declared.has(m[1]) && declared.get(m[1]) !== sig) {
      fail(file, `grant signature ${m[1]}(${sig}) != declared (${declared.get(m[1])})`);
    }
  }
  for (const m of src.matchAll(/comment on function (\w+)\(([^)]*)\)/gi)) {
    const sig = m[2].split(",").map((t) => t.trim()).join(", ");
    if (declared.has(m[1]) && declared.get(m[1]) !== sig) {
      fail(file, `comment signature ${m[1]}(${sig}) != declared (${declared.get(m[1])})`);
    }
  }

  // 6. Non-idempotent statements — the 0015 bug. `create trigger` and
  //    `create policy` have no `if not exists` form, so re-applying dies.
  //
  //    ONLY enforced when the file claims to be re-runnable. An initial-creation
  //    migration like 0001 never promised that, and flagging it buries the real
  //    findings under noise nobody reads.
  const claimsIdempotent = /idempotent|safe to re-?run|safe to re-?apply/i.test(src);
  for (const kind of claimsIdempotent ? ["trigger", "policy"] : []) {
    const re = new RegExp(`create ${kind}\\s+(\\w+)`, "gi");
    for (const m of src.matchAll(re)) {
      const name = m[1];
      const dropped = new RegExp(`drop ${kind} if exists\\s+${name}\\b`, "i").test(src);
      if (!dropped) fail(file, `create ${kind} ${name} has no preceding "drop ${kind} if exists"`);
    }
  }
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .filter((f) => (filter ? f.startsWith(filter) : true))
  .sort();

for (const f of files) checkFile(f);

console.log(
  failures === 0
    ? `\nmigration-sql: ${files.length} file(s) checked, no issues.`
    : `\nmigration-sql: ${failures} issue(s) across ${files.length} file(s).`,
);
process.exit(failures ? 1 : 0);
