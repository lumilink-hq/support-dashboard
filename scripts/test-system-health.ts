// =============================================================================
// test-system-health.ts — unit tests for supabase/functions/system-health/lib.ts.
//
//   npx tsx scripts/test-system-health.ts
//
// No network, no database.
// =============================================================================

import {
  alertable,
  dataforseoBalanceIssue,
  envIssues,
  formatAlert,
  type Issue,
  isIgnored,
  parseDataforseoBalance,
  parseIgnore,
} from "../supabase/functions/system-health/lib.ts";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

// ---- envIssues --------------------------------------------------------------
const full: Record<string, string> = {
  VOICE_TOOL_SECRET: "x", ANTHROPIC_API_KEY: "x", DATAFORSEO_LOGIN: "x", DATAFORSEO_PASSWORD: "x",
  GOOGLE_OAUTH_CLIENT_ID: "x", GOOGLE_OAUTH_CLIENT_SECRET: "x", REPLICATE_API_TOKEN: "x",
  RESEND_API_KEY: "x", SEO_REPORT_FROM: "x", RENDER_SERVICE_URL: "x", RENDER_SERVICE_SECRET: "x",
  PAGESPEED_API_KEY: "x",
};
ok("everything set → no env issues", envIssues((n) => full[n]).length === 0);

// Production as found 2026-10-05: no Anthropic, Resend, render-service or PageSpeed.
const prod = { ...full };
for (const n of ["ANTHROPIC_API_KEY", "RESEND_API_KEY", "SEO_REPORT_FROM", "RENDER_SERVICE_URL", "RENDER_SERVICE_SECRET", "PAGESPEED_API_KEY"]) delete prod[n];
const prodIssues = envIssues((n) => prod[n]);
const anthropic = prodIssues.find((i) => i.subject === "ANTHROPIC_API_KEY");
ok("missing Anthropic key is critical", anthropic?.severity === "critical");
ok("its detail says what breaks", !!anthropic?.detail.includes("no page fix or article"));
const resend = prodIssues.find((i) => i.subject.includes("RESEND_API_KEY"));
ok("missing Resend is a warning, both names listed together", resend?.severity === "warning" && resend.subject === "RESEND_API_KEY, SEO_REPORT_FROM");
ok("render-service and PageSpeed are info only", prodIssues.filter((i) => i.severity === "info").length === 2);
ok("blank value counts as missing", envIssues((n) => (n === "VOICE_TOOL_SECRET" ? "  " : full[n])).some((i) => i.subject === "VOICE_TOOL_SECRET"));
ok("half of a pair missing names only that half",
   envIssues((n) => (n === "DATAFORSEO_PASSWORD" ? undefined : full[n]))[0]?.subject === "DATAFORSEO_PASSWORD");

// ---- DataForSEO balance -----------------------------------------------------
ok("parses user_data balance", parseDataforseoBalance({ tasks: [{ result: [{ money: { balance: 42.5 } }] }] }) === 42.5);
ok("unexpected shape → null", parseDataforseoBalance({ tasks: [] }) === null && parseDataforseoBalance(null) === null);
ok("string balance is not trusted", parseDataforseoBalance({ tasks: [{ result: [{ money: { balance: "42" } }] }] }) === null);
ok("above the minimum → no issue", dataforseoBalanceIssue(25, 10) === null);
ok("exactly the minimum → no issue", dataforseoBalanceIssue(10, 10) === null);
ok("below the minimum → warning", dataforseoBalanceIssue(4.2, 10)?.severity === "warning");
ok("at zero → critical", dataforseoBalanceIssue(0, 10)?.severity === "critical");
ok("unreadable → warning with the reason", dataforseoBalanceIssue(null, 10, "HTTP 401")?.detail.includes("HTTP 401") === true);

// ---- silencing and alerting -------------------------------------------------
const issues: Issue[] = [
  { check: "env_secret", severity: "critical", subject: "ANTHROPIC_API_KEY", detail: "a" },
  { check: "cron_job", severity: "critical", subject: "product-sync-due", detail: "b" },
  { check: "job_failing", severity: "warning", subject: "seo_crawl", detail: "c" },
  { check: "env_secret", severity: "info", subject: "PAGESPEED_API_KEY", detail: "d" },
];
ok("parseIgnore trims and drops blanks", JSON.stringify(parseIgnore(" cron_job:product-sync-due , ,job_failing")) === '["cron_job:product-sync-due","job_failing"]');
ok("parseIgnore of nothing is empty", parseIgnore(undefined).length === 0);
ok("check:subject silences one", isIgnored(issues[1], ["cron_job:product-sync-due"]) && !isIgnored(issues[0], ["cron_job:product-sync-due"]));
ok("bare check silences every subject", isIgnored(issues[2], ["job_failing"]));
ok("info never alerts", alertable(issues, []).length === 3);
ok("silenced issues don't alert", alertable(issues, ["cron_job:product-sync-due", "job_failing"]).length === 1);

// ---- formatAlert ------------------------------------------------------------
const text = formatAlert(alertable(issues, []), "2026-10-05T15:00:00.000Z");
const lines = text.split("\n");
ok("headline counts critical and warning", lines[0] === "LumiLink health check 2026-10-05: 2 critical, 1 warning");
ok("critical lines come first", lines[2].startsWith("[CRITICAL]") && lines[4].startsWith("[warning]"));
ok("each line names check and subject", text.includes("env_secret · ANTHROPIC_API_KEY: a"));

console.log(`\nsystem-health: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
