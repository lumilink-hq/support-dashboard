// The SEO jobs shown on /seo?tab=settings, and the words for their state.
// The allowlist and cooldowns themselves live in 0073's seo_run_now_jobs();
// this only labels them, so a job missing here is shown by its raw name rather
// than hidden. Pure, so scripts/test-seo-jobs.ts can test it with plain tsx.

export type JobStatusRow = {
  job_type: string;
  scope: "site" | "location" | "client";
  status: string | null;
  attempt_count: number | null;
  last_run_at: string | null;
  last_success_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  cooldown_until: string | null;
};

/** `soon`: how quickly a queued run starts, from the job's cron cadence (0073). */
export const JOB_INFO: Record<string, { label: string; what: string; order: number; soon?: string }> = {
  seo_crawl: { label: "Site audit", what: "Crawls the website and lists problems. Weekly.", order: 1, soon: "within 5 minutes" },
  seo_technical_audit: { label: "Technical checks", what: "Page speed and Google indexing, from Search Console. Weekly.", order: 2 },
  seo_draft: { label: "Fix drafts", what: "Drafts titles, descriptions and headings for what the audit found. Daily.", order: 3 },
  seo_content: { label: "Article", what: "Drafts up to one new article a week. Running it again the same week adds nothing.", order: 4 },
  seo_rank_submit: { label: "Rankings", what: "Checks where each tracked keyword ranks on Google. Weekly.", order: 5 },
  seo_ai_visibility: { label: "AI answers", what: "Asks ChatGPT and Google AI Overviews your questions. Weekly.", order: 6 },
  seo_search_console: { label: "Search Console", what: "Pulls clicks and impressions from Google. Daily.", order: 7, soon: "within 15 minutes" },
  seo_keyword_research: { label: "Keyword research", what: "Search volumes and related searches. Monthly.", order: 8 },
  seo_competitor_gaps: { label: "Competitor gaps", what: "Searches your competitors rank for and you don't. Monthly, or soon after you add a competitor.", order: 9 },
  seo_link_opportunities: { label: "Link opportunities", what: "Sites that link to your competitors but not to you. Monthly, or soon after you add a competitor.", order: 10 },
};

/** The messages request_seo_run_now() can return, as a notice or an error. */
export const RUN_NOW_RESULT: Record<string, { ok: boolean; text: string }> = {
  ok: { ok: true, text: "Queued for the next scheduled check." },
  already_due: { ok: true, text: "It's already due and will run at the next scheduled check." },
  running: { ok: false, text: "It's running right now." },
  cooldown: { ok: false, text: "It ran recently. Each job can be run early once per cooldown to keep costs down." },
  unknown_job: { ok: false, text: "That job can't be run from here." },
  not_found: { ok: false, text: "That location no longer exists." },
};

export function sortJobs(rows: JobStatusRow[]): JobStatusRow[] {
  const order = (r: JobStatusRow) => JOB_INFO[r.job_type]?.order ?? 99;
  return [...rows].sort((a, b) => order(a) - order(b));
}

/** "just now", "12 minutes ago", "3 hours ago", "2 days ago"; future: "in 5 minutes", "in 3 days". */
export function relative(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now.getTime();
  const future = ms > 0;
  const mins = Math.round(Math.abs(ms) / 60000);
  let unit: string;
  if (mins < 1) return future ? "any moment" : "just now";
  if (mins < 60) unit = `${mins} minute${mins === 1 ? "" : "s"}`;
  else if (mins < 60 * 36) {
    const h = Math.round(mins / 60);
    unit = `${h} hour${h === 1 ? "" : "s"}`;
  } else {
    const d = Math.round(mins / 1440);
    unit = `${d} day${d === 1 ? "" : "s"}`;
  }
  return future ? `in ${unit}` : `${unit} ago`;
}

export type JobView = {
  state: "running" | "failing" | "ok" | "never";
  summary: string;
  canRunNow: boolean;
  reason: string | null; // why Run now is unavailable
};

export function describeJob(r: JobStatusRow, now: Date): JobView {
  const last = relative(r.last_run_at, now);
  const next = relative(r.next_run_at, now);
  const due = !r.next_run_at || new Date(r.next_run_at) <= now;
  const cooling = !!r.cooldown_until && new Date(r.cooldown_until) > now;

  if (!r.status || !r.last_run_at) {
    return { state: "never", summary: "Hasn't run yet; it runs at the next scheduled check.", canRunNow: false, reason: "Already due" };
  }
  if (r.status === "running") {
    return { state: "running", summary: `Running since ${last}.`, canRunNow: false, reason: "Running now" };
  }
  const failing = (r.attempt_count ?? 0) > 0;
  const error = r.last_error?.trim().replace(/[.!]?$/, ".");
  const parts = [failing ? `Last run ${last} failed${error ? `: ${error}` : "."}` : `Last run ${last}.`];
  parts.push(due ? "Due now." : `Next ${next}.`);
  return {
    state: failing ? "failing" : "ok",
    summary: parts.join(" "),
    canRunNow: !due && !cooling,
    reason: due ? "Already due" : cooling ? `Available ${relative(r.cooldown_until, now)}` : null,
  };
}
