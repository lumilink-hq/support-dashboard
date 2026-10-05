#!/usr/bin/env node
// =============================================================================
// run-sql-tests.mjs — run every scripts/test_*.sql against the LOCAL Supabase
// stack (`supabase start`), one psql session each.
//
//   npm run test:sql            # all of them
//   npm run test:sql -- seo     # only files whose name contains "seo"
//
// Always goes through `docker exec` into the local db container, never a
// DATABASE_URL, so it can't be pointed at production by a stray env var. Every
// test file wraps itself in begin … rollback, so nothing it writes persists.
// =============================================================================

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONTAINER = "supabase_db_support-dashboard";
const dir = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? "";
const files = readdirSync(dir)
  .filter((f) => f.startsWith("test_") && f.endsWith(".sql") && f.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(`no SQL test files match "${filter}"`);
  process.exit(1);
}

const ping = spawnSync("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres"], { encoding: "utf8" });
if (ping.status !== 0) {
  console.error(`local db container "${CONTAINER}" isn't reachable — run \`supabase start\` first.`);
  process.exit(1);
}

// The dispatch tests need pg_net, which production has on but a fresh
// `supabase start` doesn't (0023's REQUIRES note). The tests create their own
// Vault secrets inside their transactions.
spawnSync("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-qc", "create extension if not exists pg_net"], {
  encoding: "utf8",
});

const failed = [];
for (const f of files) {
  const r = spawnSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"],
    { input: readFileSync(join(dir, f)), encoding: "utf8" },
  );
  if (r.status === 0) {
    console.log(`  pass  ${f}`);
  } else {
    failed.push(f);
    console.log(`  FAIL  ${f}`);
    process.stdout.write(r.stderr ?? "");
  }
}

console.log(`\n${files.length - failed.length}/${files.length} passed`);
if (failed.length) {
  console.log(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
