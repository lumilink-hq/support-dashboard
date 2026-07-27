// =============================================================================
// scheduling — server tool for the ElevenLabs scheduling agent ("Lumi").
//
// One endpoint, three actions (ElevenLabs sends `action`):
//   check_availability -> compute open slots (Supabase-native, tz-aware)
//   book               -> book the appointment atomically (revenue snapshot)
//   capture_lead       -> caller didn't book; keep the lead
//
// Source of truth is Supabase (the app renders its own calendar); no external
// calendar in the MVP. Auth: x-voice-tool-secret header, same as the other tools.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { formatLabel, generateSlots, isWithinHours } from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
// Fail CLOSED: this endpoint writes bookings into tenant calendars, so a missing
// tool secret must refuse to boot — never silently serve an unauthenticated,
// internet-reachable endpoint. (Previously the header check was skipped when the
// secret was unset, which quietly opened the endpoint.)
if (!VOICE_TOOL_SECRET) {
  throw new Error("VOICE_TOOL_SECRET is required (endpoint refuses to run open).");
}
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)[
  "default"
];
if (!SERVICE_ROLE_SECRET) {
  throw new Error("SUPABASE_SECRET_KEYS['default'] (service role) not found.");
}

type Body = {
  action?:
    | "check_availability"
    | "book"
    | "capture_lead"
    | "find_appointment"
    | "cancel"
    | "reschedule";
  called_number?: string;
  caller_number?: string;
  call_sid?: string;
  service_name?: string;
  // book / reschedule:
  appointment_start?: string; // ISO 8601 with offset
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
  service_address?: string;
  is_emergency?: boolean;
  notes?: string;
  // find_appointment / cancel / reschedule:
  appointment_id?: string;
  reason?: string;
  // check_availability:
  from_date?: string; // ISO date to start scanning (optional)
  // capture_lead:
  issue?: string;
  // diagnostics:
  debug?: boolean;
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", Connection: "keep-alive" },
  });
}

type SchedulingConfig = {
  timezone: string;
  hours: Record<string, string[]>;
  slot_granularity_minutes: number;
  min_notice_minutes: number;
};

function readSchedulingConfig(settings: any): SchedulingConfig {
  const s = settings?.scheduling ?? {};
  return {
    timezone: s.timezone ?? "America/Los_Angeles",
    hours: s.hours ?? {},
    slot_granularity_minutes: s.slot_granularity_minutes ?? 30,
    min_notice_minutes: s.min_notice_minutes ?? 120,
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  // VOICE_TOOL_SECRET is guaranteed present (boot check above), so always enforce.
  if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const calledNumber = body.called_number?.trim();
  if (!calledNumber) return json({ error: "Missing called_number" }, 400);

  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Resolve tenant from the dialed number.
  const { data: clientId, error: resolveErr } = await supabase.rpc(
    "resolve_client_by_number",
    { p_called_number: calledNumber },
  );
  if (resolveErr) return json({ error: resolveErr.message }, 400);
  if (!clientId) return json({ found: false, unknown_number: true });

  // Client scheduling config. Parse defensively in case `settings` comes back as
  // a JSON string rather than a parsed object in the edge runtime.
  const { data: client } = await supabase
    .from("clients")
    .select("name, settings")
    .eq("id", clientId)
    .maybeSingle();
  let settings: any = client?.settings ?? {};
  if (typeof settings === "string") {
    try { settings = JSON.parse(settings); } catch { settings = {}; }
  }
  const cfg = readSchedulingConfig(settings);

  // Resolve the service (by name) when one is relevant.
  async function resolveService(name?: string) {
    if (!name) return null;
    const { data } = await supabase
      .from("services")
      .select("id, name, default_duration_min, price_type, price, callout_fee")
      .eq("client_id", clientId)
      .eq("active", true)
      .ilike("name", `%${name.trim()}%`)
      .limit(1);
    return data?.[0] ?? null;
  }

  // Existing bookings (busy ranges) for the next window.
  async function busyRanges(fromMs: number, days: number) {
    const toIso = new Date(fromMs + days * 86_400_000).toISOString();
    const { data } = await supabase
      .from("appointments")
      .select("starts_at, ends_at")
      .eq("client_id", clientId)
      .not("status", "in", "(cancelled,no_show)")
      .lte("starts_at", toIso);
    return (data ?? []).map((a: any) => ({
      start: new Date(a.starts_at).getTime(),
      end: new Date(a.ends_at).getTime(),
    }));
  }

  const action = body.action ?? "check_availability";
  const nowMs = Date.now();

  // Reject agent-proposed times that are in the past, inside the min-notice
  // window, or outside business hours. The DB exclusion constraint only guards
  // double-booking; these are the other ways a hallucinated/misheard time slips
  // through. Returns a caller-facing error, or null when the start is valid.
  function validateStart(
    startMs: number,
    durationMin: number,
  ): { reason: string; message: string } | null {
    if (Number.isNaN(startMs) || startMs <= nowMs) {
      return {
        reason: "past_time",
        message: "That time is in the past — offer an upcoming slot from check_availability.",
      };
    }
    if (startMs < nowMs + cfg.min_notice_minutes * 60_000) {
      return {
        reason: "too_soon",
        message: "That's inside the minimum-notice window — offer a later slot.",
      };
    }
    if (!isWithinHours(startMs, durationMin, cfg.hours, cfg.timezone)) {
      return {
        reason: "outside_hours",
        message: "That's outside business hours — offer a slot from check_availability instead.",
      };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  if (action === "check_availability") {
    const svc = await resolveService(body.service_name);
    const durationMin = svc?.default_duration_min ?? 60;
    // Optional from_date. A date-only value (YYYY-MM-DD) is anchored to noon UTC
    // so it lands on the intended LOCAL day — a bare date parses as UTC midnight,
    // which is the previous day in US timezones. Never scan into the past.
    let fromMs = nowMs;
    if (body.from_date) {
      const raw = body.from_date.trim();
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00Z` : raw;
      const parsed = Date.parse(iso);
      if (!Number.isNaN(parsed)) fromMs = Math.max(parsed, nowMs);
    }
    const busy = await busyRanges(fromMs, 14);
    const slots = generateSlots({
      hours: cfg.hours,
      timeZone: cfg.timezone,
      durationMin,
      granularityMin: cfg.slot_granularity_minutes,
      minNoticeMin: cfg.min_notice_minutes,
      nowMs,
      busy,
      fromMs,
      days: 14,
      limit: 6,
    });
    let _debug: unknown = undefined;
    if (body.debug) {
      const { count: clientsVisible } = await supabase
        .from("clients").select("id", { count: "exact", head: true });
      const { count: servicesVisible } = await supabase
        .from("services").select("id", { count: "exact", head: true });
      _debug = {
        client: client?.name ?? null,
        client_id_raw: clientId,
        client_id_type: typeof clientId,
        clients_visible: clientsVisible,   // 0 => the function's key can't read tables (RLS/key)
        services_visible: servicesVisible,
        hours_days: Object.keys(cfg.hours),
        service_found: Boolean(svc),
        busy_count: busy.length,
        now: new Date(nowMs).toISOString(),
      };
    }

    return json({
      ok: true,
      service: svc?.name ?? body.service_name ?? null,
      duration_min: durationMin,
      timezone: cfg.timezone,
      slots, // [{ start, end, label }]
      message: slots.length
        ? "Offer the caller 2-3 of these times."
        : "No open slots in the next two weeks — offer a callback.",
      ...(_debug ? { _debug } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  if (action === "book") {
    const startIso = body.appointment_start?.trim();
    if (!startIso || Number.isNaN(Date.parse(startIso))) {
      return json({ ok: false, reason: "bad_start", message: "Need a valid appointment_start (ISO 8601)." });
    }
    const svc = await resolveService(body.service_name);
    const durationMin = svc?.default_duration_min ?? 60;
    const startMs = Date.parse(startIso);

    // Guard past / too-soon / outside-hours before we touch the DB.
    const invalid = validateStart(startMs, durationMin);
    if (invalid) return json({ ok: false, ...invalid });

    const endIso = new Date(startMs + durationMin * 60_000).toISOString();

    // Link the conversation (voice) if we have a call SID.
    let convId: string | null = null;
    if (body.call_sid) {
      const { data: cid } = await supabase.rpc("ingest_call", {
        p_client_id: clientId,
        p_call_sid: body.call_sid,
        p_caller_identifier: body.caller_number ?? null,
        p_caller_name: body.customer_name ?? null,
        p_order_number: null,
      });
      convId = cid ?? null;
    }

    const { data: result, error } = await supabase.rpc("book_appointment", {
      p_client_id: clientId,
      p_service_id: svc?.id ?? null,
      p_service_name: svc?.name ?? body.service_name ?? null,
      p_conversation_id: convId,
      p_customer_name: body.customer_name ?? null,
      p_customer_email: body.customer_email ?? null,
      p_customer_phone: body.customer_phone ?? body.caller_number ?? null,
      p_service_address: body.service_address ?? null,
      p_is_emergency: Boolean(body.is_emergency),
      p_starts_at: startIso,
      p_ends_at: endIso,
      p_timezone: cfg.timezone,
      p_notes: body.notes ?? null,
      p_source: body.call_sid ? "voice" : "web",
    });
    if (error) return json({ ok: false, error: error.message }, 400);

    if (!result?.ok) {
      return json({
        ok: false,
        reason: result?.reason ?? "unknown",
        message: "That time was just taken — offer another slot.",
      });
    }
    return json({
      ok: true,
      appointment_id: result.appointment_id,
      service: result.service_name,
      when: formatLabel(startIso, cfg.timezone),
      message: "Booked. Confirm the time back to the caller and close politely.",
    });
  }

  // ---------------------------------------------------------------------------
  if (action === "capture_lead") {
    // A phone call carries a call_sid; a web/widget lead does not. Synthesize a
    // stable ref for the web case so ingest_call still creates a conversation —
    // otherwise the lead was silently dropped (the old code returned ok:true while
    // persisting nothing whenever call_sid was absent).
    const callSid = body.call_sid ?? `web-${crypto.randomUUID()}`;
    const { data: cid } = await supabase.rpc("ingest_call", {
      p_client_id: clientId,
      p_call_sid: callSid,
      p_caller_identifier: body.caller_number ?? body.customer_phone ?? null,
      p_caller_name: body.customer_name ?? null,
      p_order_number: null,
    });
    const convId = cid ?? null;
    if (convId) {
      await supabase.rpc("capture_lead", {
        p_conversation_id: convId,
        p_customer_name: body.customer_name ?? null,
        p_customer_phone: body.customer_phone ?? body.caller_number ?? null,
        p_outcome: "lead_only",
      });
    }
    return json({
      ok: Boolean(convId),
      message: convId
        ? "Lead saved. A team member will follow up."
        : "Couldn't save the lead just now — take the caller's details and follow up manually.",
    });
  }

  // ---------------------------------------------------------------------------
  // find_appointment — look up the caller's upcoming appointment(s) so they can be
  // cancelled or rescheduled. Phone-first (the number they're calling from), name
  // as a fallback. The agent confirms which one before acting.
  if (action === "find_appointment") {
    const phone = body.customer_phone ?? body.caller_number ?? null;
    const { data, error } = await supabase.rpc("find_appointments", {
      p_client_id: clientId,
      p_customer_phone: phone,
      p_customer_name: body.customer_name ?? null,
    });
    if (error) return json({ ok: false, error: error.message }, 400);
    const rows = (data ?? []) as Array<Record<string, any>>;
    const appointments = rows.map((a) => ({
      appointment_id: a.appointment_id,
      service: a.service_name,
      when: formatLabel(a.starts_at, a.timezone ?? cfg.timezone),
      start: a.starts_at,
      status: a.status,
      address: a.service_address ?? null,
    }));
    return json({
      ok: true,
      count: appointments.length,
      appointments,
      message: appointments.length === 0
        ? "No upcoming appointment found for that caller — offer to book one or take a message."
        : appointments.length === 1
        ? "One appointment found. Read it back and confirm it's the right one before changing it."
        : "Several appointments — read them out and let the caller pick which one.",
    });
  }

  // ---------------------------------------------------------------------------
  // cancel — cancel an appointment found via find_appointment. Frees the slot.
  if (action === "cancel") {
    const id = body.appointment_id?.trim();
    if (!id) {
      return json({ ok: false, reason: "missing_id", message: "Call find_appointment first, then cancel by appointment_id." });
    }
    const { data, error } = await supabase.rpc("cancel_appointment", {
      p_client_id: clientId,
      p_appointment_id: id,
      p_reason: body.reason ?? body.notes ?? null,
    });
    if (error) return json({ ok: false, error: error.message }, 400);
    if (!data?.ok) {
      return json({ ok: false, reason: data?.reason ?? "unknown", message: "Couldn't find that appointment to cancel — re-check with find_appointment." });
    }
    return json({
      ok: true,
      service: data.service_name,
      when: formatLabel(data.starts_at, cfg.timezone),
      message: "Cancelled. Confirm to the caller and ask if there's anything else.",
    });
  }

  // ---------------------------------------------------------------------------
  // reschedule — move an appointment (found via find_appointment) to a new start
  // from check_availability. Same duration; a clash returns slot_unavailable.
  if (action === "reschedule") {
    const id = body.appointment_id?.trim();
    const startIso = body.appointment_start?.trim();
    if (!id) {
      return json({ ok: false, reason: "missing_id", message: "Call find_appointment first, then reschedule by appointment_id." });
    }
    if (!startIso || Number.isNaN(Date.parse(startIso))) {
      return json({ ok: false, reason: "bad_start", message: "Need a valid new appointment_start (an ISO start from check_availability)." });
    }
    // Same past / too-soon / outside-hours guard as book. Duration is derived in
    // the RPC, so validate that the new start lands inside the open window.
    const invalidResched = validateStart(Date.parse(startIso), 0);
    if (invalidResched) return json({ ok: false, ...invalidResched });
    const { data, error } = await supabase.rpc("reschedule_appointment", {
      p_client_id: clientId,
      p_appointment_id: id,
      p_new_starts_at: startIso,
    });
    if (error) return json({ ok: false, error: error.message }, 400);
    if (!data?.ok) {
      const reason = data?.reason ?? "unknown";
      const messages: Record<string, string> = {
        slot_unavailable: "That new time was just taken — offer another slot and try again.",
        already_started: "That appointment has already passed — don't move it; offer to book a new visit instead.",
        past_time: "The new time must be in the future — offer an upcoming slot from check_availability.",
        not_found: "Couldn't find that appointment to reschedule — re-check with find_appointment.",
      };
      return json({
        ok: false,
        reason,
        message: messages[reason] ?? "Couldn't reschedule — re-check with find_appointment.",
      });
    }
    return json({
      ok: true,
      service: data.service_name,
      when: formatLabel(data.starts_at, cfg.timezone),
      message: "Rescheduled. Confirm the new time to the caller.",
    });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
