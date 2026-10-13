// =============================================================================
// outbound-verify — outbound engine Phase 1 step 4 (docs/OUTBOUND-PLAN.md):
// check each found address with Reoon (power mode: it asks the mail server
// whether the inbox exists) before anything is sent to it.
//
//   POST /outbound-verify
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   {}                         a batch of the oldest 'email_found' leads
//           { "batch": 15 }            batch size, 1-20 (default 10)
//           { "lead_id": "<uuid>" }    one lead (must still be 'email_found')
//
// MUST be deployed with --no-verify-jwt (shared-secret auth).
//
// WHY. Bounces are what get new mailboxes flagged as spam; addresses scraped
// from websites go stale. One power-mode check costs one Reoon credit
// (10,000 for $11.90, credits never expire).
//
// RESULTS (lib.ts mapReoon, saved by outbound_record_verification, 0303):
//   safe, deliverable role account          -> verified (valid)
//   catch_all, unknown                      -> verified, flagged; sent last
//   inbox_full                              -> invalid, not suppressed
//   invalid, disabled, spamtrap, disposable -> invalid + suppressed for good
// A Reoon error releases the lead for a later run. An account error (credits,
// key) stops the whole run so the batch isn't burned on failures.
//
// LIMITS. Reoon asks for no more than 5 parallel single checks; this runs 3.
// A power check can take up to a minute, so batches are small and the run
// stops starting new checks after 100 seconds; unreached leads are released.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, REOON_API_KEY, REOON_API_BASE (optional, tests).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { isVendorError, mapReoon } from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const REOON_API_KEY = Deno.env.get("REOON_API_KEY");
const REOON_API_BASE = Deno.env.get("REOON_API_BASE") ?? "https://emailverifier.reoon.com";

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const DEFAULT_BATCH = 10;
const MAX_BATCH = 20;
const CONCURRENCY = 3; // Reoon: no more than 5 parallel single checks
const CHECK_TIMEOUT_MS = 75_000; // power mode can take over a minute
const RUN_BUDGET_MS = 100_000;
const LEASE_SECONDS = 300;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Lead = { id: string; email: string | null; stage: string };

/** One power-mode check. Returns the parsed body, or throws on transport failure. */
async function reoon(email: string): Promise<unknown> {
  const url = new URL("/api/v1/verify", REOON_API_BASE);
  url.searchParams.set("email", email);
  url.searchParams.set("key", REOON_API_KEY!);
  url.searchParams.set("mode", "power");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.json().catch(() => null);
    // Reoon answers account problems with a JSON error body; keep it for mapReoon.
    if (!res.ok && !(body && typeof body === "object")) throw new Error(`reoon HTTP ${res.status}`);
    return body;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error("reoon timeout");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!VOICE_TOOL_SECRET) {
    console.error("VOICE_TOOL_SECRET unset — refusing to run");
    return json({ error: "Server not configured" }, 500);
  }
  if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!REOON_API_KEY) {
    console.error("REOON_API_KEY unset — refusing to run");
    return json({ error: "Server not configured" }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) ?? {};
  } catch {
    body = {};
  }
  const started = Date.now();

  let leads: Lead[];
  if (typeof body.lead_id === "string") {
    const { data, error } = await supabase
      .from("outbound_leads")
      .select("id, email, stage")
      .eq("id", body.lead_id)
      .maybeSingle();
    if (error) return json({ error: `lead lookup failed: ${error.message}` }, 500);
    if (!data) return json({ error: "Lead not found" }, 404);
    if (data.stage !== "email_found") return json({ error: `Lead is at stage '${data.stage}', not 'email_found'` }, 409);
    leads = [data as Lead];
  } else {
    const requested = Number(body.batch ?? DEFAULT_BATCH);
    const batch = Number.isInteger(requested) ? Math.min(MAX_BATCH, Math.max(1, requested)) : DEFAULT_BATCH;
    const { data, error } = await supabase.rpc("outbound_claim_leads", {
      p_stage: "email_found",
      p_limit: batch,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (error) return json({ error: `claim failed: ${error.message}` }, 500);
    leads = (data ?? []) as Lead[];
  }

  const results: Record<string, unknown>[] = [];
  const release: string[] = [];
  let stopReason: string | null = null;
  let next = 0;

  async function worker() {
    while (next < leads.length) {
      const lead = leads[next++];
      if (stopReason || Date.now() - started > RUN_BUDGET_MS || !lead.email) {
        release.push(lead.id);
        continue;
      }
      try {
        const mapped = mapReoon(await reoon(lead.email));
        if (isVendorError(mapped)) {
          if (mapped.fatal) stopReason = mapped.error;
          release.push(lead.id);
          results.push({ lead_id: lead.id, outcome: "error", error: mapped.error });
          continue;
        }
        const { data: outcome, error } = await supabase.rpc("outbound_record_verification", {
          p_lead_id: lead.id,
          p_verification: mapped.verification,
          p_suppress: mapped.suppress,
          p_detail: mapped.detail,
        });
        if (error) throw new Error(`outbound_record_verification failed: ${error.message}`);
        results.push({ lead_id: lead.id, outcome, verification: mapped.verification, status: mapped.detail.status });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`outbound-verify ${lead.id}: ${message}`);
        release.push(lead.id);
        results.push({ lead_id: lead.id, outcome: "error", error: message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, leads.length) }, worker));

  if (release.length > 0) {
    const { error } = await supabase.from("outbound_leads").update({ claimed_until: null }).in("id", release);
    if (error) console.error(`outbound-verify: release failed: ${error.message}`);
  }

  const tally: Record<string, number> = {};
  for (const r of results) tally[String(r.outcome)] = (tally[String(r.outcome)] ?? 0) + 1;
  return json({ claimed: leads.length, released: release.length, stopped: stopReason, tally, results });
});
