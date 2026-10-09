// =============================================================================
// test-seo-jobs.ts — unit tests for lib/seo-jobs.ts (the Jobs card on
// /seo?tab=settings).
//
//   npx tsx scripts/test-seo-jobs.ts
// =============================================================================

import { describeJob, JOB_INFO, relative, RUN_NOW_RESULT, sortJobs, type JobStatusRow } from "../lib/seo-jobs.ts";

let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const now = new Date("2026-10-09T12:00:00Z");
const at = (mins: number) => new Date(now.getTime() + mins * 60000).toISOString();
const row = (over: Partial<JobStatusRow> = {}): JobStatusRow => ({
  job_type: "seo_crawl",
  scope: "site",
  status: "idle",
  attempt_count: 0,
  last_run_at: at(-2 * 1440),
  last_success_at: at(-2 * 1440),
  next_run_at: at(5 * 1440),
  last_error: null,
  cooldown_until: at(-2 * 1440 + 360),
  ...over,
});

console.log("\nrelative");
ok("just now", relative(at(0), now) === "just now");
ok("minutes ago", relative(at(-12), now) === "12 minutes ago");
ok("one minute", relative(at(-1), now) === "1 minute ago");
ok("hours ago", relative(at(-180), now) === "3 hours ago");
ok("days ago past 36 hours", relative(at(-3 * 1440), now) === "3 days ago");
ok("future", relative(at(5 * 1440), now) === "in 5 days");
ok("null stays null", relative(null, now) === null);

console.log("\ndescribeJob");
{
  const v = describeJob(row(), now);
  ok("idle, out of cooldown: Run now offered", v.state === "ok" && v.canRunNow && v.reason === null, v);
  ok("says when it ran and runs next", v.summary === "Last run 2 days ago. Next in 5 days.", v.summary);
}
{
  const v = describeJob(row({ last_run_at: at(-60), cooldown_until: at(300) }), now);
  ok("inside the cooldown: no Run now, says when", !v.canRunNow && v.reason === "Available in 5 hours", v.reason);
}
{
  const v = describeJob(row({ next_run_at: at(-1) }), now);
  ok("already due: no Run now", !v.canRunNow && v.reason === "Already due" && v.summary.endsWith("Due now."), v);
}
{
  const v = describeJob(row({ status: "running", last_run_at: at(-3) }), now);
  ok("running: no Run now", v.state === "running" && !v.canRunNow && v.summary === "Running since 3 minutes ago.", v);
}
{
  const v = describeJob(row({ attempt_count: 2, last_error: "HTTP 402 from DataForSEO" }), now);
  ok("failing: shows the error, still runnable", v.state === "failing" && v.canRunNow && v.summary.includes("failed: HTTP 402"), v.summary);
  ok("the error ends its sentence before 'Next'", v.summary.includes("DataForSEO. Next in"), v.summary);
}
{
  const v = describeJob(row({ status: null, last_run_at: null, next_run_at: null }), now);
  ok("never run: says it's due", v.state === "never" && !v.canRunNow, v);
}

console.log("\ncatalogue");
const sorted = sortJobs([row({ job_type: "seo_link_opportunities" }), row({ job_type: "unknown_x" }), row({ job_type: "seo_crawl" })]);
ok("sorted by the card's order, unknown last", sorted.map((r) => r.job_type).join() === "seo_crawl,seo_link_opportunities,unknown_x");
// Must match seo_run_now_jobs() (0073, plus seo_gbp_sync from 0076).
const allowlist = ["seo_crawl", "seo_technical_audit", "seo_draft", "seo_content", "seo_competitor_gaps", "seo_link_opportunities", "seo_rank_submit", "seo_ai_visibility", "seo_keyword_research", "seo_search_console", "seo_gbp_sync"];
ok("every allowlisted job has a label", allowlist.every((j) => JOB_INFO[j]), allowlist.filter((j) => !JOB_INFO[j]));
ok("no label for a job outside the allowlist", Object.keys(JOB_INFO).every((j) => allowlist.includes(j)));
ok("every RPC result has a message", ["ok", "already_due", "running", "cooldown", "unknown_job", "not_found"].every((k) => RUN_NOW_RESULT[k]));

console.log(failures === 0 ? "\nAll SEO job tests passed.\n" : `\n${failures} SEO job test(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
