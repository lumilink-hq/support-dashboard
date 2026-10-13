// =============================================================================
// outbound-instantly/lib.ts — pure helpers for outbound-instantly: the lead
// payload Instantly receives, how many to push today, what an Instantly lead's
// state means for our funnel stage, and when a lead can leave Instantly.
// No network, no Deno APIs, so scripts/test-outbound-instantly.ts runs them
// under Node.
//
// Instantly API v2 (developer.instantly.ai, read 2026-10-13):
//   lead.status               1 active, 2 paused, 3 completed, -1 bounced,
//                             -2 unsubscribed, -3 skipped
//   lead.lt_interest_status   0 out of office, 1 interested, 2 meeting booked,
//                             3 meeting completed, 4 won, -1 not interested,
//                             -2 wrong person, -3 lost, -4 no show
// =============================================================================

export type Stage =
  | "queued" | "replied" | "positive" | "negative" | "called" | "booked"
  | "won" | "lost" | "finished" | "suppressed";

/** Progress order: a lead only ever moves to a later stage from Instantly's
 * data, so a person's own update (say, 'called') is never undone by a poll. */
const RANK: Record<string, number> = {
  queued: 0, finished: 0.5, replied: 1, negative: 2, positive: 2,
  called: 3, booked: 4, lost: 5, won: 5,
};
const TERMINAL = new Set(["won", "lost", "suppressed"]);

export type LeadForPush = {
  id: string;
  email: string;
  business_name: string;
  website_url: string | null;
  phone: string | null;
  city: string | null;
  region: string | null;
  category: string | null;
};

/** One item of POST /api/v2/leads/add. Unknown fields are rejected by
 * Instantly, so only documented ones are sent; the rest ride in
 * custom_variables for the campaign's copy ({{city}}, {{category}}). */
export function toInstantlyLead(lead: LeadForPush): Record<string, unknown> {
  const custom: Record<string, string> = { lumilink_lead_id: lead.id };
  if (lead.city) custom.city = lead.city;
  if (lead.region) custom.state = lead.region;
  if (lead.category) custom.category = lead.category;
  const out: Record<string, unknown> = {
    email: lead.email,
    company_name: lead.business_name,
    custom_variables: custom,
  };
  if (lead.website_url) out.website = lead.website_url;
  if (lead.phone) out.phone = lead.phone;
  return out;
}

/**
 * Leads to push for one profile now: what's left of today's target, and
 * never past the uploaded-contacts cap (less a safety margin, since other
 * profiles and manual imports share it).
 */
export function pushQuota(opts: {
  dailyTarget: number;
  pushedToday: number;
  inInstantly: number;
  contactCap: number;
  margin?: number;
}): number {
  const margin = opts.margin ?? 50;
  const today = Math.max(0, opts.dailyTarget - opts.pushedToday);
  const room = Math.max(0, opts.contactCap - margin - opts.inInstantly);
  return Math.min(today, room, 1000);
}

export type InstantlyLead = {
  id: string;
  email?: string;
  status?: number;
  email_reply_count?: number;
  lt_interest_status?: number | null;
  timestamp_last_reply?: string | null;
};

export type LeadUpdate = {
  /** New stage, when it moves forward. */
  stage?: Stage;
  /** Add to suppressions and mark the lead suppressed (outbound_suppress_lead). */
  suppress?: "unsubscribed" | "bounced";
  last_reply_at?: string;
  /** A first reply: fetch its text for the reply inbox. */
  fetchReply?: boolean;
};

function interestStage(v: number | null | undefined): Stage | null {
  switch (v) {
    case 1: return "positive";
    case -1: case -2: return "negative";
    case 2: case 3: return "booked";
    case 4: return "won";
    case -3: return "lost";
    default: return null; // 0 out of office, -4 no show, custom values: no change
  }
}

/** What Instantly's view of a lead means for ours. */
export function planUpdate(current: { stage: string; last_reply_at: string | null }, il: InstantlyLead): LeadUpdate {
  if (TERMINAL.has(current.stage)) return {};
  if (il.status === -2) return { suppress: "unsubscribed" };
  if (il.status === -1) return { suppress: "bounced" };

  const update: LeadUpdate = {};
  let target: Stage | null = null;
  const replied = (il.email_reply_count ?? 0) > 0;

  if (replied) {
    target = "replied";
    if (il.timestamp_last_reply && il.timestamp_last_reply !== current.last_reply_at) {
      update.last_reply_at = il.timestamp_last_reply;
      update.fetchReply = true;
    }
  } else if (il.status === 3) {
    target = "finished";
  }
  const interest = interestStage(il.lt_interest_status);
  if (interest && (target === null || RANK[interest] > RANK[target])) target = interest;

  if (target && (RANK[target] ?? -1) > (RANK[current.stage] ?? -1)) update.stage = target;
  return update;
}

const DONE = new Set(["finished", "suppressed", "negative", "lost", "won"]);
const CONVERSATION = new Set(["replied", "positive", "called", "booked"]);
export const KEEP_CONVERSATION_DAYS = 30;

/**
 * Can this lead leave Instantly? Finished, suppressed and closed-out leads
 * can; a live conversation stays until it's been quiet for 30 days, so the
 * thread is still in Instantly's inbox while it matters. A lead whose
 * sequence is still running (stage 'queued') always stays.
 */
export function shouldRemove(lead: { stage: string; last_reply_at: string | null; pushed_at: string | null }, now = Date.now()): boolean {
  if (DONE.has(lead.stage)) return true;
  if (CONVERSATION.has(lead.stage)) {
    const last = Date.parse(lead.last_reply_at ?? lead.pushed_at ?? "");
    return Number.isFinite(last) && now - last > KEEP_CONVERSATION_DAYS * 86_400_000;
  }
  return false;
}

/** The new part of a reply: quoted history and signatures trimmed, 500 chars max. */
export function replySnippet(text: string | null | undefined, html?: string | null): string | null {
  let t = text ?? "";
  if (!t.trim() && html) {
    t = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  const lines: string[] = [];
  for (const line of t.split(/\r?\n/)) {
    if (/^\s*>/.test(line)) break; // quoted history
    if (/^\s*On .{3,200}wrote:\s*$/i.test(line)) break; // "On Mon, ... wrote:"
    if (/^\s*-{2,}\s*Original Message/i.test(line)) break;
    if (/^\s*Sent from my /i.test(line)) break;
    lines.push(line);
  }
  const s = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!s) return null;
  return s.length > 500 ? `${s.slice(0, 497)}...` : s;
}
