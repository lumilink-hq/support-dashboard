// =============================================================================
// outbound-instantly — outbound engine Phase 2 (docs/OUTBOUND-PLAN.md): the
// link between our leads and Instantly, which does the sending.
//
//   POST /outbound-instantly
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   {}                          sync, then cleanup, then push
//           { "action": "sync" }        poll Instantly for replies, interest,
//                                       unsubscribes, bounces, finished sequences
//           { "action": "cleanup" }     delete finished leads from Instantly
//           { "action": "push" }        add verified leads to their profile's campaign
//
// MUST be deployed with --no-verify-jwt (shared-secret auth).
//
// PUSH. Per active profile with an instantly_campaign_id: up to what's left
// of daily_lead_target today, and never past Instantly's uploaded-contacts
// cap (INSTANTLY_CONTACT_CAP, default 1,000 = Growth) less a margin. Valid
// addresses go before catch-all/unknown ones. Suppression is checked again
// at claim time. Leads Instantly doesn't create (blocklisted, already in the
// workspace) are looked up by email: one already in this campaign is
// recorded as queued (e.g. a run that died after Instantly accepted it);
// anything else is suppressed with a note, never retried.
//
// SYNC. Instantly Growth has no webhooks, so replies are polled. Every lead
// still held in Instantly is read in pages of 100 (POST /leads/list by id).
// lib.ts planUpdate decides: unsubscribed/bounced -> suppressed for good;
// a reply -> 'replied' (and its text fetched, at most 10 per run because
// /emails allows 20 requests a minute); Instantly's interest status ->
// positive / negative / booked / won / lost; sequence done with no reply ->
// 'finished'. Stages only move forward, so a person's update is never undone.
//
// CLEANUP. Instantly's uploaded-contacts limit is a running total that only
// deleting frees (help.instantly.ai "Uploaded Contacts Limits"). Finished,
// suppressed and closed-out leads are deleted there (at most 50 a run); a
// live conversation stays until it's been quiet for 30 days. Our row keeps
// the history.
//
// ERRORS. 401/402 from Instantly (bad key, no paid plan) stop the run;
// claimed leads are released. 429 stops the current step.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, INSTANTLY_API_KEY, INSTANTLY_CONTACT_CAP (optional,
//      default 1000), INSTANTLY_API_BASE (optional, tests).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  type InstantlyLead,
  type LeadForPush,
  planUpdate,
  pushQuota,
  replySnippet,
  shouldRemove,
  toInstantlyLead,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const INSTANTLY_API_KEY = Deno.env.get("INSTANTLY_API_KEY");
const INSTANTLY_API_BASE = Deno.env.get("INSTANTLY_API_BASE") ?? "https://api.instantly.ai";
const CONTACT_CAP = Number(Deno.env.get("INSTANTLY_CONTACT_CAP") ?? 1000);

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const PAGE = 100;
const MAX_REPLY_FETCHES = 10;
const MAX_DELETES = 50;
const CAP_WARNING_SHARE = 0.8;
const REQUEST_TIMEOUT_MS = 30_000;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class InstantlyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
  /** Bad key or no paid plan: nothing else will work this run. */
  get fatal() {
    return this.status === 401 || this.status === 402;
  }
}

async function instantly(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(new URL(path, INSTANTLY_API_BASE), {
      method,
      headers: {
        Authorization: `Bearer ${INSTANTLY_API_KEY}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const message = payload?.message ?? payload?.error ?? `HTTP ${res.status}`;
      throw new InstantlyError(`instantly ${method} ${path}: ${message}`, res.status);
    }
    return payload;
  } catch (e) {
    if (e instanceof InstantlyError) throw e;
    if (e instanceof Error && e.name === "AbortError") throw new InstantlyError(`instantly ${method} ${path}: timeout`, 0);
    throw new InstantlyError(`instantly ${method} ${path}: ${e instanceof Error ? e.message : e}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data as T;
}

async function event(lead: { id: string; profile_id: string }, type: string, detail: Record<string, unknown>) {
  const { error } = await supabase.from("outbound_events").insert({ lead_id: lead.id, profile_id: lead.profile_id, type, detail });
  if (error) console.error(`outbound-instantly ${lead.id}: event ${type} failed: ${error.message}`);
}

// -----------------------------------------------------------------------------
// Push
// -----------------------------------------------------------------------------

type Profile = { id: string; name: string; daily_lead_target: number; instantly_campaign_id: string };
type PushLead = LeadForPush & { profile_id: string };

async function pushProfile(p: Profile): Promise<Record<string, unknown>> {
  const [pushedToday, inInstantly] = await Promise.all([
    rpc<number>("outbound_pushed_today", { p_profile_id: p.id }),
    rpc<number>("outbound_in_instantly", {}),
  ]);
  const quota = pushQuota({ dailyTarget: p.daily_lead_target, pushedToday, inInstantly, contactCap: CONTACT_CAP });
  const base = { profile_id: p.id, profile: p.name, pushed_today: pushedToday, in_instantly: inInstantly };
  if (quota === 0) {
    return { ...base, outcome: inInstantly >= CONTACT_CAP - 50 ? "contact_cap" : "daily_target_met" };
  }

  const leads = await rpc<PushLead[]>("outbound_claim_pushable", { p_profile_id: p.id, p_limit: quota, p_lease_seconds: 300 });
  if (leads.length === 0) return { ...base, outcome: "nothing_verified" };

  let res: any;
  try {
    res = await instantly("POST", "/api/v2/leads/add", {
      campaign_id: p.instantly_campaign_id,
      leads: leads.map(toInstantlyLead),
      skip_if_in_workspace: true,
    });
  } catch (e) {
    await supabase.from("outbound_leads").update({ claimed_until: null }).in("id", leads.map((l) => l.id));
    throw e;
  }

  const now = new Date().toISOString();
  const created = new Map<number, string>();
  for (const c of (res?.created_leads ?? []) as { index?: number; id?: string }[]) {
    if (typeof c.index === "number" && typeof c.id === "string") created.set(c.index, c.id);
  }

  let queued = 0;
  const notCreated: PushLead[] = [];
  for (let i = 0; i < leads.length; i++) {
    const instantlyId = created.get(i);
    if (!instantlyId) {
      notCreated.push(leads[i]);
      continue;
    }
    const { error } = await supabase
      .from("outbound_leads")
      .update({ instantly_lead_id: instantlyId, pushed_at: now, stage: "queued", claimed_until: null })
      .eq("id", leads[i].id)
      .eq("stage", "verified");
    if (error) console.error(`outbound-instantly push ${leads[i].id}: save failed: ${error.message}`);
    else queued++;
  }

  // Not created: find out whether it's already in this campaign (a run that
  // died after Instantly accepted it) before treating it as blocked.
  let recovered = 0;
  let skipped = 0;
  if (notCreated.length > 0) {
    const found = await instantly("POST", "/api/v2/leads/list", {
      campaign: p.instantly_campaign_id,
      contacts: notCreated.map((l) => l.email),
      limit: PAGE,
    }).catch(() => ({ items: [] }));
    const byEmail = new Map<string, string>();
    for (const it of (found?.items ?? []) as { id: string; email?: string }[]) {
      if (it.email) byEmail.set(it.email.toLowerCase(), it.id);
    }
    for (const lead of notCreated) {
      const id = byEmail.get(lead.email.toLowerCase());
      if (id) {
        await supabase
          .from("outbound_leads")
          .update({ instantly_lead_id: id, pushed_at: now, stage: "queued", claimed_until: null })
          .eq("id", lead.id);
        recovered++;
      } else {
        await rpc("outbound_suppress_lead", {
          p_lead_id: lead.id,
          p_reason: "manual",
          p_source: "instantly",
          p_note: "not added by Instantly: blocklisted or already in the workspace",
        });
        skipped++;
      }
    }
  }

  return {
    ...base,
    outcome: "pushed",
    claimed: leads.length,
    queued,
    recovered,
    skipped,
    instantly: {
      leads_uploaded: res?.leads_uploaded,
      in_blocklist: res?.in_blocklist,
      skipped_count: res?.skipped_count,
      duplicated_leads: res?.duplicated_leads,
      invalid_email_count: res?.invalid_email_count,
      remaining_in_plan: res?.remaining_in_plan,
    },
  };
}

// -----------------------------------------------------------------------------
// Sync and cleanup
// -----------------------------------------------------------------------------

type HeldLead = {
  id: string;
  profile_id: string;
  email: string;
  stage: string;
  instantly_lead_id: string;
  last_reply_at: string | null;
  pushed_at: string | null;
};

async function heldLeads(): Promise<HeldLead[]> {
  const out: HeldLead[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("outbound_leads")
      .select("id, profile_id, email, stage, instantly_lead_id, last_reply_at, pushed_at")
      .not("instantly_lead_id", "is", null)
      .is("removed_from_instantly_at", null)
      .order("pushed_at")
      .range(from, from + 999);
    if (error) throw new Error(`held leads lookup failed: ${error.message}`);
    out.push(...((data ?? []) as HeldLead[]));
    if (!data || data.length < 1000) return out;
  }
}

async function sync(): Promise<Record<string, unknown>> {
  const held = await heldLeads();
  const tally: Record<string, number> = {};
  const bump = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);
  let replyFetches = 0;

  for (let i = 0; i < held.length; i += PAGE) {
    const page = held.slice(i, i + PAGE);
    const res = await instantly("POST", "/api/v2/leads/list", { ids: page.map((l) => l.instantly_lead_id), limit: PAGE });
    const byId = new Map<string, InstantlyLead>();
    for (const it of (res?.items ?? []) as InstantlyLead[]) byId.set(it.id, it);

    for (const lead of page) {
      const il = byId.get(lead.instantly_lead_id);
      if (!il) {
        // Deleted in Instantly by hand: it's no longer held there.
        await supabase.from("outbound_leads").update({ removed_from_instantly_at: new Date().toISOString() }).eq("id", lead.id);
        await event(lead, "missing_in_instantly", { instantly_lead_id: lead.instantly_lead_id });
        bump("missing");
        continue;
      }
      const plan = planUpdate(lead, il);
      if (plan.suppress) {
        await rpc("outbound_suppress_lead", { p_lead_id: lead.id, p_reason: plan.suppress, p_source: "instantly", p_note: null });
        bump(plan.suppress);
        continue;
      }
      const patch: Record<string, unknown> = {};
      if (plan.stage) patch.stage = plan.stage;
      if (plan.last_reply_at) patch.last_reply_at = plan.last_reply_at;
      if (Object.keys(patch).length === 0) {
        bump("unchanged");
        continue;
      }
      const { error } = await supabase.from("outbound_leads").update(patch).eq("id", lead.id);
      if (error) {
        console.error(`outbound-instantly sync ${lead.id}: ${error.message}`);
        bump("error");
        continue;
      }
      bump(plan.stage ?? "reply_updated");

      if (plan.fetchReply && replyFetches < MAX_REPLY_FETCHES) {
        replyFetches++;
        try {
          const q = new URLSearchParams({ lead: lead.email, email_type: "received", limit: "1", sort_order: "desc" });
          const emails = await instantly("GET", `/api/v2/emails?${q}`);
          const e = emails?.items?.[0];
          if (e) {
            const snippet = replySnippet(e.body?.text, e.body?.html) ?? e.content_preview ?? null;
            await supabase.from("outbound_leads").update({ reply_snippet: snippet }).eq("id", lead.id);
            await event(lead, "reply", {
              instantly_email_id: e.id,
              subject: e.subject ?? null,
              snippet,
              is_auto_reply: e.is_auto_reply === 1,
              received_at: e.timestamp_email ?? e.timestamp_created ?? null,
            });
          }
        } catch (err) {
          if (err instanceof InstantlyError && (err.fatal || err.status === 429)) throw err;
          console.error(`outbound-instantly reply fetch ${lead.id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }
  return { held: held.length, ...tally, reply_texts_fetched: replyFetches };
}

async function cleanup(): Promise<Record<string, unknown>> {
  const held = await heldLeads();
  const due = held.filter((l) => shouldRemove(l)).slice(0, MAX_DELETES);
  let removed = 0;
  for (const lead of due) {
    try {
      await instantly("DELETE", `/api/v2/leads/${encodeURIComponent(lead.instantly_lead_id)}`);
    } catch (e) {
      if (!(e instanceof InstantlyError && e.status === 404)) throw e; // already gone is fine
    }
    await supabase.from("outbound_leads").update({ removed_from_instantly_at: new Date().toISOString() }).eq("id", lead.id);
    await event(lead, "removed_from_instantly", { stage: lead.stage });
    removed++;
  }
  return { held: held.length, removed, still_due: Math.max(0, held.filter((l) => shouldRemove(l)).length - removed) };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!VOICE_TOOL_SECRET) {
    console.error("VOICE_TOOL_SECRET unset — refusing to run");
    return json({ error: "Server not configured" }, 500);
  }
  if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!INSTANTLY_API_KEY) {
    console.error("INSTANTLY_API_KEY unset — refusing to run");
    return json({ error: "Server not configured" }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) ?? {};
  } catch {
    body = {};
  }
  const action = typeof body.action === "string" ? body.action : "all";
  if (!["all", "sync", "cleanup", "push"].includes(action)) return json({ error: `unknown action '${action}'` }, 400);

  const out: Record<string, unknown> = { action };
  let stopped: string | null = null;
  const run = async (name: string, fn: () => Promise<unknown>) => {
    if (stopped) return;
    try {
      out[name] = await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`outbound-instantly ${name}: ${message}`);
      out[name] = { error: message };
      if (e instanceof InstantlyError && e.fatal) stopped = message;
    }
  };

  if (action === "all" || action === "sync") await run("sync", sync);
  if (action === "all" || action === "cleanup") await run("cleanup", cleanup);
  if (action === "all" || action === "push") {
    await run("push", async () => {
      const { data: profiles, error } = await supabase
        .from("outbound_profiles")
        .select("id, name, daily_lead_target, instantly_campaign_id")
        .eq("status", "active")
        .not("instantly_campaign_id", "is", null);
      if (error) throw new Error(`profile lookup failed: ${error.message}`);
      const results = [];
      for (const p of (profiles ?? []) as Profile[]) {
        try {
          results.push(await pushProfile(p));
        } catch (e) {
          if (e instanceof InstantlyError && e.fatal) throw e;
          results.push({ profile_id: p.id, profile: p.name, outcome: "error", error: e instanceof Error ? e.message : String(e) });
        }
      }
      return results;
    });
  }

  const inInstantly = await rpc<number>("outbound_in_instantly", {}).catch(() => null);
  if (inInstantly !== null && inInstantly >= CONTACT_CAP * CAP_WARNING_SHARE) {
    console.warn(`outbound-instantly: ${inInstantly} of ${CONTACT_CAP} uploaded contacts in use`);
  }
  return json({ ...out, stopped, in_instantly: inInstantly, contact_cap: CONTACT_CAP });
});
