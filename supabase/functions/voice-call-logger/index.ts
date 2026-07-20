// =============================================================================
// voice-call-logger — ElevenLabs post-call webhook handler.
//
// Fires once when a call ends. It closes the loop the mid-call lookup tool
// started: it writes the full transcript to the shared DB and, when warranted,
// creates the human review item so the call shows up in the dashboard queue.
//
// Everything is done through the 0006 RPCs (ingest_call / log_call_turn) plus
// the shared evaluate_flag / apply_flag, so this function holds no business
// rules of its own. Pure parsing/crypto helpers live in ./lib.ts (unit-tested).
//
// Auth: ElevenLabs signs with HMAC in the `ElevenLabs-Signature` header
//   (t=<unix>,v0=<hmac_sha256(`${t}.${rawBody}`)>). Set ELEVENLABS_WEBHOOK_SECRET
//   to enforce it. If unset, verification is SKIPPED (first-smoke-test mode) and
//   a warning is logged — set the secret before go-live.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role) — same
//   convention as the other functions. ELEVENLABS_WEBHOOK_SECRET (optional).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  buildTurns,
  detectHumanHandoff,
  extractCallFields,
  verifySignature,
  type PostCallPayload,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const WEBHOOK_SECRET = Deno.env.get("ELEVENLABS_WEBHOOK_SECRET");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");

const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)[
  "default"
];
if (!SERVICE_ROLE_SECRET) {
  throw new Error("SUPABASE_SECRET_KEYS['default'] (service role) not found.");
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", Connection: "keep-alive" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Read the raw body ONCE — signature verification must hash the exact bytes.
  const rawBody = await req.text();

  if (WEBHOOK_SECRET) {
    const result = await verifySignature({
      secret: WEBHOOK_SECRET,
      header: req.headers.get("ElevenLabs-Signature"),
      rawBody,
      nowSecs: Math.floor(Date.now() / 1000),
    });
    if (!result.valid) {
      return json({ error: `Invalid signature: ${result.reason}` }, 401);
    }
  } else {
    console.warn(
      "voice-call-logger: ELEVENLABS_WEBHOOK_SECRET unset — skipping signature check.",
    );
  }

  let payload: PostCallPayload;
  try {
    payload = JSON.parse(rawBody) as PostCallPayload;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (payload?.type && payload.type !== "post_call_transcription") {
    // Not a transcript event (e.g. audio) — ack so ElevenLabs doesn't retry.
    return json({ ok: true, ignored: payload.type });
  }

  const f = extractCallFields(payload);
  if (!f.callSid || !f.calledNumber) {
    return json(
      { error: "Missing system__call_sid / system__called_number in payload" },
      400,
    );
  }

  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Resolve tenant from the dialed number.
  const { data: clientId, error: resolveErr } = await supabase.rpc(
    "resolve_client_by_number",
    { p_called_number: f.calledNumber },
  );
  if (resolveErr) return json({ error: resolveErr.message }, 400);
  if (!clientId) {
    return json({ ok: false, unknown_number: true, call_sid: f.callSid });
  }

  // 2) Ensure the conversation exists (idempotent; the lookup tool usually made
  //    it already). Returns the conversation id we log turns against.
  const { data: convId, error: convErr } = await supabase.rpc("ingest_call", {
    p_client_id: clientId,
    p_call_sid: f.callSid,
    p_caller_identifier: f.callerId,
    p_caller_name: null,
    p_order_number: null, // preserve any order number set mid-call (coalesced)
  });
  if (convErr) return json({ error: convErr.message }, 400);

  // 3) Append transcript turns. The final turn advances status to 'resolved';
  //    an escalation below may override it to 'flagged'.
  const turns = buildTurns(payload?.data?.transcript, f.callSid);
  let logged = 0;
  for (let i = 0; i < turns.length; i++) {
    const isLast = i === turns.length - 1;
    const { error } = await supabase.rpc("log_call_turn", {
      p_conversation_id: convId,
      p_role: turns[i].role,
      p_body: turns[i].body,
      p_audio_url: null, // hook: pass a Storage URL here if recording is enabled
      p_model: null,
      p_turn_ref: turns[i].turnRef,
      p_new_status: isLast ? "resolved" : null,
    });
    if (!error) logged++;
  }

  // 4) Escalation → review queue.
  //    (a) order flagged: re-check the cached order against the shared rule.
  //    (b) human handoff: a transfer tool call appeared in the transcript.
  let flagged = false;
  let flagReason: string | null = null;

  const { data: conv } = await supabase
    .from("conversations")
    .select("order_number")
    .eq("id", convId)
    .maybeSingle();

  if (conv?.order_number) {
    const { data: order } = await supabase
      .from("orders_cache")
      .select("store_status, order_placed_at")
      .eq("client_id", clientId)
      .eq("order_number", conv.order_number)
      .maybeSingle();

    if (order) {
      const { data: flagEval } = await supabase.rpc("evaluate_flag", {
        p_client_id: clientId,
        p_store_status: order.store_status,
        p_order_placed_at: order.order_placed_at,
      });
      if (flagEval?.flagged) {
        flagged = true;
        flagReason = flagEval.reason ?? null;
      }
    }
  }

  if (!flagged && detectHumanHandoff(payload?.data?.transcript)) {
    flagged = true;
    flagReason = "caller_request";
  }

  if (flagged && flagReason) {
    await supabase.rpc("apply_flag", {
      p_conversation_id: convId,
      p_reason: flagReason,
      p_details: `Voice call ${f.callSid} flagged: ${flagReason}.`,
    });
  }

  return json({
    ok: true,
    conversation_id: convId,
    turns_logged: logged,
    flagged,
    flag_reason: flagReason,
  });
});
