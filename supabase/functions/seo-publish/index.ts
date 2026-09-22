// =============================================================================
// seo-publish — module 5 (plan.md): applies approved seo_actions to the client's
// Shopify store, undoes them on request, hands anything the API can't do to the
// client as manual steps, and heartbeats the connection.
//
//   POST /seo-publish
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "location_id": "<uuid>", "task": "publish" | "check" }
//
// Admin endpoint, same posture as seo-crawl: the shared secret is the whole gate,
// dispatched by request_seo_site_job (0055) via pg_cron -> pg_net.
//
// RULE 1: this only ever acts on an action a human already moved to 'approved'
//   (or 'rollback_requested'). It never approves anything itself.
// RULE 2: only title_tag and meta_description are written through the API, into
//   Shopify's SEO override fields. Name, address, phone and category are not
//   reachable from here: seo_actions' CHECK refuses those target fields, and
//   lib.ts's decide() routes every other field to manual.
// RULE 3: the store's ACTUAL prior state is persisted to publish_result BEFORE the
//   write (see shopify.ts applyChange), plus the action's own idempotency key.
// RULE 6: Shopify calls retry with exponential backoff (shopify.ts gql).
//
// FALLBACK (plan.md: "if access is revoked, the dashboard flags it and the
// adapter falls back to export-only"). A revoked token, a missing scope, an
// unresolvable page, or a field the API can't write all become 'manual_required'
// with step-by-step instructions, never a silent drop.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET.
// The Shopify credential comes from Vault via get_seo_site_credentials (0055):
// JSON {"access_token": "shpat_..."} for a custom app with write_products and
// write_content (or write_online_store_pages).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  articleFromProposal,
  articleManualInstructions,
  connectionStatusFromScopes,
  decide,
  decideArticle,
  manualInstructions,
  priorFromPublishResult,
  type ArticleProposal,
  type ConnectionFacts,
  type ManualReason,
} from "./lib.ts";
import { applyChange, checkConnection, deleteArticle, publishArticle, revertChange, ShopifyError, type Ctx } from "./shopify.ts";
// The uniqueness rules are module 16's; publishing re-runs them, so it reuses them
// rather than keeping a second copy that could drift. (Bundled with this function
// at deploy time; verified with the edge-runtime bundle.)
import { checkUniqueness, type PriorPost } from "../seo-content/lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const MAX_ACTIONS_PER_RUN = 25;
const PUBLISH_BASE_INTERVAL_MINUTES = 5;
const CHECK_BASE_INTERVAL_MINUTES = 24 * 60;
const MAX_BACKOFF_MINUTES = 24 * 60;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type SiteCreds = {
  connection_id: string;
  shop_domain: string;
  primary_domain: string | null;
  status: string;
  granted_scopes: string[];
  credentials: string | null;
};

type ActionRow = {
  id: string;
  action_type: string;
  client_id: string;
  location_id: string;
  finding_id: string | null;
  status: string;
  target_field: string | null;
  target_url: string | null;
  apply_mode: string | null;
  proposed_value: { value?: string } | null;
  resource_ref: { resource_id?: string; key?: string; kind?: string; article_id?: string; blog_handle?: string } | null;
  publish_result: Record<string, unknown> | null;
};

function tokenFrom(secret: string | null): string | null {
  if (!secret) return null;
  try {
    const parsed = JSON.parse(secret);
    return typeof parsed?.access_token === "string" && parsed.access_token ? parsed.access_token : null;
  } catch {
    return null;
  }
}

async function loadCreds(locationId: string): Promise<SiteCreds | null> {
  const { data, error } = await supabase.rpc("get_seo_site_credentials", { p_location_id: locationId });
  if (error) throw new Error(`loading site credentials failed: ${error.message}`);
  return (data as SiteCreds | null) ?? null;
}

function makeCtx(creds: SiteCreds): Ctx | null {
  const token = tokenFrom(creds.credentials);
  if (!token) return null;
  return { shop: creds.shop_domain, token, fetch, sleep };
}

async function settle(clientId: string, locationId: string, jobType: string, success: boolean, error: string | null, base: number) {
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: clientId,
    p_job_type: jobType,
    p_success: success,
    p_error: error,
    p_base_interval_minutes: base,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: locationId,
  });
  if (jobError) console.error(`seo-publish ${locationId}: complete_job_attempt failed: ${jobError.message}`);
}

async function markConnection(connectionId: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from("seo_site_connections").update(patch).eq("id", connectionId);
  if (error) console.error(`seo-publish: updating connection ${connectionId} failed: ${error.message}`);
}

// -----------------------------------------------------------------------------
// task: check (heartbeat)
// -----------------------------------------------------------------------------

async function runCheck(locationId: string, clientId: string): Promise<Record<string, unknown>> {
  const creds = await loadCreds(locationId);
  if (!creds) {
    // No connection: nothing to check, and nothing to retry.
    await settle(clientId, locationId, "seo_site_check", true, null, CHECK_BASE_INTERVAL_MINUTES);
    return { status: "no_connection" };
  }
  const ctx = makeCtx(creds);
  const now = new Date().toISOString();

  if (!ctx) {
    await markConnection(creds.connection_id, {
      status: "error",
      last_error: "the Vault credential is missing or is not JSON with an access_token",
      last_checked_at: now,
    });
    await settle(clientId, locationId, "seo_site_check", false, "bad_credential", CHECK_BASE_INTERVAL_MINUTES);
    return { status: "error", error: "bad_credential" };
  }

  try {
    const { scopes, primaryHost } = await checkConnection(ctx);
    const status = connectionStatusFromScopes(scopes);
    await markConnection(creds.connection_id, {
      status,
      granted_scopes: scopes,
      primary_domain: primaryHost,
      last_checked_at: now,
      last_healthy_at: now,
      last_error: null,
    });
    await settle(clientId, locationId, "seo_site_check", true, null, CHECK_BASE_INTERVAL_MINUTES);
    return { status, scopes };
  } catch (e) {
    const err = e instanceof ShopifyError ? e : new ShopifyError("transient", e instanceof Error ? e.message : String(e));
    // 401 is a dead token; anything else may be temporary and must not flip a
    // healthy connection to revoked (which would push every draft to manual).
    const status = err.kind === "auth" ? "revoked" : "error";
    await markConnection(creds.connection_id, { status, last_error: err.message, last_checked_at: now });
    await settle(clientId, locationId, "seo_site_check", status !== "revoked" ? false : true, status === "revoked" ? null : err.message, CHECK_BASE_INTERVAL_MINUTES);
    return { status, error: err.message };
  }
}

// -----------------------------------------------------------------------------
// task: publish (also handles rollbacks)
// -----------------------------------------------------------------------------

async function toManual(action: ActionRow, reason: ManualReason, detail?: string) {
  const proposed = String(action.proposed_value?.value ?? "");
  const instructions = manualInstructions(
    { target_field: action.target_field, target_url: action.target_url, proposed },
    reason,
    detail,
  );
  const { error } = await supabase
    .from("seo_actions")
    .update({ status: "manual_required", apply_mode: "manual", manual_instructions: instructions, error: null })
    .eq("id", action.id);
  if (error) console.error(`seo-publish: marking ${action.id} manual failed: ${error.message}`);
}

async function publishOne(action: ActionRow, creds: SiteCreds | null): Promise<"published" | "manual" | "retry" | "skipped"> {
  const { data: claimed, error: claimErr } = await supabase.rpc("claim_seo_action", { p_action_id: action.id, p_kind: "publish" });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  if (!claimed) return "skipped"; // another run has it

  const conn: ConnectionFacts | null = creds
    ? { status: creds.status, granted_scopes: creds.granted_scopes ?? [], shop_domain: creds.shop_domain, primary_domain: creds.primary_domain }
    : null;
  const decision = decide(action, conn);

  if (decision.mode === "manual") {
    await toManual(action, decision.reason, decision.detail);
    return "manual";
  }

  const ctx = creds ? makeCtx(creds) : null;
  if (!ctx) {
    await toManual(action, "no_site_connection");
    return "manual";
  }

  const proposed = String(action.proposed_value?.value ?? "");
  if (!proposed) {
    await supabase.from("seo_actions").update({ status: "failed", error: "the draft has no proposed value" }).eq("id", action.id);
    return "skipped";
  }

  try {
    const result = await applyChange(
      ctx,
      decision,
      proposed,
      priorFromPublishResult(action.publish_result),
      async (prior) => {
        const { error } = await supabase
          .from("seo_actions")
          .update({ publish_result: { ...(action.publish_result ?? {}), previous_override: prior } })
          .eq("id", action.id);
        // If the prior state can't be saved, the write must not happen.
        if (error) throw new Error(`could not record the prior state: ${error.message}`);
      },
    );

    const now = new Date().toISOString();
    const { error: upErr } = await supabase
      .from("seo_actions")
      .update({
        status: "published",
        apply_mode: "api",
        published_at: now,
        error: null,
        resource_ref: { platform: "shopify", resource_id: result.resource_id, key: decision.key, kind: decision.kind },
        publish_result: {
          previous_override: result.prior,
          written: proposed,
          verified: true,
          noop: result.noop,
        },
      })
      .eq("id", action.id);
    if (upErr) throw new Error(`the change was applied but recording it failed: ${upErr.message}`);

    if (action.finding_id) {
      await supabase.from("seo_findings").update({ status: "resolved", resolved_at: now }).eq("id", action.finding_id);
    }
    return "published";
  } catch (e) {
    if (e instanceof ShopifyError) {
      if (e.kind === "auth") {
        if (creds) await markConnection(creds.connection_id, { status: "revoked", last_error: e.message, last_checked_at: new Date().toISOString() });
        await toManual(action, "connection_revoked");
        return "manual";
      }
      if (e.kind === "scope") {
        await toManual(action, "missing_scope");
        return "manual";
      }
      if (e.kind === "not_found") {
        await toManual(action, "resource_not_found");
        return "manual";
      }
      if (e.kind === "user") {
        // Shopify understood the request and refused it (e.g. a value it won't
        // accept). Retrying won't change that, so tell the human what to do.
        await toManual(action, "resource_lookup_failed", e.message);
        return "manual";
      }
    }
    // Transient (or the resolve query itself was rejected): put it back to
    // 'approved' so the next tick retries, and surface the reason.
    const message = e instanceof Error ? e.message : String(e);
    console.error(`seo-publish ${action.id}: ${message}`);
    await supabase.from("seo_actions").update({ status: "approved", error: message }).eq("id", action.id);
    return "retry";
  }
}

async function rollbackOne(action: ActionRow, creds: SiteCreds | null): Promise<"rolled_back" | "kept" | "retry" | "skipped"> {
  const { data: claimed, error: claimErr } = await supabase.rpc("claim_seo_action", { p_action_id: action.id, p_kind: "rollback" });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  if (!claimed) return "skipped";

  const keep = async (message: string) => {
    // Back to 'published' with the reason, so the tenant sees why and can retry.
    await supabase.from("seo_actions").update({ status: "published", error: `Rollback not done: ${message}` }).eq("id", action.id);
  };

  if (action.resource_ref?.kind === "article") return await rollbackArticle(action, creds, keep);

  const prior = priorFromPublishResult(action.publish_result);
  const ref = action.resource_ref;
  const written = (action.publish_result as { written?: string } | null)?.written;
  const ctx = creds ? makeCtx(creds) : null;

  if (!prior || !ref?.resource_id || !ref.key || written === undefined) {
    await keep("LumiLink has no record of what the page held before, so it can't safely restore it.");
    return "kept";
  }
  if (!ctx) {
    await keep("LumiLink no longer has working access to the store.");
    return "kept";
  }

  try {
    await revertChange(ctx, ref.resource_id, ref.key as "title_tag" | "description_tag", written, prior);
    await supabase.from("seo_actions").update({ status: "rolled_back", rolled_back_at: new Date().toISOString(), error: null }).eq("id", action.id);
    return "rolled_back";
  } catch (e) {
    if (e instanceof ShopifyError) {
      if (e.kind === "drift" || e.kind === "not_found" || e.kind === "scope" || e.kind === "user") {
        await keep(e.message);
        return "kept";
      }
      if (e.kind === "auth" && creds) {
        await markConnection(creds.connection_id, { status: "revoked", last_error: e.message, last_checked_at: new Date().toISOString() });
        await keep("LumiLink's access to the store was revoked.");
        return "kept";
      }
    }
    // Transient: leave it requested so the next tick tries again.
    const message = e instanceof Error ? e.message : String(e);
    console.error(`seo-publish rollback ${action.id}: ${message}`);
    await supabase.from("seo_actions").update({ status: "rollback_requested", error: message }).eq("id", action.id);
    return "retry";
  }
}


// -----------------------------------------------------------------------------
// Articles (module 16)
// -----------------------------------------------------------------------------

function parseVec(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v !== "string") return null;
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) && a.length === 384 ? a : null;
  } catch {
    return null;
  }
}

async function toManualArticle(action: ActionRow, article: ArticleProposal, reason: ManualReason, detail?: string) {
  const { error } = await supabase
    .from("seo_actions")
    .update({ status: "manual_required", apply_mode: "manual", manual_instructions: articleManualInstructions(article, reason, detail), error: null })
    .eq("id", action.id);
  if (error) console.error(`seo-publish: marking article ${action.id} manual failed: ${error.message}`);
}

/**
 * The uniqueness check, again, just before publishing: a sibling location's
 * article may have been drafted since this one was. Fails CLOSED: with no ledger
 * row there is nothing to compare, and "couldn't check" must not read as "fine".
 * Returns why it is blocked, or null.
 */
async function uniquenessBlock(action: ActionRow): Promise<string | null> {
  const { data, error } = await supabase
    .from("seo_content_posts")
    .select("id, action_id, location_id, title, body_text, content_embedding")
    .eq("client_id", action.client_id)
    .eq("state", "active");
  if (error) throw new Error(`loading the article ledger failed: ${error.message}`);
  const rows = data ?? [];
  const own = rows.find((r) => r.action_id === action.id);
  if (!own) return "this article has no record in the uniqueness ledger, so it can't be checked";
  const priors: PriorPost[] = rows
    .filter((r) => r.id !== own.id)
    .map((r) => ({ id: r.id, location_id: r.location_id, title: r.title, body_text: r.body_text, content_embedding: parseVec(r.content_embedding) }));
  const verdict = checkUniqueness(own.body_text, parseVec(own.content_embedding), priors);
  return verdict.ok ? null : `it is too similar to another article: ${verdict.reason}`;
}

async function publishArticleOne(action: ActionRow, creds: SiteCreds | null): Promise<"published" | "manual" | "retry" | "skipped"> {
  const { data: claimed, error: claimErr } = await supabase.rpc("claim_seo_action", { p_action_id: action.id, p_kind: "publish" });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  if (!claimed) return "skipped";

  const article = articleFromProposal(action.proposed_value);
  if (!article) {
    await supabase.from("seo_actions").update({ status: "failed", error: "the draft is malformed and can't be published" }).eq("id", action.id);
    return "skipped";
  }

  const conn: ConnectionFacts | null = creds
    ? { status: creds.status, granted_scopes: creds.granted_scopes ?? [], shop_domain: creds.shop_domain, primary_domain: creds.primary_domain }
    : null;
  const decision = decideArticle(conn);
  const ctx = creds ? makeCtx(creds) : null;
  if (decision.mode === "manual" || !ctx) {
    await toManualArticle(action, article, decision.mode === "manual" ? decision.reason : "no_site_connection", decision.mode === "manual" ? decision.detail : undefined);
    return "manual";
  }

  const blocked = await uniquenessBlock(action);
  if (blocked) {
    // 'failed' also retires the ledger row (0056's trigger), freeing the topic.
    await supabase.from("seo_actions").update({ status: "failed", error: `Not published: ${blocked}` }).eq("id", action.id);
    return "skipped";
  }

  const { data: loc } = await supabase.from("seo_locations").select("name").eq("id", action.location_id).maybeSingle();

  try {
    const r = await publishArticle(ctx, { article, author: loc?.name ?? "Editorial team" });
    const host = creds!.primary_domain ?? creds!.shop_domain;
    const now = new Date().toISOString();
    const { error: upErr } = await supabase
      .from("seo_actions")
      .update({
        status: "published",
        apply_mode: "api",
        published_at: now,
        error: null,
        target_url: `https://${host}/blogs/${r.blog_handle}/${r.handle}`,
        resource_ref: { platform: "shopify", kind: "article", article_id: r.id, blog_handle: r.blog_handle, handle: r.handle },
        publish_result: {
          written: { title: article.title, body_html: article.body_html },
          verified: true,
          adopted: r.adopted,
          image_error: r.image_error,
          meta_verified: r.meta_verified,
        },
      })
      .eq("id", action.id);
    if (upErr) throw new Error(`the article was published but recording it failed: ${upErr.message}`);
    return "published";
  } catch (e) {
    if (e instanceof ShopifyError) {
      if (e.kind === "auth") {
        await markConnection(creds!.connection_id, { status: "revoked", last_error: e.message, last_checked_at: new Date().toISOString() });
        await toManualArticle(action, article, "connection_revoked");
        return "manual";
      }
      if (e.kind === "scope") {
        await toManualArticle(action, article, "missing_scope", "write_content");
        return "manual";
      }
      if (e.kind === "not_found" || e.kind === "user") {
        await toManualArticle(action, article, "resource_lookup_failed", e.message);
        return "manual";
      }
    }
    // Transient: back to 'approved'. A retry adopts the article if it did get
    // created (publishArticle finds it by handle and body), so this can't duplicate.
    const message = e instanceof Error ? e.message : String(e);
    console.error(`seo-publish article ${action.id}: ${message}`);
    await supabase.from("seo_actions").update({ status: "approved", error: message }).eq("id", action.id);
    return "retry";
  }
}

async function rollbackArticle(
  action: ActionRow,
  creds: SiteCreds | null,
  keep: (message: string) => Promise<void>,
): Promise<"rolled_back" | "kept" | "retry"> {
  const id = action.resource_ref?.article_id;
  const written = (action.publish_result as { written?: { title?: string; body_html?: string } } | null)?.written;
  const ctx = creds ? makeCtx(creds) : null;

  if (!id || !written?.title || written.body_html === undefined) {
    await keep("LumiLink has no record of what it published, so it can't safely delete it.");
    return "kept";
  }
  if (!ctx) {
    await keep("LumiLink no longer has working access to the store.");
    return "kept";
  }

  try {
    await deleteArticle(ctx, id, { title: written.title, body_html: written.body_html });
    await supabase.from("seo_actions").update({ status: "rolled_back", rolled_back_at: new Date().toISOString(), error: null }).eq("id", action.id);
    return "rolled_back";
  } catch (e) {
    if (e instanceof ShopifyError) {
      if (e.kind === "drift" || e.kind === "scope" || e.kind === "user" || e.kind === "not_found") {
        await keep(e.message);
        return "kept";
      }
      if (e.kind === "auth" && creds) {
        await markConnection(creds.connection_id, { status: "revoked", last_error: e.message, last_checked_at: new Date().toISOString() });
        await keep("LumiLink's access to the store was revoked.");
        return "kept";
      }
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error(`seo-publish article rollback ${action.id}: ${message}`);
    await supabase.from("seo_actions").update({ status: "rollback_requested", error: message }).eq("id", action.id);
    return "retry";
  }
}

async function runPublish(locationId: string, clientId: string): Promise<Record<string, unknown>> {
  const { data: actions, error } = await supabase
    .from("seo_actions")
    .select("id, client_id, location_id, finding_id, action_type, status, target_field, target_url, apply_mode, proposed_value, resource_ref, publish_result, updated_at")
    .eq("location_id", locationId)
    .in("status", ["approved", "rollback_requested", "publishing", "rolling_back"])
    .order("created_at", { ascending: true })
    .limit(MAX_ACTIONS_PER_RUN);
  if (error) throw new Error(`loading actions failed: ${error.message}`);

  const creds = await loadCreds(locationId);
  const tally = { published: 0, manual: 0, rolled_back: 0, kept: 0, retry: 0, skipped: 0 };
  const stale = Date.now() - 15 * 60 * 1000;

  for (const a of (actions ?? []) as (ActionRow & { updated_at: string })[]) {
    // A row still 'publishing'/'rolling_back' is only ours to touch once it has
    // been stuck past the claim window (claim_seo_action enforces the same).
    const inFlightAndFresh = (a.status === "publishing" || a.status === "rolling_back") && new Date(a.updated_at).getTime() > stale;
    if (inFlightAndFresh) {
      tally.skipped++;
      continue;
    }
    const isRollback = a.status === "rollback_requested" || a.status === "rolling_back";
    const outcome = isRollback
      ? await rollbackOne(a, creds)
      : a.action_type === "content_publish"
        ? await publishArticleOne(a, creds)
        : await publishOne(a, creds);
    tally[outcome as keyof typeof tally]++;
  }

  const failed = tally.retry > 0;
  await settle(clientId, locationId, "seo_publish", !failed, failed ? `${tally.retry} action(s) will be retried` : null, PUBLISH_BASE_INTERVAL_MINUTES);
  return { ok: !failed, ...tally };
}

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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const locationId = String(body.location_id ?? "").trim();
  const task = String(body.task ?? "publish");
  if (!locationId) return json({ error: "location_id is required" }, 400);
  if (task !== "publish" && task !== "check") return json({ error: "task must be 'publish' or 'check'" }, 400);

  const { data: loc, error } = await supabase.from("seo_locations").select("id, client_id").eq("id", locationId).maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!loc) return json({ error: "location not found" }, 404);

  try {
    const result = task === "check" ? await runCheck(loc.id, loc.client_id) : await runPublish(loc.id, loc.client_id);
    console.log(`seo-publish ${loc.id} ${task}: ${JSON.stringify(result)}`);
    return json({ location_id: loc.id, task, ...result });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "failed";
    console.error(`seo-publish ${loc.id} ${task} unhandled: ${reason}`);
    await settle(
      loc.client_id,
      loc.id,
      task === "check" ? "seo_site_check" : "seo_publish",
      false,
      reason,
      task === "check" ? CHECK_BASE_INTERVAL_MINUTES : PUBLISH_BASE_INTERVAL_MINUTES,
    );
    return json({ ok: false, error: reason }, 500);
  }
});
