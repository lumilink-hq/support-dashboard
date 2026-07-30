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
  extractDurationSecs,
  usageKeyFor,
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

/**
 * True when a client has opted in to slug (web widget) routing.
 *
 * MUST match voice-order-lookup and voice-ticket, which accept
 * `web_lookup_enabled === true || is_demo === true`. Checking `is_demo` alone
 * (as this did) meant a real web-widget client was rejected as unknown_tenant —
 * so the call was never logged AND never metered, which quietly defeats the
 * usage cap on the one channel where an unattended public embed makes it matter.
 *
 * `settings` may arrive as a JSON string in the edge runtime.
 */
function webRoutingAllowed(settings: unknown): boolean {
  let s = settings;
  if (typeof s === "string") {
    try { s = JSON.parse(s); } catch { return false; }
  }
  const o = (s ?? {}) as Record<string, unknown>;
  return o.web_lookup_enabled === true || o.is_demo === true;
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

  // Diagnostic: surface where the phone fields actually live in the payload, so
  // Supabase → Edge Functions → voice-call-logger → Logs shows the real shape.
  console.log(
    "voice-call-logger:",
    JSON.stringify({
      type: payload?.type,
      data_keys: Object.keys(payload?.data ?? {}),
      metadata_keys: Object.keys((payload?.data as any)?.metadata ?? {}),
      phone_call: (payload?.data as any)?.metadata?.phone_call ?? null,
      dv_keys: Object.keys(
        payload?.data?.conversation_initiation_client_data
          ?.dynamic_variables ?? {},
      ),
      transcript_len: (payload?.data?.transcript ?? []).length,
      extracted: f,
    }),
  );

  // Use the Twilio call SID when present, else fall back to ElevenLabs'
  // conversation id (web/SIP calls have no call SID). Either serves as the
  // conversation's external_ref.
  const ref = f.callSid ?? f.elevenConversationId;
  // We need a reference AND a way to resolve the tenant: a dialed number (phone)
  // or a client slug (web widget). A browser session has only the slug.
  if (!ref || (!f.calledNumber && !f.clientSlug)) {
    return json(
      {
        error:
          "Could not extract a call reference plus a dialed number or client slug from the payload",
      },
      400,
    );
  }

  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Resolve the tenant. Phone → by dialed number. Web widget → by slug, but
  //    ONLY for clients that opted in to web routing (mirrors voice-order-lookup
  //    and voice-ticket), so a public browser session can never attach to a
  //    client who didn't ask for it.
  let clientId: string | null = null;
  if (f.calledNumber) {
    const { data, error } = await supabase.rpc("resolve_client_by_number", {
      p_called_number: f.calledNumber,
    });
    if (error) return json({ error: error.message }, 400);
    clientId = (data as string | null) ?? null;
  } else if (f.clientSlug) {
    const { data } = await supabase
      .from("clients")
      .select("id, settings")
      .eq("slug", f.clientSlug)
      .eq("is_active", true)
      .maybeSingle();
    if (data && webRoutingAllowed(data.settings)) clientId = data.id as string;
  }
  if (!clientId) {
    return json({ ok: false, unknown_tenant: true, call_ref: ref });
  }

  // 2) Ensure the conversation exists (idempotent; the lookup tool usually made
  //    it already). Returns the conversation id we log turns against.
  const { data: convId, error: convErr } = await supabase.rpc("ingest_call", {
    p_client_id: clientId,
    p_call_sid: ref,
    p_caller_identifier: f.callerId,
    p_caller_name: null,
    p_order_number: null, // preserve any order number set mid-call (coalesced)
  });
  if (convErr) return json({ error: convErr.message }, 400);

  // 3) Append transcript turns. The final turn closes the conversation; an
  //    escalation below may override it to 'flagged'.
  //
  //    'closed', NOT 'resolved'. This used to write 'resolved' on every call,
  //    which meant every conversation in the dashboard read as resolved whether
  //    or not anything had been. 'resolved' should mean a person dealt with it;
  //    a call simply ending is 'closed'. Both are allowed by the CHECK in 0001,
  //    and nothing keys off the value — it renders as a badge — so this is a
  //    display-truth fix, not a behaviour change.
  const turns = buildTurns(payload?.data?.transcript, ref);
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
      p_new_status: isLast ? "closed" : null,
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
      p_details: `Voice call ${ref} flagged: ${flagReason}.`,
    });
  }

  // 5) Usage limiter, layer 4 — the meter.
  //    This is what makes layers 1 and 3 able to decide anything: without it the
  //    caps sit in the database and nothing ever counts toward them. Runs last
  //    and never fails the request — a metering problem must not cost us the
  //    transcript we already wrote.
  let metered = false;
  const usageKey = usageKeyFor(f);
  if (usageKey) {
    const durationSecs = extractDurationSecs(payload);
    const { data: usage, error: usageErr } = await supabase.rpc(
      "record_call_usage",
      {
        p_client_id: clientId,
        p_call_sid: usageKey,
        p_duration_secs: durationSecs,
        // Cost is derived server-side from duration x the client's rate.
        p_est_cost_usd: null,
        p_started_at: null,
        p_source: "post_call",
      },
    );

    if (usageErr) {
      console.error("record_call_usage failed:", usageErr.message);
    } else if (usage?.duplicate) {
      // Expected on a webhook retry, and worth seeing: a silent double-count
      // would falsely trip the cap and take the client's line down.
      console.log("usage already recorded for", usageKey);
      metered = true;
    } else {
      metered = true;
      if (usage?.crossed_warning) {
        // True on exactly one call — the one that crosses 80%. This is the hook
        // for the "someone should decide whether to raise the cap" alert; it
        // wants to become an email alongside the ticket notifications.
        console.warn("VOICE CAP 80%", {
          client_id: clientId,
          minutes_used: usage.minutes_used,
          minutes_cap: usage.minutes_cap,
        });
      }
    }
  } else {
    // Neither a Twilio call SID nor an ElevenLabs conversation id — the call is
    // unmeterable. Shouldn't happen (we bailed earlier without a `ref`), so log
    // loudly rather than silently under-counting against the cap.
    console.error("no usage key for call; not metered", { conversation_id: convId });
  }

  return json({
    ok: true,
    conversation_id: convId,
    turns_logged: logged,
    flagged,
    flag_reason: flagReason,
    metered,
  });
});