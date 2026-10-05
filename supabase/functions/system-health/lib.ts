// =============================================================================
// system-health/lib.ts — the pure half of the daily self-check: which env
// secrets are required, the DataForSEO balance rule, silencing, and the alert
// text. No network, no database; tested by scripts/test-system-health.ts.
// =============================================================================

export type Severity = "critical" | "warning" | "info";

export interface Issue {
  check: string;
  severity: Severity;
  subject: string;
  detail: string;
}

/**
 * Env secrets the functions read, and what breaks without each. Every edge
 * function in a Supabase project shares one set of secrets, so this function
 * seeing a name means every function sees it.
 *
 * critical = a pipeline fails outright. warning = it runs but something a
 * customer expects quietly doesn't happen. info = a known optional gap; listed
 * in the stored run, never alerted on its own.
 */
export const ENV_REQUIREMENTS: { names: string[]; severity: Severity; impact: string }[] = [
  { names: ["VOICE_TOOL_SECRET"], severity: "critical", impact: "every scheduled job is rejected at its function" },
  { names: ["ANTHROPIC_API_KEY"], severity: "critical", impact: "seo-draft and seo-content fail: no page fix or article can be drafted" },
  { names: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"], severity: "critical", impact: "rank tracking, backlinks, keyword research and AI visibility all fail" },
  { names: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"], severity: "critical", impact: "Google tokens can't refresh, so Search Console data stops" },
  { names: ["REPLICATE_API_TOKEN"], severity: "warning", impact: "articles are drafted without images" },
  { names: ["RESEND_API_KEY", "SEO_REPORT_FROM"], severity: "warning", impact: "monthly reports are generated but never emailed" },
  { names: ["RENDER_SERVICE_URL", "RENDER_SERVICE_SECRET"], severity: "info", impact: "JS-rendered sites can't be crawled (render-service not wired in)" },
  { names: ["PAGESPEED_API_KEY"], severity: "info", impact: "the technical audit skips Core Web Vitals" },
];

export function envIssues(get: (name: string) => string | undefined): Issue[] {
  const out: Issue[] = [];
  for (const req of ENV_REQUIREMENTS) {
    const missing = req.names.filter((n) => !(get(n) ?? "").trim());
    if (missing.length === 0) continue;
    out.push({
      check: "env_secret",
      severity: req.severity,
      subject: missing.join(", "),
      detail: `${missing.join(" and ")} not set in Supabase secrets: ${req.impact}.`,
    });
  }
  return out;
}

/** DataForSEO is prepaid; at zero every call returns 402 (seen 2026-10-02). */
export const DEFAULT_MIN_DATAFORSEO_BALANCE_USD = 10;

export function dataforseoBalanceIssue(balance: number | null, min: number, error?: string): Issue | null {
  if (balance === null) {
    return {
      check: "vendor_balance",
      severity: "warning",
      subject: "dataforseo",
      detail: `Couldn't read the DataForSEO balance${error ? `: ${error}` : ""}.`,
    };
  }
  if (balance >= min) return null;
  return {
    check: "vendor_balance",
    severity: balance <= 0 ? "critical" : "warning",
    subject: "dataforseo",
    detail: `DataForSEO balance is $${balance.toFixed(2)} (alert below $${min}); at $0 every call returns 402.`,
  };
}

/** Read `tasks[0].result[0].money.balance` from /v3/appendix/user_data. */
export function parseDataforseoBalance(body: unknown): number | null {
  const b = (body as { tasks?: { result?: { money?: { balance?: unknown } }[] }[] })?.tasks?.[0]?.result?.[0]?.money?.balance;
  return typeof b === "number" && Number.isFinite(b) ? b : null;
}

/**
 * HEALTH_CHECK_IGNORE silences known, accepted issues so the daily alert stays
 * worth reading. Comma-separated; each entry is a check ("env_secret") or a
 * check:subject pair ("cron_job:product-sync-due").
 */
export function parseIgnore(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function isIgnored(issue: Issue, ignore: string[]): boolean {
  return ignore.includes(issue.check) || ignore.includes(`${issue.check}:${issue.subject}`);
}

/** Only critical and warning issues that aren't silenced send an alert. */
export function alertable(issues: Issue[], ignore: string[]): Issue[] {
  return issues.filter((i) => i.severity !== "info" && !isIgnored(i, ignore));
}

const ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Plain text that reads the same in Slack and in an email body. */
export function formatAlert(issues: Issue[], ranAt: string): string {
  const sorted = [...issues].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.check.localeCompare(b.check));
  const crit = sorted.filter((i) => i.severity === "critical").length;
  const warn = sorted.length - crit;
  const head = `LumiLink health check ${ranAt.slice(0, 10)}: ${crit} critical, ${warn} warning`;
  const lines = sorted.map((i) => `${i.severity === "critical" ? "[CRITICAL]" : "[warning]"} ${i.check} · ${i.subject}: ${i.detail}`);
  return [head, "", ...lines].join("\n");
}
