// =============================================================================
// lib.ts — pure helpers for the voice-ticket function. No imports, so they can
// be unit tested in plain Node/tsx without Deno or Supabase.
// =============================================================================

export type ClientRef = {
  calledNumber: string | null;
  clientSlug: string | null;
  conversationRef: string | null;
};

/**
 * ElevenLabs sends EVERY configured tool parameter on EVERY call, filling the
 * inapplicable ones with EMPTY STRINGS rather than omitting them. Phone arrives
 * as {called_number: "+1…", client_ref: ""}, web as {called_number: "",
 * client_ref: "slug"}. Treating "" as present routes a web call down the phone
 * path. Same normalization as voice-order-lookup.
 */
export function extractClientRef(body: unknown): ClientRef {
  const b = (body ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = b[k];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
      if (typeof v === "number") return String(v);
    }
    return null;
  };
  return {
    calledNumber: pick("called_number", "system__called_number"),
    clientSlug: pick("client_ref", "client_slug"),
    // A browser session has no Twilio SID — fall back to the conversation id.
    conversationRef: pick("call_sid", "conversation_id", "system__conversation_id"),
  };
}

/**
 * Normalize a spoken phone number to E.164-ish.
 *
 * The caller reads digits aloud and the model transcribes them with spaces,
 * dashes, or "plus one". We keep a leading + when present, strip everything
 * else, and assume US (+1) for a bare 10-digit number — every number in this
 * product is US today, and a callback that dials nowhere is worse than one
 * that assumes the obvious country code.
 */
export function normalizePhone(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const hadPlus = s.trimStart().startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7) return null; // too short to be a real number
  if (hadPlus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

/**
 * The idempotency key for this ticket. A retried tool call MUST produce the
 * same key so create_ticket hands back the same ticket number — the agent has
 * already said that number out loud.
 */
export function buildExternalRef(conversationRef: string | null): string | null {
  const ref = (conversationRef ?? "").trim();
  return ref ? `${ref}:callback` : null;
}

/** Keep the spoken reason short enough to scan in a queue. */
export function buildDetails(params: {
  reason?: string | null;
  orderNumber?: string | null;
}): string {
  const reason = (params.reason ?? "").trim();
  const order = (params.orderNumber ?? "").trim();
  const base = reason || "Caller requested a callback.";
  const trimmed = base.length > 500 ? `${base.slice(0, 497)}...` : base;
  return order ? `Order #${order}. ${trimmed}` : trimmed;
}

/**
 * Read a ticket number back the way a person says it: 1042 -> "ten forty-two".
 * The agent speaks this, and TTS reads a bare integer as "one thousand and
 * forty-two", which callers mishear and can't repeat back.
 */
export function spokenTicketNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  const num = Math.trunc(Math.abs(n));
  if (num < 100) return String(num);
  if (num < 10000) {
    const hi = Math.floor(num / 100);
    const lo = num % 100;
    if (lo === 0) return `${hi} hundred`;
    return lo < 10 ? `${hi} oh ${lo}` : `${hi} ${lo}`;
  }
  return String(num);
}

export const ALLOWED_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

export function normalizePriority(raw: unknown): string {
  // The LLM fills this field, so tolerate "Urgent!" / " HIGH " and fall back to
  // 'normal' for anything unrecognized rather than failing the CHECK constraint.
  const p = String(raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return ALLOWED_PRIORITIES.has(p) ? p : "normal";
}
