// =============================================================================
// voice-ticket — ElevenLabs server tool `request_callback`.
//
// The agent calls this mid-call when it can't finish the job on the line:
// outside business hours, a failed transfer, a flagged order, or the caller
// simply asking for a person. It captures the callback as DATA — number,
// window, one-line reason — instead of leaving it as spoken words buried in a
// transcript nobody will read.
//
// This is the only escalation path Tsunami has: there is no human line
// configured yet, so a ticket IS the escalation.
//
// Returns { ticket_no, ticket_no_spoken } so the agent can read a reference
// back. A retried call returns the SAME number — see create_ticket in 0014.
//
// Auth: header  x-voice-tool-secret: <VOICE_TOOL_SECRET>  (same shared secret
// as voice-order-lookup).
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (JSON; ["default"] = service role),
//      VOICE_TOOL_SECRET.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  buildDetails,
  buildExternalRef,
  extractClientRef,
  normalizePhone,
  normalizePriority,
  spokenTicketNumber,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");

const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)[
  "default"
];
if (!SERVICE_ROLE_SECRET) {
  throw new Error("SUPABASE_SECRET_KEYS['default'] (service role) not found.");
}

type TicketRequest = {
  called_number?: string; // PHONE
  client_ref?: string; // WEB (slug)
  client_slug?: string;
  call_sid?: string;
  conversation_id?: string;
  caller_number?: string; // Twilio "From" — the default callback number
  caller_name?: string;
  callback_number?: string; // what the caller confirmed, if different
  callback_window?: string; // "after 3pm", "any time tomorrow"
  reason?: string; // one-sentence summary from the agent
  order_number?: string;
  priority?: string;
};

type TicketResponse = {
  ok: boolean;
  ticket_no?: number;
  ticket_no_spoken?: string; // "ten forty-two" — what the agent should SAY
  duplicate?: boolean;
  callback_number?: string | null;
  message?: string;
  error?: string;
};

function json(payload: TicketResponse, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", Connection: "keep-alive" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  if (VOICE_TOOL_SECRET) {
    if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
  }

  let body: TicketRequest;
  try {
    body = (await req.json()) as TicketRequest;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { calledNumber, clientSlug, conversationRef } = extractClientRef(body);
  if (!calledNumber && !clientSlug) {
    return json({ ok: false, error: "Missing called_number or client_ref" }, 400);
  }

  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Resolve the tenant — dialed number (phone) or slug (web).
  let clientId: string | null = null;

  if (calledNumber) {
    const { data, error } = await supabase.rpc("resolve_client_by_number", {
      p_called_number: calledNumber,
    });
    if (error) return json({ ok: false, error: error.message }, 400);
    clientId = (data as string | null) ?? null;
  } else {
    // Same opt-in gate as voice-order-lookup: a slug is public (it sits in the
    // page's HTML), so it identifies a tenant but never authorizes one.
    const { data: row, error } = await supabase
      .from("clients")
      .select("id, is_active, settings")
      .eq("slug", clientSlug)
      .maybeSingle();
    if (error) return json({ ok: false, error: error.message }, 400);
    if (row && row.is_active !== false) {
      const settings = (row.settings ?? {}) as Record<string, unknown>;
      if (settings.web_lookup_enabled === true || settings.is_demo === true) {
        clientId = row.id as string;
      }
    }
  }

  if (!clientId) {
    return json({
      ok: false,
      error: "unknown_client",
      message: "This line isn't configured. Apologize and end the call.",
    });
  }

  // 2) Make sure the conversation exists so the ticket links to the call.
  //    Idempotent — the order lookup has usually already done this.
  let conversationId: string | null = null;
  if (conversationRef) {
    const { data: convId } = await supabase.rpc("ingest_call", {
      p_client_id: clientId,
      p_call_sid: conversationRef,
      p_caller_identifier: body.caller_number ?? null,
      p_caller_name: body.caller_name ?? null,
      p_order_number: body.order_number ?? null,
    });
    conversationId = (convId as string | null) ?? null;
  }

  // 3) Callback number: what the caller confirmed, else the number they're
  //    calling from. On web there IS no caller number, so the agent must have
  //    collected one — without it the ticket isn't actionable.
  const callbackNumber =
    normalizePhone(body.callback_number) ?? normalizePhone(body.caller_number);

  if (!callbackNumber) {
    return json({
      ok: false,
      error: "callback_number_required",
      message:
        "Ask the caller for the best number to reach them, read it back digit by digit to confirm, then call this tool again.",
    });
  }

  // 4) Create the ticket. external_ref makes a retried tool call return the
  //    SAME ticket number the agent already read out loud.
  const { data: result, error: ticketErr } = await supabase.rpc("create_ticket", {
    p_client_id: clientId,
    p_conversation_id: conversationId,
    p_reason: "callback_request",
    p_details: buildDetails({
      reason: body.reason,
      orderNumber: body.order_number,
    }),
    p_priority: normalizePriority(body.priority),
    p_callback_number: callbackNumber,
    p_callback_window: body.callback_window ?? null,
    p_external_ref: buildExternalRef(conversationRef),
    p_channel: calledNumber ? "voice" : "web",
    p_due_at: null,
  });

  if (ticketErr || !result?.ok) {
    console.error("create_ticket failed", ticketErr?.message ?? result?.error);
    return json({
      ok: false,
      error: "ticket_failed",
      // Never tell the caller a ticket exists when it doesn't.
      message:
        "Couldn't save the callback. Apologize, give the support email, and end the call. Do not promise a call back.",
    });
  }

  const ticketNo = Number(result.ticket_no);

  return json({
    ok: true,
    ticket_no: ticketNo,
    ticket_no_spoken: spokenTicketNumber(ticketNo),
    duplicate: Boolean(result.duplicate),
    callback_number: callbackNumber,
    message:
      "Confirm the callback: say the reference number using ticket_no_spoken, restate the number you'll call back on, and say someone will be in touch during the next business window. Do NOT promise a specific time. Then end the call.",
  });
});
