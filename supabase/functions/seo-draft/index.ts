// =============================================================================
// seo-draft — module 8 (plan.md): turn a location's open on-page findings into
// drafts waiting in the approval queue (seo_actions, status pending_approval).
//
//   POST /seo-draft
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "location_id": "<uuid>" }
//
// Admin endpoint, same posture as seo-crawl: the shared secret is the whole
// gate, dispatched by request_seo_draft (0054) via pg_cron -> pg_net.
//
// RULE 1: this only ever writes a DRAFT. Nothing here touches a live site; a
// person approves in the dashboard, and module 5's adapter publishes.
// RULE 3: previous_value is stored on every draft, plus an idempotency key.
// RULE 5: see lib.ts. The system prompt is a fixed constant.
// RULE 6: the Anthropic SDK retries 408/409/429/5xx with exponential backoff
// (maxRetries below), and every call first reserves against vendor_budgets.
//
// COST BOUND. At most MAX_DRAFTS_PER_RUN model calls per location per run, and
// a location only runs when it has an open draftable finding with no live
// draft, so a clean or fully drafted site costs nothing. A draft the validator
// rejects leaves its finding open, so it is retried on the next daily run; that
// is at most MAX_DRAFTS_PER_RUN wasted calls a day per location.
//
// FINDING LIFECYCLE. A finding that gets a draft is marked 'actioned'.
// seo-crawl deletes only OPEN findings, so the finding (and the action's link to
// it) survives the next crawl; when the crawl re-detects an unfixed issue it
// inserts a fresh open finding, and 0054's uq_seo_actions_live plus the
// seo_draft_targets view keep that from becoming a second draft.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, ANTHROPIC_API_KEY, SEO_DRAFT_MODEL (optional).
// The LocalBusiness schema draft needs no model, so it works without the key.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import Anthropic from "npm:@anthropic-ai/sdk@0.127.0";
import {
  buildDiff,
  buildLocalBusinessSchema,
  buildUserPayload,
  DRAFTABLE,
  idempotencyKey,
  orderFindings,
  planDraft,
  siteTarget,
  SYSTEM_PROMPT,
  validateDraft,
  type FindingRow,
  type LocationFacts,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

// Sonnet-class for drafts, per plan.md module 8.
const MODEL = Deno.env.get("SEO_DRAFT_MODEL") ?? "claude-sonnet-5";
const MAX_DRAFTS_PER_RUN = 10;
const BUDGET_RETRY_MS = 2_000;
const BUDGET_MAX_TRIES = 30; // ~60s, one full vendor_budgets window
const BASE_INTERVAL_MINUTES = 24 * 60;
const MAX_BACKOFF_MINUTES = 24 * 60;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: 4 }) : null;

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reserveBudget(): Promise<void> {
  for (let i = 0; i < BUDGET_MAX_TRIES; i++) {
    const { data: allowed, error } = await supabase.rpc("check_and_reserve_vendor_budget", { p_vendor: "anthropic" });
    if (error) throw new Error(`vendor budget check failed: ${error.message}`);
    if (allowed) return;
    await sleep(BUDGET_RETRY_MS);
  }
  throw new Error("anthropic vendor budget stayed exhausted");
}

async function callModel(userPayload: string): Promise<string> {
  await reserveBudget();
  const res = await anthropic!.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: userPayload }],
  });
  if (res.stop_reason === "refusal") throw new Error("model refused");
  if (res.stop_reason === "max_tokens") throw new Error("model output was cut off");
  const block = res.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : "";
}

type Outcome = { drafted: number; skipped: number; failed: number };

async function draftLocation(loc: LocationFacts & { id: string; client_id: string }): Promise<Outcome> {
  const out: Outcome = { drafted: 0, skipped: 0, failed: 0 };

  const { data: findings, error: fErr } = await supabase
    .from("seo_findings")
    .select("id, finding_type, severity, target_url, details, detected_at")
    .eq("location_id", loc.id)
    .eq("module", "crawl")
    .eq("status", "open")
    .in("finding_type", Object.keys(DRAFTABLE));
  if (fErr) throw new Error(`loading findings failed: ${fErr.message}`);

  // Same windows seo_draft_targets uses (0055): a live or in-flight draft, a
  // rejection in the last 30 days, or a publish in the last 14 days all mean
  // "don't draft this again".
  const { data: existing, error: aErr } = await supabase
    .from("seo_actions")
    .select("target_url, finding_type, status, updated_at")
    .eq("location_id", loc.id)
    .in("status", ["draft", "pending_approval", "approved", "publishing", "manual_required", "published", "rejected"]);
  if (aErr) throw new Error(`loading actions failed: ${aErr.message}`);
  const DAY = 24 * 60 * 60 * 1000;
  const covered = new Set(
    (existing ?? [])
      .filter((a) => {
        const age = Date.now() - new Date(a.updated_at).getTime();
        if (a.status === "rejected") return age < 30 * DAY;
        if (a.status === "published") return age < 14 * DAY;
        return true;
      })
      .map((a) => `${a.target_url ?? ""}|${a.finding_type}`),
  );

  const todo = orderFindings((findings ?? []) as FindingRow[]).filter(
    (f) => !covered.has(`${f.target_url ?? ""}|${f.finding_type}`),
  );

  // ---- LocalBusiness schema: one site-wide draft, no model ------------------
  const schemaFindings = todo.filter((f) => f.finding_type === "missing_local_business_schema");
  if (schemaFindings.length > 0) {
    const schema = buildLocalBusinessSchema(loc);
    const target = siteTarget(loc.website_url);
    const siteWide = `${target ?? ""}|missing_local_business_schema`;
    if (!schema || !target) {
      out.skipped += schemaFindings.length;
    } else if (covered.has(siteWide)) {
      // A site-wide schema draft is already live (or was just rejected); the
      // per-page findings are duplicates of it. Closing them out keeps the
      // location from staying a drafting target with nothing left to do.
      out.skipped += schemaFindings.length;
      await markActioned(schemaFindings.map((f) => f.id));
    } else {
      const after = JSON.stringify(schema, null, 2);
      const ok = await insertAction(loc, schemaFindings[0], {
        field: "local_business_schema",
        previous: null,
        after,
        targetUrl: target,
        draftedBy: "deterministic",
      });
      if (ok) {
        out.drafted++;
        await markActioned(schemaFindings.map((f) => f.id));
      } else {
        out.failed++;
      }
    }
  }

  // ---- Model-drafted copy ---------------------------------------------------
  const copyFindings = todo.filter((f) => f.finding_type !== "missing_local_business_schema").slice(0, MAX_DRAFTS_PER_RUN);
  if (copyFindings.length > 0 && !anthropic) {
    // Not a per-finding failure: nothing was attempted. The caller settles this
    // as a failed job so it backs off instead of retrying hourly.
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  for (const finding of copyFindings) {
    const plan = planDraft(finding);
    if (!plan || plan.field === "local_business_schema") continue;

    let text: string;
    try {
      text = await callModel(buildUserPayload(plan.field, loc, plan.previous, finding.target_url));
    } catch (e) {
      console.error(`seo-draft ${loc.id} finding ${finding.id}: model call failed: ${e instanceof Error ? e.message : e}`);
      out.failed++;
      continue;
    }

    const verdict = validateDraft(plan.field, text, plan.previous);
    if (!verdict.ok) {
      console.log(`seo-draft ${loc.id} finding ${finding.id}: draft rejected by validator: ${verdict.reason}`);
      out.skipped++;
      continue;
    }

    const ok = await insertAction(loc, finding, {
      field: plan.field,
      previous: plan.previous,
      after: verdict.text,
      targetUrl: finding.target_url,
      draftedBy: MODEL,
    });
    if (ok) {
      out.drafted++;
      await markActioned([finding.id]);
    } else {
      out.failed++;
    }
  }

  return out;
}

async function insertAction(
  loc: { id: string; client_id: string },
  finding: FindingRow,
  d: { field: string; previous: string | null; after: string; targetUrl: string | null; draftedBy: string },
): Promise<boolean> {
  const { error } = await supabase.from("seo_actions").insert({
    client_id: loc.client_id,
    location_id: loc.id,
    finding_id: finding.id,
    action_type: "onpage_fix",
    target_field: d.field,
    finding_type: finding.finding_type,
    target_url: d.targetUrl,
    previous_value: { value: d.previous },
    proposed_value: { value: d.after },
    diff: buildDiff(d.field as never, d.previous, d.after),
    status: "pending_approval",
    idempotency_key: idempotencyKey(finding.id),
    drafted_by: d.draftedBy,
  });
  if (!error) return true;
  // 23505: a live draft for this page and field already exists (lost a race
  // with another run). That is the guard doing its job, not a failure.
  if (error.code === "23505") return true;
  console.error(`seo-draft ${loc.id} finding ${finding.id}: insert failed: ${error.message}`);
  return false;
}

async function markActioned(findingIds: string[]): Promise<void> {
  const { error } = await supabase.from("seo_findings").update({ status: "actioned" }).in("id", findingIds);
  if (error) console.error(`seo-draft: marking findings actioned failed: ${error.message}`);
}

async function settle(loc: { id: string; client_id: string }, success: boolean, error: string | null) {
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: loc.client_id,
    p_job_type: "seo_draft",
    p_success: success,
    p_error: error,
    p_base_interval_minutes: BASE_INTERVAL_MINUTES,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: loc.id,
  });
  if (jobError) console.error(`seo-draft ${loc.id}: complete_job_attempt failed: ${jobError.message}`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!VOICE_TOOL_SECRET) {
    console.error("VOICE_TOOL_SECRET unset — refusing to run");
    return json({ error: "Server not configured" }, 500);
  }
  if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const locationId = String(body.location_id ?? "").trim();
  if (!locationId) return json({ error: "location_id is required" }, 400);

  const { data: loc, error } = await supabase
    .from("seo_locations")
    .select("id, client_id, name, address_line1, city, region, postal_code, country_code, phone_number, website_url, primary_category")
    .eq("id", locationId)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!loc) return json({ error: "location not found" }, 404);

  try {
    const outcome = await draftLocation(loc);
    // A model or insert failure backs the job off; a validator rejection does
    // not (the model answered, the answer just wasn't usable).
    const failed = outcome.failed > 0;
    await settle(loc, !failed, failed ? `${outcome.failed} draft(s) failed` : null);
    console.log(`seo-draft ${loc.id}: drafted=${outcome.drafted} skipped=${outcome.skipped} failed=${outcome.failed}`);
    return json({ ok: !failed, location_id: locationId, ...outcome });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "draft failed";
    console.error(`seo-draft ${locationId} unhandled: ${reason}`);
    await settle(loc, false, reason);
    return json({ ok: false, error: reason }, 500);
  }
});
