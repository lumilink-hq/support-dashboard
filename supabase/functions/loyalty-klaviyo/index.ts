// =============================================================================
// loyalty-klaviyo — send LL Loyalty events and profile properties to the
// program's Klaviyo account (0205).
//
//   POST /loyalty-klaviyo   header x-voice-tool-secret, body {"program_id"}
//
// One call, within ~45s: pending outbox events (Create Event, unique_id per
// event so a retry can't double-send), then members whose Klaviyo properties
// changed (profile-import by email). pg_cron calls it every minute, only for
// programs with klaviyo_enabled_at set and work waiting.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET; KLAVIYO_BASE_URL (optional, test only: mock server).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  type DueEvent,
  type DueProfile,
  errorText,
  eventBody,
  isRetryable,
  KLAVIYO_BASE,
  klaviyoHeaders,
  profileBody,
  retryAfterMs,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");
const BASE = (Deno.env.get("KLAVIYO_BASE_URL") ?? KLAVIYO_BASE).replace(/\/+$/, "");

const BUDGET_MS = 45_000;
const CONCURRENCY = 5;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST with up to 3 tries on 429/5xx. Returns null on success, else the error. */
async function post(key: string, path: string, body: unknown): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, { method: "POST", headers: klaviyoHeaders(key), body: JSON.stringify(body) });
    } catch (e) {
      if (attempt === 2) return `network: ${e instanceof Error ? e.message : String(e)}`;
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (res.ok) {
      await res.body?.cancel();
      return null;
    }
    const text = await res.text();
    if (isRetryable(res.status) && attempt < 2) {
      await sleep(retryAfterMs(res.headers.get("retry-after")));
      continue;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch { /* not JSON */ }
    return errorText(res.status, parsed);
  }
  return "Klaviyo kept failing";
}

/** Run fn over items, CONCURRENCY at a time, until the budget runs out. */
async function pool<T>(items: T[], started: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  const worker = async () => {
    while (i < items.length && Date.now() - started < BUDGET_MS) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!VOICE_TOOL_SECRET || req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  let programId: string;
  try {
    programId = String(((await req.json()) as { program_id?: unknown }).program_id ?? "");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(programId)) return new Response("Bad request", { status: 400 });

  try {
    const key = await rpc<string | null>("get_loyalty_klaviyo_key", { p_program: programId });
    if (!key) return Response.json({ error: "no Klaviyo key for this program (klaviyo_key_ref)" }, { status: 404 });
    const started = Date.now();

    const events = await rpc<DueEvent[]>("loyalty_klaviyo_events_due", { p_program: programId, p_limit: 100 });
    let sent = 0;
    await pool(events, started, async (e) => {
      const err = await post(key, "/events", eventBody(e));
      await rpc("loyalty_klaviyo_event_result", { p_event: e.id, p_error: err });
      if (err) console.error(`loyalty-klaviyo ${programId}: event ${e.id} (${e.metric}): ${err}`);
      else sent++;
    });

    const profiles = Date.now() - started < BUDGET_MS
      ? await rpc<DueProfile[]>("loyalty_klaviyo_profiles_due", { p_program: programId, p_limit: 200 })
      : [];
    const results: { member_id: string; hash: string; error: string | null }[] = [];
    await pool(profiles, started, async (p) => {
      results.push({ member_id: p.member_id, hash: p.hash, error: await post(key, "/profile-import", profileBody(p)) });
    });
    if (results.length) await rpc("loyalty_klaviyo_profiles_result", { p_items: results });

    const failedProfiles = results.filter((r) => r.error).length;
    if (failedProfiles) console.error(`loyalty-klaviyo ${programId}: ${failedProfiles} profile(s) failed, e.g. ${results.find((r) => r.error)?.error}`);
    console.log(`loyalty-klaviyo ${programId}: ${sent}/${events.length} events, ${results.length - failedProfiles}/${results.length} profiles (${Date.now() - started}ms)`);
    return Response.json({ ok: true, events_sent: sent, events_due: events.length, profiles_sent: results.length - failedProfiles });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`loyalty-klaviyo ${programId}: ${msg}`);
    return Response.json({ error: msg }, { status: 500 });
  }
});
