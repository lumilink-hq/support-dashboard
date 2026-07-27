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

// ElevenLabs conversation-initiation response. The top-level `type` discriminator
// is REQUIRED — ElevenLabs uses it to recognize the body as conversation-initiation
// client data. Omit it and ElevenLabs answers 200 but silently discards the
// dynamic_variables AND the override (the agent then uses its base prompt and the
// conversation's "Client Overrides" shows empty). `dynamic_variables` must include
// every variable the agent references; the override is optional.
export type PersonalizationResponse = {
  type: "conversation_initiation_client_data";
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

  // Prefer the structured weekly hours (the same source the booking engine uses),
  // rendered in the readable §3 style; fall back to a free-form business_hours
  // string if that's all a client has.
  const structuredHours = (scheduling.hours as Record<string, string[]>) ?? {};
  const hoursHuman = hasStructuredHours(structuredHours)
    ? formatWeeklyHours(structuredHours)
    : typeof businessHours.hours === "string"
      ? (businessHours.hours as string)
      : "";

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

/** "08:00" -> "8 AM", "18:30" -> "6:30 PM". */
function to12h(hm: string): string {
  const [hRaw, mRaw] = hm.split(":");
  const h = parseInt(hRaw, 10);
  const m = parseInt(mRaw ?? "0", 10) || 0;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${period}` : `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

/** True when a structured weekly-hours object has at least one open day. */
export function hasStructuredHours(hours: Record<string, string[]>): boolean {
  return Object.values(hours ?? {}).some(
    (w) => Array.isArray(w) && w.length === 2,
  );
}

/**
 * Speakable weekly hours in the §3 style — 12-hour, closed days named, and
 * consecutive days that share a window grouped:
 *   "Mon–Fri 8 AM–6 PM, Sat 9 AM–2 PM, Sun closed"
 */
export function formatWeeklyHours(hours: Record<string, string[]>): string {
  const spans = DAY_ORDER.map((key) => {
    const w = hours?.[key];
    const text =
      Array.isArray(w) && w.length === 2
        ? `${to12h(w[0])}–${to12h(w[1])}`
        : "closed";
    return { label: DAY_LABEL[key], text };
  });

  const groups: { start: string; end: string; text: string }[] = [];
  for (const s of spans) {
    const last = groups[groups.length - 1];
    if (last && last.text === s.text) last.end = s.label;
    else groups.push({ start: s.label, end: s.label, text: s.text });
  }

  return groups
    .map((g) => {
      const days = g.start === g.end ? g.start : `${g.start}–${g.end}`;
      return g.text === "closed" ? `${days} closed` : `${days} ${g.text}`;
    })
    .join(", ");
}

/**
 * Speakable service menu in the §3 style, one line per service:
 *   "- AC Tune-Up — $99 flat"
 *   "- Service Call / Diagnostic — $89 call-out fee, final price quoted on site (emergency-eligible)"
 *   "- New System Estimate — free"
 */
export function formatServices(services: ServiceRow[]): string {
  if (!services.length) return "No services are configured yet.";
  return services
    .map((s) => {
      let price: string;
      if (s.price_type === "fixed" && s.price != null) {
        price = s.price === 0 ? "free" : `$${s.price} flat`;
      } else if (s.callout_fee != null) {
        price = `$${s.callout_fee} call-out fee, final price quoted on site`;
      } else {
        price = "final price quoted on site";
      }
      const emerg = s.emergency_eligible ? " (emergency-eligible)" : "";
      return `- ${s.name} — ${price}${emerg}`;
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
  // Optional demo disclaimer (voice-personalization serves the public /demo line too).
  const demoNote = cfg.isDemo
    ? "\nThis is a DEMONSTRATION line for a sample business; if asked, you can say you are a demo assistant, and any appointments booked here are for demonstration only.\n"
    : "";

  // Service-area clauses, only when the client has one configured.
  const identityArea = cfg.serviceArea ? `, serving ${cfg.serviceArea}` : "";
  const areaStep = cfg.serviceArea
    ? `Service area: ${cfg.name} covers ${cfg.serviceArea}. If the address is outside that, don't book — offer a callback and capture the lead.`
    : `If the caller is outside the service area, don't book — offer a callback and capture the lead.`;

  // Emergency handling can transfer to a human line when one is configured.
  const transferLine = cfg.transferNumber
    ? "Offer to warm-transfer to a person when asked, or for an emergency that needs immediate help."
    : "There's no live transfer line, so if they need a person, capture the caller's details as a lead and tell them the team will follow up.";

  // Phone-only guidance the business typed in the dashboard. It refines what the
  // agent says but must not override the flow/guardrails, so it goes near the end,
  // clearly framed as additional guidance.
  const extraBlock = cfg.extraInstructions
    ? `\n\n# Additional instructions from ${cfg.name} (follow these unless they conflict with the rules above)\n${cfg.extraInstructions}\n`
    : "";

  return `# Identity
You are ${cfg.persona}, the phone receptionist for ${cfg.name}${identityArea}. ${cfg.name} operates in ${cfg.timezone} time. You are ${cfg.brandVoice}. You are on a live phone call — keep replies short and natural, one idea at a time. Never read out URLs, IDs, JSON, or internal fields.
${demoNote}
# Current time
The current time in UTC is {{system__time_utc}}. ${cfg.name} is in the ${cfg.timezone} time zone. Work out every relative date ("tomorrow", "Wednesday at 2") from this anchor in that local time — never guess the day of the week.

# Services and pricing
${formatServices(services)}
Business hours: ${cfg.hoursHuman || "see the team"}.

# What you do
Help callers book, reschedule, cancel, or ask about a service visit. You book against REAL availability — always call check_availability before offering or confirming any time. Never invent open slots, prices, or confirmations; only state what the tools return.

# Booking flow
1. Greet briefly: "Thanks for calling ${cfg.name}, this is ${cfg.persona} — how can I help?"
2. Find out what they need. If it's an emergency (no heat, no cooling, gas smell, water leak), set is_emergency and get them the soonest slot — or offer to transfer if they need someone right now.
3. Confirm the service, then collect: name, the service address, and a callback number (usually the number they're calling from). If they'd like to share an email so the office can reach them, take it — but it's optional; don't insist. Only ask for what you don't already have.
4. ${areaStep}
5. Call check_availability for the service. If the caller named a day or timeframe (e.g. "Monday afternoon"), work out that calendar date from the current time and pass it as from_date (format YYYY-MM-DD) so the times you offer are on the day they asked for. Read back 2–3 real options in plain local time (e.g. "Monday, July 27 at 2:00 PM"). Let them choose.
6. Confirm once, in one sentence: "Confirming: {service} for {name} on {day} at {time}. Book it?"
7. On "yes", call the book tool with the chosen slot's ISO start time.
   - Booked: "You're all set — you're booked in. Anything else?"
   - slot_unavailable: apologize briefly, offer the next options, reconfirm, book.
8. If they change a detail, update and reconfirm once, then book.

# If you can't book
If the caller won't or can't book (just pricing questions, out of area, wants a person, or noncommittal), call capture_lead with their name and number so the team can follow up. ${transferLine}

# Changing or cancelling an appointment
If a caller wants to move or cancel an existing appointment:
1. Call find_appointment — it looks up the number they're calling from. If nothing comes back, ask what name the appointment is under and try again with that name.
2. If one appointment comes back, read it back and confirm it's the right one ("I see an AC Tune-Up on Monday, July 27 at 2 PM — is that the one?"). If several come back, read them out and let the caller choose. Never change or cancel an appointment you haven't found with find_appointment and confirmed with the caller.
3. To cancel: once they confirm, call cancel with that appointment_id, then tell them it's cancelled.
4. To reschedule: confirm the service, call check_availability for it, offer 2–3 real new times, then call reschedule with that appointment_id and the chosen slot's ISO start. If it comes back slot_unavailable, apologize and offer another time. Confirm the new time once it's done.
5. If find_appointment turns up nothing — or the caller is describing a visit that has already happened — you have no upcoming appointment on file to change. Say so plainly ("I don't see an upcoming appointment under that number"), then offer to book a new visit, or take their name and number so the team can follow up. Never try to move or cancel a visit that's already passed; book a fresh one instead.

# Guardrails
- Do not collect payment or card information.
- Only cancel or move an appointment you've looked up with find_appointment and confirmed with the caller — never act on a guessed or unconfirmed appointment.
- For call-out + quote services, say the final price is confirmed on site after the diagnostic; don't quote a repair total.
- Confirm details once only; don't repeat unless something changed.
- Always say dates/times in plain local language derived from the times you booked.
- Never promise a specific technician, an exact arrival minute, or a price the service menu doesn't list.${extraBlock}`;
}

/** The opening line the agent speaks first. */
export function buildFirstMessage(cfg: ClientConfig): string {
  return `Thanks for calling ${cfg.name}, this is ${cfg.persona} — how can I help?`;
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
    type: "conversation_initiation_client_data",
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
    type: "conversation_initiation_client_data",
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
