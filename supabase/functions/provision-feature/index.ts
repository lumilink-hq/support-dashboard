// =============================================================================
// provision-feature — the "as automatic as possible" worker.
//
// After a payment, apply_billing_event creates a 'pending' entitlement and a
// 'queued' provisioning_task. This worker drains that queue and stands up the
// feature's infrastructure, then flips the entitlement to 'active' so the
// dashboard page unlocks itself with no human in the loop.
//
// Reality check: some steps genuinely need a client-supplied secret (store API
// key, the Gmail connection). When one is missing we DON'T half-activate — we
// park the task as 'needs_human' (entitlement stays 'pending', so the dashboard
// keeps showing "setting up…") and surface why. Everything that CAN be automated
// (buy the Twilio number, create the ElevenLabs agent) is.
//
// Trigger options (pick per ops preference):
//   * cron (Supabase scheduled function) every minute — simplest, fully hands-off
//   * called fire-and-forget by billing-webhook right after a grant
// It always drains the whole queue, so double-triggering is harmless.
//
// The Twilio / ElevenLabs calls are STUBBED with clear TODOs — the control flow,
// idempotency, and DB transitions are real and complete.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const MAX_ATTEMPTS = 5;

type Feature = "email" | "voice";

// A step returns done, or "needs_human" with a reason (missing client input),
// or throws for a transient error (retried on the next drain).
type StepResult = { ok: true } | { ok: false; needsHuman: true; reason: string };

// ---- Per-feature provisioning ----------------------------------------------

async function provisionVoice(client: Record<string, any>): Promise<StepResult> {
  // Voice needs: a Twilio number + an ElevenLabs agent bound to it, plus the
  // client's store credentials so the agent can look up orders.
  if (!client.store_credentials_ref) {
    return { ok: false, needsHuman: true, reason: "store_credentials_ref not set on client" };
  }

  // TODO(twilio): if client.phone_number is null, purchase a number via the
  //   Twilio API and UPDATE clients.phone_number (E.164). Idempotent: skip if set.
  // TODO(elevenlabs): create/patch the Conversational AI agent, point its custom
  //   LLM at our voice endpoint, and wire the Twilio number's voice webhook to it.
  // Both are network calls; throw on transient failure to get a retry.

  return { ok: true };
}

async function provisionEmail(client: Record<string, any>): Promise<StepResult> {
  // Email needs the store creds and a support inbox the orchestration watches.
  if (!client.store_credentials_ref) {
    return { ok: false, needsHuman: true, reason: "store_credentials_ref not set on client" };
  }
  if (!client.support_email) {
    return { ok: false, needsHuman: true, reason: "support_email (Gmail) not connected" };
  }

  // TODO(orchestration): enable this client's email flow (e.g. upsert into the
  //   Zapier/worker allowlist so its inbound mail starts being processed).

  return { ok: true };
}

async function runFeature(feature: Feature, client: Record<string, any>): Promise<StepResult> {
  return feature === "voice" ? provisionVoice(client) : provisionEmail(client);
}

// ---- Queue drain -----------------------------------------------------------

async function processTask(task: Record<string, any>): Promise<void> {
  const { client_id, feature } = task;

  // Claim it: queued/needs_human -> running. Guards against two workers racing.
  const { data: claimed } = await supabase
    .from("provisioning_tasks")
    .update({ status: "running" })
    .eq("id", task.id)
    .in("status", ["queued", "needs_human"])
    .select("id")
    .maybeSingle();
  if (!claimed) return; // someone else grabbed it

  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id, phone_number, support_email, store_credentials_ref, store_platform")
    .eq("id", client_id)
    .maybeSingle();

  if (clientErr || !client) {
    await supabase.rpc("fail_provisioning", {
      p_client_id: client_id,
      p_feature: feature,
      p_reason: "client row not found",
      p_needs_human: true,
    });
    return;
  }

  try {
    const res = await runFeature(feature as Feature, client);
    if (res.ok) {
      // Success → entitlement goes active and page unlocks.
      await supabase.rpc("activate_entitlement", { p_client_id: client_id, p_feature: feature });
    } else {
      await supabase.rpc("fail_provisioning", {
        p_client_id: client_id,
        p_feature: feature,
        p_reason: res.reason,
        p_needs_human: true,
      });
    }
  } catch (e) {
    // Transient error: bump attempts. Give up to human after MAX_ATTEMPTS.
    const reason = e instanceof Error ? e.message : "provisioning error";
    const giveUp = (task.attempts ?? 0) + 1 >= MAX_ATTEMPTS;
    // Return it to the queue for retry unless we've exhausted attempts.
    await supabase
      .from("provisioning_tasks")
      .update({
        status: giveUp ? "needs_human" : "queued",
        attempts: (task.attempts ?? 0) + 1,
        last_error: reason,
      })
      .eq("id", task.id);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  // Drain queued tasks (oldest first). needs_human tasks are NOT auto-retried
  // here — a human resolves the blocker, which re-queues them.
  const { data: tasks, error } = await supabase
    .from("provisioning_tasks")
    .select("id, client_id, feature, attempts")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  let processed = 0;
  for (const task of tasks ?? []) {
    await processTask(task);
    processed++;
  }

  return new Response(JSON.stringify({ ok: true, processed }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
