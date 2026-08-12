// =============================================================================
// provision-feature — the "as automatic as possible" worker.
//
// After a payment, apply_billing_event creates a 'pending' entitlement and a
// 'queued' provisioning_task. This worker drains that queue and stands up the
// feature's infrastructure, then flips the entitlement to 'active' so the
// dashboard page unlocks itself with no human in the loop.
//
// VOICE (scheduling MVP) is now IMPLEMENTED end-to-end:
//   1. Ensure the client has a phone number — reuse clients.phone_number
//      (bring-your-own) or, when AUTO_PURCHASE_NUMBERS=1, buy a voice-capable US
//      local number via the Twilio API and save it.
//   2. Import that number into ElevenLabs (POST /v1/convai/phone-numbers) and
//      assign it to the ONE shared agent (PATCH …/{id} { agent_id }). Idempotent:
//      we list existing numbers first and skip if it's already on our agent.
// A scheduling client does NOT need store credentials — that gate now applies
// only to clients that actually use order lookup (store_platform set).
//
// Safety:
//   * PROVISION_MODE defaults to 'mock' — NO external calls, control flow only,
//     so you can exercise the queue without buying anything. Set 'live' to arm.
//   * Missing client input (no number + auto-purchase off, missing creds) parks
//     the task 'needs_human' (entitlement stays 'pending' → dashboard shows
//     "setting up…"); it never half-activates.
//   * Transient (5xx/network) errors throw and are retried up to MAX_ATTEMPTS;
//     4xx/config errors go straight to needs_human.
//
// Trigger options (pick per ops preference):
//   * cron (Supabase scheduled function) every minute — simplest, hands-off
//   * called fire-and-forget by billing-webhook right after a grant
// It always drains the whole queue, so double-triggering is harmless.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS,
//      PROVISION_MODE ('mock'|'live'), AUTO_PURCHASE_NUMBERS ('0'|'1'),
//      TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_AREA_CODE (optional),
//      ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID (the shared agent).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

// External-provider config. 'mock' (default) makes NO external calls.
const PROVISION_MODE = (Deno.env.get("PROVISION_MODE") ?? "mock").toLowerCase();
const LIVE = PROVISION_MODE === "live";
const AUTO_PURCHASE = (Deno.env.get("AUTO_PURCHASE_NUMBERS") ?? "0") === "1";

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const DEFAULT_AREA_CODE = Deno.env.get("TWILIO_AREA_CODE") ?? "";

const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY") ?? "";
const ELEVENLABS_AGENT_ID = Deno.env.get("ELEVENLABS_AGENT_ID") ?? "";
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1/convai/phone-numbers";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const MAX_ATTEMPTS = 5;

// Fallback allowance for a grant with NO TIER — see applyPlanCaps. Entry tier
// from the CFO workbook v2.0: Starter = 100 min/mo.
//
// This used to be the ONLY allowance provisioning could apply, because the price
// map was feature-level and nothing here could tell a Scale purchase from a
// Starter one. 0031 added the tier layer; this constant now covers only the
// manual/trial grants that never went through checkout.
const STARTER_INCLUDED_MINUTES = Number(
  Deno.env.get("STARTER_INCLUDED_MINUTES") ?? 100,
);

// MUST stay BELOW the ElevenLabs agent's "max call duration" (currently 120s).
// ElevenLabs enforces its cap by severing the audio mid-sentence; this value is
// what voice-order-lookup's checkCallTime() measures against to make the agent
// wind down and say goodbye BEFORE that happens. Set it equal to or above the
// ElevenLabs cap and the wrap-up is scheduled for a moment that never arrives —
// every long call gets cut off. 105 leaves ~26s of runway. See 0025's header.
const MAX_CALL_SECS = Number(Deno.env.get("MAX_CALL_SECS") ?? 105);

type Feature = "email" | "voice";
type StepResult = { ok: true } | { ok: false; needsHuman: true; reason: string };

// A blocker that a human must clear (missing input, 4xx) — parks needs_human now.
class NeedsHumanError extends Error {}
// A transient failure (5xx / network) — requeued and retried.
class TransientError extends Error {}

function needsHuman(reason: string): StepResult {
  return { ok: false, needsHuman: true, reason };
}
function onlyDigits(s: string): string {
  return (s ?? "").replace(/\D/g, "");
}
function last10(s: string): string {
  return onlyDigits(s).slice(-10);
}

// ---- Twilio ----------------------------------------------------------------

function twilioAuth(): string {
  return "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
}

// Buy a voice-capable US local number. Returns the E.164 number, or null when no
// number is available (→ needs_human). Throws TransientError on 5xx/network.
async function twilioBuyNumber(areaCode: string): Promise<string | null> {
  const base = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}`;
  const q = new URLSearchParams({ VoiceEnabled: "true" });
  if (areaCode) q.set("AreaCode", areaCode);

  let availRes: Response;
  try {
    availRes = await fetch(`${base}/AvailablePhoneNumbers/US/Local.json?${q}`, {
      headers: { Authorization: twilioAuth() },
    });
  } catch (e) {
    throw new TransientError(`twilio availability network error: ${e}`);
  }
  if (availRes.status >= 500) throw new TransientError(`twilio availability ${availRes.status}`);
  const avail = await availRes.json().catch(() => ({}));
  if (!availRes.ok) {
    throw new NeedsHumanError(`twilio availability ${availRes.status}: ${avail?.message ?? ""}`);
  }
  const candidate = avail?.available_phone_numbers?.[0]?.phone_number as string | undefined;
  if (!candidate) return null;

  let buyRes: Response;
  try {
    buyRes = await fetch(`${base}/IncomingPhoneNumbers.json`, {
      method: "POST",
      headers: {
        Authorization: twilioAuth(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ PhoneNumber: candidate }),
    });
  } catch (e) {
    throw new TransientError(`twilio purchase network error: ${e}`);
  }
  if (buyRes.status >= 500) throw new TransientError(`twilio purchase ${buyRes.status}`);
  const bought = await buyRes.json().catch(() => ({}));
  if (!buyRes.ok) throw new NeedsHumanError(`twilio purchase ${buyRes.status}: ${bought?.message ?? ""}`);
  return (bought.phone_number as string) ?? candidate;
}

// ---- ElevenLabs ------------------------------------------------------------

function elevenHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = { "xi-api-key": ELEVENLABS_API_KEY };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

// ElevenLabs Twilio import body. Field names per the ConvAI phone-numbers API /
// SDK (provider discriminator + Twilio sid/token). If ElevenLabs renames these,
// this builder is the single place to change.
function twilioImportBody(number: string, label: string) {
  return {
    provider: "twilio",
    phone_number: number,
    label,
    sid: TWILIO_ACCOUNT_SID,
    token: TWILIO_AUTH_TOKEN,
  };
}

async function elevenList(): Promise<any[]> {
  let res: Response;
  try {
    res = await fetch(ELEVENLABS_BASE, { headers: elevenHeaders() });
  } catch (e) {
    throw new TransientError(`elevenlabs list network error: ${e}`);
  }
  if (res.status >= 500) throw new TransientError(`elevenlabs list ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new NeedsHumanError(`elevenlabs list ${res.status}: ${body?.detail ?? body?.message ?? ""}`);
  // The API returns an array (older) or { phone_numbers: [...] } (newer) — accept both.
  return Array.isArray(body) ? body : (body?.phone_numbers ?? []);
}

// Import (if needed) and assign the number to the shared agent. Idempotent.
async function elevenAttachNumber(number: string, label: string): Promise<void> {
  const target = last10(number);
  const existing = (await elevenList()).find((p) => last10(p?.phone_number ?? "") === target);

  let phoneId: string | undefined = existing?.phone_number_id;

  if (!phoneId) {
    // Need to import — that requires the Twilio creds ElevenLabs will store.
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      throw new NeedsHumanError("Twilio credentials required to import the number into ElevenLabs");
    }
    let res: Response;
    try {
      res = await fetch(ELEVENLABS_BASE, {
        method: "POST",
        headers: elevenHeaders(true),
        body: JSON.stringify(twilioImportBody(number, label)),
      });
    } catch (e) {
      throw new TransientError(`elevenlabs import network error: ${e}`);
    }
    if (res.status >= 500) throw new TransientError(`elevenlabs import ${res.status}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new NeedsHumanError(`elevenlabs import ${res.status}: ${body?.detail ?? body?.message ?? ""}`);
    phoneId = body?.phone_number_id;
    if (!phoneId) throw new NeedsHumanError("elevenlabs import returned no phone_number_id");
  } else if (existing?.assigned_agent?.agent_id === ELEVENLABS_AGENT_ID) {
    return; // already imported AND on our shared agent — nothing to do
  }

  // Assign (or correct the assignment of) our shared agent.
  let patch: Response;
  try {
    patch = await fetch(`${ELEVENLABS_BASE}/${phoneId}`, {
      method: "PATCH",
      headers: elevenHeaders(true),
      body: JSON.stringify({ agent_id: ELEVENLABS_AGENT_ID }),
    });
  } catch (e) {
    throw new TransientError(`elevenlabs assign network error: ${e}`);
  }
  if (patch.status >= 500) throw new TransientError(`elevenlabs assign ${patch.status}`);
  if (!patch.ok) {
    const body = await patch.json().catch(() => ({}));
    throw new NeedsHumanError(`elevenlabs assign ${patch.status}: ${body?.detail ?? body?.message ?? ""}`);
  }
}

// ---- Per-feature provisioning ----------------------------------------------

function readAreaCode(client: Record<string, any>): string {
  let s: any = client.settings ?? {};
  if (typeof s === "string") {
    try { s = JSON.parse(s); } catch { s = {}; }
  }
  const fromCfg = s?.scheduling?.area_code;
  return String(fromCfg ?? DEFAULT_AREA_CODE ?? "").replace(/\D/g, "").slice(0, 3);
}

// Which plan this client actually bought, as recorded on the entitlement by
// apply_billing_event (0031). Null for manual/trial grants, which never carried
// a Stripe price and so have no tier to read.
async function readPlanTier(
  clientId: string,
  feature: Feature,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("entitlements")
    .select("plan_tier")
    .eq("client_id", clientId)
    .eq("feature", feature)
    .maybeSingle();

  // A failed read must NOT silently become "no tier" — that would route a paid
  // Scale customer down the entry-allowance fallback, which is the exact bug
  // 0031 exists to end. Retrying is cheap; guessing is not.
  if (error) throw new TransientError(`could not read plan_tier: ${error.message}`);
  return (data?.plan_tier as string) ?? null;
}

// Pin the plan's minute allowance on the client BEFORE the line can take calls.
// Skipping this leaves the client on the platform default, which is not what
// they bought — a $179 / 100-minute client would run against whatever the
// default happens to be, at real ElevenLabs + Twilio cost per minute.
//
// TWO PATHS, and the split matters:
//
//   tier known (a checkout purchase) -> set_plan_tier_caps. The allowance comes
//     from plan_tiers, so Growth gets 250 and Scale gets 600. Raise-only, so an
//     operator's deliberate top-up survives re-provisioning and a payer can
//     never sit below what they bought. Before 0031 this branch did not exist
//     and every purchase, at every price, was provisioned with 100 minutes.
//
//   tier null (manual / trial grant) -> set_plan_voice_caps at the entry
//     allowance, exactly as before. Operators grant these by hand and set the
//     cap themselves; parking them for a missing tier would break a workflow
//     that is working fine.
//
// Runs in mock mode too: it's a local DB write, and mock only suppresses
// EXTERNAL calls. Getting the cap right is exactly what we want to exercise.
async function applyPlanCaps(
  clientId: string,
  planTier: string | null,
): Promise<StepResult> {
  const { data, error } = planTier
    ? await supabase.rpc("set_plan_tier_caps", {
        p_client_id: clientId,
        p_plan_tier: planTier,
        p_max_call_secs: MAX_CALL_SECS,
        // Raise-only. Never knocks a higher manual grant back down.
        p_overwrite: false,
      })
    : await supabase.rpc("set_plan_voice_caps", {
        p_client_id: clientId,
        p_monthly_minutes: STARTER_INCLUDED_MINUTES,
        p_max_call_secs: MAX_CALL_SECS,
        p_overwrite: false,
      });

  if (error) {
    // Missing RPC / permission problems won't fix themselves on retry.
    const fn = planTier ? "set_plan_tier_caps" : "set_plan_voice_caps";
    throw new NeedsHumanError(`${fn} failed: ${error.message}`);
  }
  if (data && data.ok === false) {
    // An unknown tier lands here rather than falling back to 100 minutes. The
    // customer waits on "setting up…" instead of quietly receiving a fraction
    // of their allowance — a visible failure beats an invisible one when money
    // has already changed hands.
    return needsHuman(
      `could not set voice caps${planTier ? ` for tier '${planTier}'` : ""}: ` +
        `${data.error ?? "unknown error"}`,
    );
  }
  return { ok: true };
}

async function provisionVoice(client: Record<string, any>): Promise<StepResult> {
  // Store credentials only matter if this client actually uses order lookup.
  // A pure scheduling (HVAC) client has no store_platform and needs none.
  if (client.store_platform && !client.store_credentials_ref) {
    return needsHuman("store_credentials_ref not set (order lookup is enabled for this client)");
  }

  // 0) Cap first. If this fails we stop before a live number exists, rather
  //    than after — an uncapped line that can answer is the expensive failure.
  const planTier = await readPlanTier(client.id, "voice");
  const capped = await applyPlanCaps(client.id, planTier);
  if (!capped.ok) return capped;

  // 1) Ensure a phone number.
  let number = String(client.phone_number ?? "").trim();
  if (!number) {
    if (!AUTO_PURCHASE) {
      return needsHuman("no phone number set — add one in Settings, or enable AUTO_PURCHASE_NUMBERS");
    }
    if (!LIVE) {
      return needsHuman("no phone number set; auto-purchase is disabled in mock mode (set PROVISION_MODE=live)");
    }
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      return needsHuman("TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not configured for auto-purchase");
    }
    const areaCode = readAreaCode(client);
    const bought = await twilioBuyNumber(areaCode);
    if (!bought) {
      return needsHuman(`no available Twilio numbers${areaCode ? " in area code " + areaCode : ""}`);
    }
    number = bought;
    const { error } = await supabase
      .from("clients")
      .update({ phone_number: number })
      .eq("id", client.id);
    if (error) throw new TransientError("failed to save purchased number: " + error.message);
  }

  // 2) Attach the number to the shared ElevenLabs agent.
  if (!LIVE) return { ok: true }; // mock: exercised the control flow, stop here
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    return needsHuman("ELEVENLABS_API_KEY/ELEVENLABS_AGENT_ID not configured");
  }
  await elevenAttachNumber(number, String(client.name ?? "Lumilink client"));
  return { ok: true };
}

async function provisionEmail(client: Record<string, any>): Promise<StepResult> {
  // Email needs the store creds and a support inbox the orchestration watches.
  if (!client.store_credentials_ref) {
    return needsHuman("store_credentials_ref not set on client");
  }
  if (!client.support_email) {
    return needsHuman("support_email (Gmail) not connected");
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
    .select("id, name, phone_number, support_email, store_credentials_ref, store_platform, settings")
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
    // A known blocker → needs_human immediately (retrying won't help).
    if (e instanceof NeedsHumanError) {
      await supabase.rpc("fail_provisioning", {
        p_client_id: client_id,
        p_feature: feature,
        p_reason: e.message,
        p_needs_human: true,
      });
      return;
    }
    // Transient/unexpected error: bump attempts, retry, give up to human after MAX.
    const reason = e instanceof Error ? e.message : "provisioning error";
    const giveUp = (task.attempts ?? 0) + 1 >= MAX_ATTEMPTS;
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

  return new Response(JSON.stringify({ ok: true, processed, mode: PROVISION_MODE }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
