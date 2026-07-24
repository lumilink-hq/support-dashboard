// =============================================================================
// lib.ts — pure, side-effect-free helpers for the voice-personalization function.
// Kept separate from index.ts (the Deno/Supabase wiring) so they can be unit
// tested in plain Node/tsx without a running Supabase or Deno. No imports.
//
// This is what turns ONE shared ElevenLabs agent into a multi-tenant agent: given
// a resolved client's config + service list, it builds the per-call system prompt,
// greeting, and dynamic variables that ElevenLabs applies as a conversation
// override. Adding a client is then just a `clients` row + `services` rows — no
// new agent, no new function.
// =============================================================================

// ---- Shapes (loose — the DB hands these back as jsonb) ----------------------

export type ServiceRow = {
  name: string;
  category?: string | null;
  price_type?: "fixed" | "quote" | string | null;
  price?: number | null;
  callout_fee?: number | null;
  default_duration_min?: number | null;
  emergency_eligible?: boolean | null;
};

export type ClientConfig = {
  name: string;
  slug: string; // tenant routing key on the web (analog of the dialed number)
  persona: string; // e.g. "Lumi"
  brandVoice: string; // e.g. "warm, professional, efficient"
  timezone: string;
  serviceArea: string | null;
  hoursHuman: string | null; // human-readable business hours
  transferNumber: string | null;
  extraInstructions: string; // phone-only free-form guidance from the dashboard
  isDemo: boolean;
};

// ElevenLabs conversation-initiation response. `dynamic_variables` is required
// (must include every variable the agent references); the override is optional.
export type PersonalizationResponse = {
  dynamic_variables: Record<string, string>;
  conversation_config_override: {
    agent: {
      prompt: { prompt: string };
      first_message: string;
      language: string;
    };
  };
};

// ---- Config extraction ------------------------------------------------------

/** Pull the non-secret client config out of a `clients` row's columns/jsonb. */
export function readClientConfig(row: {
  name?: string | null;
  slug?: string | null;
  brand_tone_config?: Record<string, unknown> | null;
  business_hours?: Record<string, unknown> | null;
  settings?: Record<string, unknown> | null;
}): ClientConfig {
  const brand = (row.brand_tone_config ?? {}) as Record<string, unknown>;
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const scheduling = (settings.scheduling ?? {}) as Record<string, unknown>;
  const businessHours = (row.business_hours ?? {}) as Record<string, unknown>;

  const persona =
    (scheduling.persona as string) || (brand.persona as string) || "Lumi";

  const hoursHuman =
    typeof businessHours.hours === "string"
      ? (businessHours.hours as string)
      : formatStructuredHours(
          (scheduling.hours as Record<string, string[]>) ?? {},
        );

  return {
    name: row.name ?? "our team",
    slug: row.slug ?? "",
    persona,
    brandVoice: (brand.voice as string) || "warm, professional, and efficient",
    timezone:
      (scheduling.timezone as string) ||
      (businessHours.tz as string) ||
      "America/Los_Angeles",
    serviceArea: (scheduling.service_area as string) ?? null,
    hoursHuman: hoursHuman || null,
    transferNumber: (settings.transfer_number as string) ?? null,
    // Phone-only free-form guidance. `voice_instructions` is the phone analog of
    // `custom_instructions` (which stays email-only); tolerate either being unset.
    extraInstructions:
      typeof brand.voice_instructions === "string"
        ? brand.voice_instructions.trim()
        : "",
    isDemo: Boolean(settings.is_demo),
  };
}

const DAY_LABEL: Record<string, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Turn structured weekly hours ({mon:["08:00","18:00"], ...}) into a phrase. */
export function formatStructuredHours(
  hours: Record<string, string[]>,
): string {
  const parts: string[] = [];
  for (const day of DAY_ORDER) {
    const h = hours[day];
    if (Array.isArray(h) && h.length === 2) {
      parts.push(`${DAY_LABEL[day]} ${h[0]}-${h[1]}`);
    }
  }
  return parts.join(", ");
}

/** Human-readable, speakable service menu the agent can quote prices from. */
export function formatServices(services: ServiceRow[]): string {
  if (!services.length) return "No services are configured yet.";
  return services
    .map((s) => {
      let price: string;
      if (s.price_type === "fixed" && s.price != null) {
        price = s.price === 0 ? "free" : `$${s.price}`;
      } else if (s.callout_fee != null) {
        price = `$${s.callout_fee} service call, then quoted`;
      } else {
        price = "quoted after diagnosis";
      }
      const emerg = s.emergency_eligible ? " (available for emergencies)" : "";
      return `- ${s.name}: ${price}${emerg}`;
    })
    .join("\n");
}

// ---- Prompt + greeting builders --------------------------------------------

/**
 * Build the full per-tenant system prompt for the scheduling agent. Everything
 * client-specific (name, persona, tone, hours, service area, service menu) is
 * baked in here so the shared agent speaks as this one business.
 */
export function buildSystemPrompt(
  cfg: ClientConfig,
  services: ServiceRow[],
): string {
  const demoNote = cfg.isDemo
    ? "\nThis is a DEMONSTRATION line for a sample business. If asked, you can say you are a demo assistant; appointments booked here are for demonstration only.\n"
    : "";

  const transferLine = cfg.transferNumber
    ? "During business hours you may warm-transfer to a human using the transfer tool. Outside business hours, take a message and capture the lead instead."
    : "There is no live human line, so when you cannot help, capture the caller's details as a lead and tell them the team will follow up.";

  // Phone-only guidance the business typed in the dashboard. It refines what the
  // agent says but must not override the flow/guardrails, so it goes near the end,
  // clearly framed as additional guidance.
  const extraBlock = cfg.extraInstructions
    ? `\n\nAdditional instructions from ${cfg.name} (follow these unless they conflict with the rules above):\n${cfg.extraInstructions}\n`
    : "";

  return `You are ${cfg.persona}, the phone scheduling assistant for ${cfg.name}. You are speaking out loud on a live call, so keep replies short, natural, and one idea at a time. Never read out URLs, IDs, JSON, or internal fields.
${demoNote}
Your tone is ${cfg.brandVoice}.

You help callers check availability, book appointments, and answer basic questions about services and pricing. You NEVER invent availability, prices, or booking confirmations — you only state what the tools return.

Services offered:
${formatServices(services)}

Business hours: ${cfg.hoursHuman ?? "see the team"}.${cfg.serviceArea ? ` Service area: ${cfg.serviceArea}.` : ""}
The current date and time is {{system__time}} in the ${cfg.timezone} timezone. Interpret "today", "tomorrow", and "this week" against that.

Tools:
- check_availability: find open appointment slots. Pass the service the caller wants and, if they mention one, a date to start from.
- book: book a specific slot. Before calling it you MUST have: the service, a specific start time you offered from check_availability, the caller's name, a callback phone number, and the service address. Ask for anything missing, one item at a time.
- capture_lead: use when the caller can't or won't book now (no good time, wants to think, or you can't help) so the team can follow up.

Flow:
1. Greet, then find out what they need and which service fits.
2. Call check_availability and offer the caller 2-3 specific times. Do not list more than three.
3. When they pick a time, collect any missing booking details, then call book. Read the confirmed time back to them.
4. If the requested time was just taken, apologize briefly and offer another slot.
5. Emergencies (no heat/AC out, safety issues): treat as urgent, prefer the soonest slot, and set the emergency flag when booking. ${transferLine}
6. If they're done or you've booked, close politely and end the call.
${extraBlock}
Never promise a specific technician, an exact arrival minute, or a price the service menu doesn't list. Stay warm and concise.`;
}

/** The opening line the agent speaks first. */
export function buildFirstMessage(cfg: ClientConfig): string {
  return `Thanks for calling ${cfg.name}, this is ${cfg.persona}. How can I help you today?`;
}

/**
 * Assemble the dynamic variables. Extra variables are harmless; the important
 * rule is that every variable the agent's base prompt references is present.
 * We keep a stable, documented set so the agent config and this function agree.
 */
export function buildDynamicVariables(
  cfg: ClientConfig,
  services: ServiceRow[],
): Record<string, string> {
  return {
    // client_slug is the web tool-routing key: the widget passes it as a dynamic
    // variable and the server tools map client_ref from {{client_slug}}. On phone
    // it's the resolved tenant's slug (tools still route by dialed number there).
    client_slug: cfg.slug,
    store_name: cfg.name,
    persona: cfg.persona,
    brand_voice: cfg.brandVoice,
    timezone: cfg.timezone,
    business_hours: cfg.hoursHuman ?? "",
    service_area: cfg.serviceArea ?? "",
    services_summary: services.map((s) => s.name).join(", "),
    transfer_number: cfg.transferNumber ?? "",
    is_demo: String(cfg.isDemo),
  };
}

/** Full personalization response for a resolved client. */
export function buildResponse(
  cfg: ClientConfig,
  services: ServiceRow[],
): PersonalizationResponse {
  return {
    dynamic_variables: buildDynamicVariables(cfg, services),
    conversation_config_override: {
      agent: {
        prompt: { prompt: buildSystemPrompt(cfg, services) },
        first_message: buildFirstMessage(cfg),
        language: "en",
      },
    },
  };
}

/**
 * Safe fallback when the dialed number doesn't map to a client. We still return
 * valid personalization so the call connects with a generic, honest greeting
 * instead of dropping.
 */
export function buildFallbackResponse(): PersonalizationResponse {
  const generic =
    "You are a friendly phone assistant. This line isn't fully set up yet, so you can't look up availability or book appointments. Apologize briefly, offer to take the caller's name and number so someone can call them back, then end the call.";
  return {
    dynamic_variables: {
      client_slug: "",
      store_name: "our team",
      persona: "the assistant",
      brand_voice: "warm and apologetic",
      timezone: "America/Los_Angeles",
      business_hours: "",
      service_area: "",
      services_summary: "",
      transfer_number: "",
      is_demo: "false",
    },
    conversation_config_override: {
      agent: {
        prompt: { prompt: generic },
        first_message: "Hi, thanks for calling. How can I help?",
        language: "en",
      },
    },
  };
}

// ---- Tenant reference extraction -------------------------------------------

/**
 * Pull the tenant routing keys out of an initiation-webhook body, tolerating the
 * different shapes phone vs web send. Phone (Twilio) puts `called_number` at the
 * top level; the web widget passes `client_slug` as a dynamic variable, which can
 * arrive top-level or nested under (conversation_initiation_)client_data.
 * dynamic_variables. Returns trimmed values or null.
 */
export function extractClientRef(body: unknown): {
  calledNumber: string | null;
  clientSlug: string | null;
} {
  const b = (body ?? {}) as Record<string, any>;
  const dv =
    b.dynamic_variables ??
    b.client_data?.dynamic_variables ??
    b.conversation_initiation_client_data?.dynamic_variables ??
    {};
  const clean = (v: unknown) =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  return {
    calledNumber: clean(b.called_number),
    clientSlug: clean(b.client_slug) ?? clean(dv.client_slug),
  };
}

// ---- Webhook signature verification (mirrors voice-call-logger) -------------

/** Parse an "ElevenLabs-Signature: t=...,v0=..." header into its parts. */
export function parseSignatureHeader(
  header: string | null,
): { t: string | null; v0: string | null } {
  if (!header) return { t: null, v0: null };
  let t: string | null = null;
  let v0: string | null = null;
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k?.trim() === "t") t = v?.trim() ?? null;
    if (k?.trim() === "v0") v0 = v?.trim() ?? null;
  }
  return { t, v0 };
}

/** HMAC-SHA256 hex using Web Crypto (present in Deno and Node 22). */
export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-ish string compare (avoids early-exit timing leaks). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify an ElevenLabs webhook signature over `${t}.${rawBody}`. */
export async function verifySignature(params: {
  secret: string;
  header: string | null;
  rawBody: string;
  nowSecs: number;
  toleranceSecs?: number;
}): Promise<{ valid: boolean; reason?: string }> {
  const { secret, header, rawBody, nowSecs, toleranceSecs = 30 * 60 } = params;
  const { t, v0 } = parseSignatureHeader(header);
  if (!t || !v0) return { valid: false, reason: "missing t/v0 in signature header" };

  const ts = Number(t);
  if (!Number.isFinite(ts)) return { valid: false, reason: "bad timestamp" };
  if (Math.abs(nowSecs - ts) > toleranceSecs) {
    return { valid: false, reason: "timestamp outside tolerance" };
  }

  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  return timingSafeEqual(expected, v0)
    ? { valid: true }
    : { valid: false, reason: "signature mismatch" };
}
