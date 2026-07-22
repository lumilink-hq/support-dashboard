// =============================================================================
// voice-personalization — ElevenLabs conversation-initiation (personalization)
// webhook. THIS is what makes one shared agent multi-tenant.
//
// On every inbound call, before audio connects, ElevenLabs POSTs the dialed
// number here. We resolve the tenant from that number (same routing key as the
// email +slug and the other voice tools), load their config + service list, and
// return the per-call dynamic variables + a conversation override (system prompt,
// greeting) so the shared agent speaks as THAT business. No per-client agent,
// no per-client function — onboarding a client is just DB rows.
//
// Request body (ElevenLabs → us):
//   { caller_id, agent_id, called_number, call_sid }
// Response (us → ElevenLabs):
//   { dynamic_variables, conversation_config_override: { agent: { prompt, first_message, language } } }
//
// Auth: ElevenLabs signs this webhook with an HMAC in the `ElevenLabs-Signature`
// header (t=..,v0=hmac_sha256("t.rawBody")), exactly like the post-call webhook.
// Set ELEVENLABS_PERSONALIZATION_SECRET to enforce it. If unset, verification is
// SKIPPED (handy for a first smoke test) and a warning is logged — set it before
// go-live.
//
// Env (supabase secrets set ...):
//   SUPABASE_URL, SUPABASE_SECRET_KEYS  (JSON; ["default"] = service role) — same
//     convention as the other voice functions.
//   ELEVENLABS_PERSONALIZATION_SECRET   — webhook signing secret (optional; see above).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  buildFallbackResponse,
  buildResponse,
  extractClientRef,
  readClientConfig,
  verifySignature,
  type ServiceRow,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const WEBHOOK_SECRET = Deno.env.get("ELEVENLABS_PERSONALIZATION_SECRET");
// Lets our own server (the /demo page) fetch personalization for a web session
// without an ElevenLabs HMAC — same shared secret the other voice tools use.
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");

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

/** True when a client's settings mark it a demo (settings may be a JSON string). */
function isDemoClient(settings: unknown): boolean {
  let s = settings;
  if (typeof s === "string") {
    try { s = JSON.parse(s); } catch { return false; }
  }
  return Boolean((s as Record<string, unknown> | null)?.is_demo);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Read the raw body once — we need the exact bytes for HMAC verification.
  const rawBody = await req.text();

  // Auth: allow EITHER our internal caller (x-voice-tool-secret, used by the
  // /demo page for web sessions) OR a valid ElevenLabs HMAC (phone/webhook).
  const internalOk =
    Boolean(VOICE_TOOL_SECRET) &&
    req.headers.get("x-voice-tool-secret") === VOICE_TOOL_SECRET;

  if (!internalOk) {
    if (WEBHOOK_SECRET) {
      const result = await verifySignature({
        secret: WEBHOOK_SECRET,
        header: req.headers.get("ElevenLabs-Signature"),
        rawBody,
        nowSecs: Math.floor(Date.now() / 1000),
      });
      if (!result.valid) {
        return json({ error: `Unauthorized: ${result.reason}` }, 401);
      }
    } else {
      console.warn(
        "No ELEVENLABS_PERSONALIZATION_SECRET / VOICE_TOOL_SECRET — skipping auth.",
      );
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // Phone sends called_number; the web widget passes client_slug. Either routes.
  const { calledNumber, clientSlug } = extractClientRef(body);
  if (!calledNumber && !clientSlug) return json(buildFallbackResponse());

  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Resolve the tenant. Phone → by dialed number. Web → by slug, but ONLY for
  //    demo clients, so the public widget can never reach a real client's data.
  let clientId: string | null = null;
  if (calledNumber) {
    const { data, error } = await supabase.rpc("resolve_client_by_number", {
      p_called_number: calledNumber,
    });
    if (error) {
      console.error("resolve_client_by_number failed:", error.message);
      return json(buildFallbackResponse());
    }
    clientId = (data as string | null) ?? null;
  } else if (clientSlug) {
    const { data } = await supabase
      .from("clients")
      .select("id, settings")
      .eq("slug", clientSlug)
      .eq("is_active", true)
      .maybeSingle();
    if (data && isDemoClient(data.settings)) clientId = data.id as string;
  }
  if (!clientId) return json(buildFallbackResponse());

  // 2) Load the client row (non-secret config) + active services.
  const { data: clientRow, error: clientErr } = await supabase
    .from("clients")
    .select("name, slug, brand_tone_config, business_hours, settings")
    .eq("id", clientId)
    .maybeSingle();
  if (clientErr || !clientRow) {
    console.error("client load failed:", clientErr?.message);
    return json(buildFallbackResponse());
  }

  // `settings` may come back as a JSON string in the edge runtime — parse it.
  let clientData = clientRow as Record<string, unknown>;
  if (typeof clientData.settings === "string") {
    try {
      clientData = { ...clientData, settings: JSON.parse(clientData.settings as string) };
    } catch {
      clientData = { ...clientData, settings: {} };
    }
  }

  const { data: serviceRows } = await supabase
    .from("services")
    .select(
      "name, category, price_type, price, callout_fee, default_duration_min, emergency_eligible",
    )
    .eq("client_id", clientId)
    .eq("active", true)
    .order("name");

  const cfg = readClientConfig(clientData);
  const services = (serviceRows ?? []) as ServiceRow[];

  // 3) Return per-tenant personalization for this call.
  return json(buildResponse(cfg, services));
});
