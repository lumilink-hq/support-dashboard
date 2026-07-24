// =============================================================================
// lib.ts — pure, side-effect-free helpers for the voice-call-logger function.
// Kept separate from index.ts (the Deno/Supabase wiring) so they can be unit
// tested in plain Node/tsx without a running Supabase or Deno. No imports.
// =============================================================================

export type ElevenTurn = {
  role?: string; // "user" | "agent"
  message?: string | null;
  tool_calls?: unknown;
  time_in_call_secs?: number;
};

export type PostCallPayload = {
  type?: string;
  event_timestamp?: number;
  data?: {
    conversation_id?: string;
    status?: string;
    transcript?: ElevenTurn[];
    // Phone-call metadata for Twilio/SIP calls lives here in the post-call
    // payload (call_sid + numbers), separate from the live-call dynamic vars.
    metadata?: Record<string, any>;
    conversation_initiation_client_data?: {
      dynamic_variables?: Record<string, unknown>;
    };
  };
};

export type CallFields = {
  callSid: string | null;
  calledNumber: string | null;
  callerId: string | null;
  elevenConversationId: string | null;
  status: string | null;
};

export type PreparedTurn = {
  role: "customer" | "agent";
  body: string;
  turnRef: string;
};

// Map ElevenLabs transcript roles onto our message_role_t. ElevenLabs emits
// "user" (the caller) and "agent" (the AI). Anything unexpected is treated as
// an agent turn to avoid mislabeling a caller.
export function mapRole(role: string | undefined): "customer" | "agent" {
  return role === "user" ? "customer" : "agent";
}

// Pull the phone identifiers out of the post-call payload. Different ElevenLabs
// payload shapes carry these in different places, so we check the call's system
// dynamic variables AND the metadata.phone_call block (where Twilio/SIP call
// info actually lands post-call), trying several known key spellings.
export function extractCallFields(payload: PostCallPayload): CallFields {
  const data = payload?.data ?? {};
  const dv =
    (data.conversation_initiation_client_data?.dynamic_variables ?? {}) as Record<
      string,
      unknown
    >;
  const meta = (data.metadata ?? {}) as Record<string, any>;
  const phone = (meta.phone_call ?? {}) as Record<string, any>;
  const str = (v: unknown) =>
    typeof v === "string" && v.length > 0 ? v : null;

  const first = (...vals: unknown[]) => {
    for (const v of vals) {
      const s = str(v);
      if (s) return s;
    }
    return null;
  };

  return {
    callSid: first(
      dv["system__call_sid"],
      phone.call_sid,
      phone.callSid,
      meta.call_sid,
    ),
    calledNumber: first(
      dv["system__called_number"],
      phone.agent_number,
      phone.called_number,
      phone.to_number,
      phone.to,
      meta.called_number,
    ),
    callerId: first(
      dv["system__caller_id"],
      phone.external_number,
      phone.caller_number,
      phone.from_number,
      phone.from,
    ),
    elevenConversationId: first(
      dv["system__conversation_id"],
      data.conversation_id,
    ),
    status: str(data.status),
  };
}

// Turn the transcript into idempotent, insertable turns. Empty/blank messages
// are dropped, but the ORIGINAL index is used for turn_ref so the ref is stable
// across webhook retries even after filtering.
export function buildTurns(
  transcript: ElevenTurn[] | undefined,
  callSid: string,
): PreparedTurn[] {
  return (transcript ?? [])
    .map((t, i) => ({ t, i }))
    .filter(
      ({ t }) => typeof t?.message === "string" && t.message.trim().length > 0,
    )
    .map(({ t, i }) => ({
      role: mapRole(t.role),
      body: t.message as string,
      turnRef: `${callSid}:${i}`,
    }));
}

// Did the agent transfer / try to hand off to a human? Detected from tool-call
// data anywhere in the transcript. Deliberately loose (stringify + substring)
// so it survives minor payload-shape changes in how tool calls are represented.
export function detectHumanHandoff(transcript: ElevenTurn[] | undefined): boolean {
  const blob = JSON.stringify(transcript ?? []).toLowerCase();
  return blob.includes("transfer_to_number") || blob.includes("transfer_to_agent");
}

// Parse an "ElevenLabs-Signature: t=...,v0=..." header into its parts.
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

// HMAC-SHA256 hex of a message with a secret, using Web Crypto (present in both
// Deno and Node 22's global `crypto`).
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

// Constant-time-ish string compare (avoids early-exit timing leaks).
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Verify an ElevenLabs post-call webhook signature over `${t}.${rawBody}`.
// toleranceSecs guards against replay; pass nowSecs for deterministic tests.
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
