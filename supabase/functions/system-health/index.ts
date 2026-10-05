// =============================================================================
// system-health — the daily self-check (0068_system_health.sql).
//
//   POST /system-health
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   {}   (or { "dry_run": true } to return the issues without storing
//                 or alerting)
//
// Collects issues from system_health_snapshot() (extensions, Vault secrets,
// cron jobs, failing/stuck jobs, paused drafting), this runtime's env secrets
// and the DataForSEO balance; stores the run in system_health_runs; and, when
// any unsilenced critical/warning issue exists, sends one alert to whichever
// channel is configured. Nothing configured is not an error: the run is still
// stored, so `select * from system_health_runs order by ran_at desc` works.
//
// Admin endpoint. MUST be deployed with --no-verify-jwt.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET. Optional: HEALTH_ALERT_SLACK_WEBHOOK (Slack incoming
//      webhook URL); HEALTH_ALERT_EMAIL (comma-separated) with RESEND_API_KEY
//      and HEALTH_ALERT_FROM or SEO_REPORT_FROM; HEALTH_CHECK_IGNORE (see
//      lib.ts parseIgnore); MIN_DATAFORSEO_BALANCE_USD (default 10).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  alertable,
  dataforseoBalanceIssue,
  DEFAULT_MIN_DATAFORSEO_BALANCE_USD,
  envIssues,
  formatAlert,
  type Issue,
  parseDataforseoBalance,
  parseIgnore,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function dataforseoIssue(): Promise<Issue | null> {
  const login = Deno.env.get("DATAFORSEO_LOGIN");
  const password = Deno.env.get("DATAFORSEO_PASSWORD");
  if (!login || !password) return null; // already reported as a missing env secret
  const min = Number(Deno.env.get("MIN_DATAFORSEO_BALANCE_USD") ?? DEFAULT_MIN_DATAFORSEO_BALANCE_USD);
  try {
    const res = await fetch("https://api.dataforseo.com/v3/appendix/user_data", {
      headers: { Authorization: "Basic " + btoa(`${login}:${password}`) },
    });
    if (!res.ok) return dataforseoBalanceIssue(null, min, `HTTP ${res.status}`);
    return dataforseoBalanceIssue(parseDataforseoBalance(await res.json()), min, "unexpected response shape");
  } catch (e) {
    return dataforseoBalanceIssue(null, min, (e as Error).message);
  }
}

async function sendSlack(webhook: string, text: string): Promise<string | null> {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return res.ok ? null : `Slack ${res.status}: ${(await res.text()).slice(0, 200)}`;
}

async function sendEmail(to: string[], text: string, subject: string): Promise<string | null> {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("HEALTH_ALERT_FROM") ?? Deno.env.get("SEO_REPORT_FROM");
  if (!key || !from) return "email not sent: RESEND_API_KEY and HEALTH_ALERT_FROM/SEO_REPORT_FROM are required";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text }),
  });
  return res.ok ? null : `Resend ${res.status}: ${(await res.text()).slice(0, 200)}`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // an empty body is fine
  }
  const dryRun = body.dry_run === true;

  const issues: Issue[] = [];
  const { data: snapshot, error: snapError } = await supabase.rpc("system_health_snapshot");
  if (snapError) {
    issues.push({ check: "snapshot", severity: "critical", subject: "system_health_snapshot", detail: snapError.message });
  } else {
    issues.push(...((snapshot ?? []) as Issue[]));
  }
  issues.push(...envIssues((n) => Deno.env.get(n)));
  const balance = await dataforseoIssue();
  if (balance) issues.push(balance);

  const ignore = parseIgnore(Deno.env.get("HEALTH_CHECK_IGNORE"));
  const toAlert = alertable(issues, ignore);
  const ranAt = new Date().toISOString();

  if (dryRun) return json({ ok: toAlert.length === 0, alertable: toAlert, issues });

  const via: string[] = [];
  const errors: string[] = [];
  if (toAlert.length > 0) {
    const text = formatAlert(toAlert, ranAt);
    const slack = Deno.env.get("HEALTH_ALERT_SLACK_WEBHOOK");
    if (slack) {
      const err = await sendSlack(slack, text);
      err ? errors.push(err) : via.push("slack");
    }
    const emails = (Deno.env.get("HEALTH_ALERT_EMAIL") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (emails.length > 0) {
      const err = await sendEmail(emails, text, text.split("\n")[0]);
      err ? errors.push(err) : via.push("email");
    }
    if (!slack && emails.length === 0) errors.push("no alert channel configured (HEALTH_ALERT_SLACK_WEBHOOK / HEALTH_ALERT_EMAIL)");
  }

  const { error: insertError } = await supabase.from("system_health_runs").insert({
    ran_at: ranAt,
    ok: toAlert.length === 0,
    issues,
    alerted_via: via.length ? via.join("+") : null,
    alert_error: errors.length ? errors.join("; ") : null,
  });
  if (insertError) console.error("system-health: could not store the run:", insertError.message);

  return json({ ok: toAlert.length === 0, alerted: toAlert.length, issues: issues.length, alerted_via: via, alert_errors: errors });
});
