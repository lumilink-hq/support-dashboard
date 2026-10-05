#!/usr/bin/env node
// =============================================================================
// run-tests.mjs — run every unit test in scripts/test-*.ts, one process each.
//
//   npm test                    # all of them
//   npm test -- seo             # only files whose name contains "seo"
//
// Each test file is self-contained (no network, no database) and exits non-zero
// on failure, so this just runs them in turn and reports which failed. The .mjs
// tests (test-voice-lookup.mjs) need a served edge function and are left out.
// =============================================================================

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? "";
const files = readdirSync(dir)
  .filter((f) => f.startsWith("test-") && f.endsWith(".ts") && f.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(`no test files match "${filter}"`);
  process.exit(1);
}

const failed = [];
for (const f of files) {
  const started = Date.now();
  const r = spawnSync("npx", ["--yes", "tsx", join(dir, f)], {
    cwd: join(dir, ".."),
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status === 0) {
    console.log(`  pass  ${f}  (${secs}s)`);
  } else {
    failed.push(f);
    console.log(`  FAIL  ${f}  (${secs}s)`);
    process.stdout.write((r.stdout ?? "") + (r.stderr ?? ""));
  }
}

console.log(`\n${files.length - failed.length}/${files.length} passed`);
if (failed.length) {
  console.log(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
