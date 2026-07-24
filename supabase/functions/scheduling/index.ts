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
import { formatLabel, generateSlots } from "./lib.ts";

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

type Body = {
  action?: "check_availability" | "book" | "capture_lead";
  called_number?: string;
  caller_number?: string;
  call_sid?: string;
  service_name?: string;
  // book:
  appointment_start?: string; // ISO 8601 with offset
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
  service_address?: string;
  is_emergency?: boolean;
  notes?: string;
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
  if (VOICE_TOOL_SECRET && req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
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
    if (convId) {
      await supabase.rpc("capture_lead", {
        p_conversation_id: convId,
        p_customer_name: body.customer_name ?? null,
        p_customer_phone: body.customer_phone ?? body.caller_number ?? null,
        p_outcome: "lead_only",
      });
    }
    return json({ ok: true, message: "Lead saved. A team member will follow up." });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
