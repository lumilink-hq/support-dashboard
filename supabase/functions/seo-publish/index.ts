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
// GITHUB (2026-10-09, 0075): a connection with platform 'github' publishes to a
// Next.js site's repository instead (github.ts / github-lib.ts): articles become
// content/blog/<slug>.html and titles/descriptions entries in
// content/seo-overrides.json, each one commit. Same rules: only approved
// actions, prior state recorded before the write, drift refuses a rollback,
// anything it can't do goes manual. Built for LumiLink's own site.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET.
// The Shopify credential comes from Vault via get_seo_site_credentials (0055):
// JSON {"access_token": "shpat_..."} for a legacy custom app, or
// {"client_id": "...", "client_secret": "..."} for a Dev Dashboard app (the only
// kind Shopify lets a store create since 2026-01-01; exchanged for a 24-hour
// token per run). Either needs write_products and write_content (or
// write_online_store_pages).
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
  slugify,
  type ArticleProposal,
  type ConnectionFacts,
  type ManualReason,
} from "./lib.ts";
import {
  applyChange,
  checkConnection,
  deleteArticle,
  exchangeClientCredentials,
  parseShopifyCredential,
  publishArticle,
  revertChange,
  ShopifyError,
  type Ctx,
} from "./shopify.ts";
import { checkRepo, deleteFile, GithubError, readFile, writeFile, type GhCtx } from "./github.ts";
import { applyGbpField, GbpError, gbpManualInstructions, isWritable, revertGbpField, type GbpCtx, type GbpManualReason } from "./gbp.ts";
import {
  articleFile,
  blogPath,
  decideGithub,
  githubManualInstructions,
  OVERRIDES_FILE,
  parseOverrides,
  revertOverride,
  serializeOverrides,
  setOverride,
  utcDate,
  type GithubManualReason,
  type OverrideKey,
} from "./github-lib.ts";
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
  platform?: "shopify" | "github"; // 0075; absent before it, meaning shopify
  repo?: string | null; // github: owner/name
  branch?: string | null; // github: the branch the site deploys from
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
  resource_ref: { resource_id?: string; key?: string; kind?: string; article_id?: string; blog_handle?: string; path?: string; sha?: string } | null;
  publish_result: Record<string, unknown> | null;
  approved_at?: string | null;
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

// Dev Dashboard apps' 24-hour tokens, kept for the life of this instance.
const exchangedTokens = new Map<string, { token: string; expiresAt: number }>();

/** Why the last makeCtx returned null, for the heartbeat's last_error. */
let lastCredError = "the Vault credential is missing or is not JSON with an access_token or a client_id and client_secret";

async function makeCtx(creds: SiteCreds): Promise<Ctx | null> {
  const cred = parseShopifyCredential(creds.credentials);
  if (!cred) {
    lastCredError = "the Vault credential is missing or is not JSON with an access_token or a client_id and client_secret";
    return null;
  }
  if (cred.kind === "token") return { shop: creds.shop_domain, token: cred.token, fetch, sleep };

  const key = `${creds.shop_domain}:${cred.clientId}`;
  const cached = exchangedTokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return { shop: creds.shop_domain, token: cached.token, fetch, sleep };
  try {
    const fresh = await exchangeClientCredentials(creds.shop_domain, cred, fetch);
    exchangedTokens.set(key, fresh);
    return { shop: creds.shop_domain, token: fresh.token, fetch, sleep };
  } catch (e) {
    lastCredError = e instanceof Error ? e.message : String(e);
    console.error(`seo-publish ${creds.shop_domain}: ${lastCredError}`);
    return null;
  }
}

function makeGhCtx(creds: SiteCreds): GhCtx | null {
  const token = tokenFrom(creds.credentials);
  if (!token || !creds.repo) return null;
  return { repo: creds.repo, branch: creds.branch || "main", token, fetch, sleep, apiBase: Deno.env.get("SEO_GITHUB_API_URL") || undefined };
}

const isGithub = (creds: SiteCreds | null) => creds?.platform === "github";

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
  if (isGithub(creds)) return await runCheckGithub(creds, locationId, clientId);
  const ctx = await makeCtx(creds);
  const now = new Date().toISOString();

  if (!ctx) {
    await markConnection(creds.connection_id, {
      status: "error",
      last_error: lastCredError,
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

  const ctx = creds ? await makeCtx(creds) : null;
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
  const ctx = creds ? await makeCtx(creds) : null;

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
// Google Business Profile edits (module 4, seo-publish/gbp.ts)
// -----------------------------------------------------------------------------

type GbpTarget = { ctx: GbpCtx; locationName: string } | { reason: GbpManualReason; detail?: string };

/** The linked profile and a usable Google token for this action's location. */
async function gbpTarget(action: ActionRow): Promise<GbpTarget> {
  const [{ data: listing }, { data: conn }, { data: tok }] = await Promise.all([
    supabase.from("seo_gbp_locations").select("location_name").eq("linked_location_id", action.location_id).maybeSingle(),
    supabase.from("google_oauth_connections").select("status, granted_scopes").eq("client_id", action.client_id).maybeSingle(),
    supabase.from("google_oauth_tokens").select("access_token_cache, access_token_expires_at").eq("client_id", action.client_id).maybeSingle(),
  ]);
  if (!listing?.location_name) return { reason: "resource_not_found", detail: "no Business Profile is linked to this location" };
  if (!conn || conn.status === "revoked") return { reason: "connection_revoked" };
  if (!((conn.granted_scopes ?? []) as string[]).some((s) => s.endsWith("/business.manage"))) return { reason: "no_site_connection" };
  const fresh = tok?.access_token_cache && (!tok.access_token_expires_at || new Date(tok.access_token_expires_at).getTime() > Date.now() + 60_000);
  if (!fresh) return { reason: "connection_revoked", detail: "the cached Google token is stale; it refreshes every 15 minutes" };
  return {
    ctx: { token: tok!.access_token_cache as string, fetch, sleep, base: Deno.env.get("GBP_INFO_API_BASE") || undefined },
    locationName: listing.location_name as string,
  };
}

async function toManualGbp(action: ActionRow, reason: GbpManualReason, detail?: string) {
  const instructions = gbpManualInstructions(action.target_field ?? "", String(action.proposed_value?.value ?? ""), reason, detail);
  const { error } = await supabase
    .from("seo_actions")
    .update({ status: "manual_required", apply_mode: "manual", manual_instructions: instructions, error: null })
    .eq("id", action.id);
  if (error) console.error(`seo-publish: marking ${action.id} manual failed: ${error.message}`);
}

async function publishGbpOne(action: ActionRow): Promise<"published" | "manual" | "retry" | "skipped"> {
  // Rule 2: refuse anything off the allowlist before claiming or calling Google.
  if (!isWritable(action.target_field)) {
    await supabase.from("seo_actions").update({ status: "failed", error: `${action.target_field} can't be written to a Business Profile` }).eq("id", action.id);
    return "skipped";
  }
  const { data: claimed, error: claimErr } = await supabase.rpc("claim_seo_action", { p_action_id: action.id, p_kind: "publish" });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  if (!claimed) return "skipped";

  const proposed = String(action.proposed_value?.value ?? "");
  if (!proposed) {
    await supabase.from("seo_actions").update({ status: "failed", error: "the draft has no proposed value" }).eq("id", action.id);
    return "skipped";
  }
  const target = await gbpTarget(action);
  if ("reason" in target) {
    await toManualGbp(action, target.reason, target.detail);
    return "manual";
  }

  const savedPrior = (action.publish_result as { previous_profile_value?: string } | null)?.previous_profile_value;
  try {
    const r = await applyGbpField(target.ctx, target.locationName, action.target_field!, proposed, typeof savedPrior === "string" ? savedPrior : null, async (prior) => {
      const { error } = await supabase
        .from("seo_actions")
        .update({ publish_result: { ...(action.publish_result ?? {}), previous_profile_value: prior } })
        .eq("id", action.id);
      if (error) throw new Error(`could not record the prior state: ${error.message}`);
    });
    const now = new Date().toISOString();
    const { error: upErr } = await supabase
      .from("seo_actions")
      .update({
        status: "published",
        apply_mode: "api",
        published_at: now,
        error: r.pending ? "Google is reviewing this change; it can take a few days to show on the profile." : null,
        resource_ref: { platform: "gbp", location_name: target.locationName, field: action.target_field },
        publish_result: { previous_profile_value: r.prior, written: proposed, verified: r.verified, pending: r.pending, noop: r.noop },
      })
      .eq("id", action.id);
    if (upErr) throw new Error(`the change was applied but recording it failed: ${upErr.message}`);
    if (action.finding_id) await supabase.from("seo_findings").update({ status: "resolved", resolved_at: now }).eq("id", action.finding_id);
    return "published";
  } catch (e) {
    if (e instanceof GbpError) {
      if (e.kind === "auth") {
        await toManualGbp(action, "connection_revoked");
        return "manual";
      }
      if (e.kind === "no_access") {
        await toManualGbp(action, "missing_scope");
        return "manual";
      }
      if (e.kind === "not_found") {
        await toManualGbp(action, "resource_not_found");
        return "manual";
      }
      if (e.kind === "user") {
        await toManualGbp(action, "resource_lookup_failed", e.message);
        return "manual";
      }
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error(`seo-publish gbp ${action.id}: ${message}`);
    await supabase.from("seo_actions").update({ status: "approved", error: message }).eq("id", action.id);
    return "retry";
  }
}

async function rollbackGbpOne(action: ActionRow): Promise<"rolled_back" | "kept" | "retry" | "skipped"> {
  const { data: claimed, error: claimErr } = await supabase.rpc("claim_seo_action", { p_action_id: action.id, p_kind: "rollback" });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  if (!claimed) return "skipped";
  const keep = async (message: string) => {
    await supabase.from("seo_actions").update({ status: "published", error: `Rollback not done: ${message}` }).eq("id", action.id);
  };
  const pr = (action.publish_result ?? {}) as { previous_profile_value?: string; written?: string };
  if (typeof pr.previous_profile_value !== "string" || typeof pr.written !== "string") {
    await keep("LumiLink has no record of what the profile said before, so it can't safely restore it.");
    return "kept";
  }
  const target = await gbpTarget(action);
  if ("reason" in target) {
    await keep("LumiLink no longer has working access to this Business Profile.");
    return "kept";
  }
  try {
    await revertGbpField(target.ctx, target.locationName, action.target_field ?? "", pr.written, pr.previous_profile_value);
    await supabase.from("seo_actions").update({ status: "rolled_back", rolled_back_at: new Date().toISOString(), error: null }).eq("id", action.id);
    return "rolled_back";
  } catch (e) {
    if (e instanceof GbpError && e.kind !== "transient") {
      await keep(e.message);
      return "kept";
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error(`seo-publish gbp rollback ${action.id}: ${message}`);
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
  const ctx = creds ? await makeCtx(creds) : null;
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
  const ctx = creds ? await makeCtx(creds) : null;

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

// -----------------------------------------------------------------------------
// GitHub (0075): a Next.js site's repository
// -----------------------------------------------------------------------------

async function runCheckGithub(creds: SiteCreds, locationId: string, clientId: string): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  const ctx = makeGhCtx(creds);
  if (!ctx) {
    await markConnection(creds.connection_id, { status: "error", last_error: "the Vault credential is missing, or the connection has no repo", last_checked_at: now });
    await settle(clientId, locationId, "seo_site_check", false, "bad_credential", CHECK_BASE_INTERVAL_MINUTES);
    return { status: "error", error: "bad_credential" };
  }
  try {
    const { push } = await checkRepo(ctx);
    const status = push ? "healthy" : "degraded";
    await markConnection(creds.connection_id, {
      status,
      granted_scopes: push ? ["contents:write"] : ["contents:read"],
      last_checked_at: now,
      last_healthy_at: now,
      last_error: push ? null : "the token can read the repository but not push to it",
    });
    await settle(clientId, locationId, "seo_site_check", true, null, CHECK_BASE_INTERVAL_MINUTES);
    return { status };
  } catch (e) {
    const err = e instanceof GithubError ? e : new GithubError("transient", e instanceof Error ? e.message : String(e));
    const status = err.kind === "auth" ? "revoked" : "error";
    await markConnection(creds.connection_id, { status, last_error: err.message, last_checked_at: now });
    await settle(clientId, locationId, "seo_site_check", status === "revoked", status === "revoked" ? null : err.message, CHECK_BASE_INTERVAL_MINUTES);
    return { status, error: err.message };
  }
}

async function toManualGithub(action: ActionRow, reason: GithubManualReason) {
  const instructions = githubManualInstructions(
    { target_field: action.target_field, target_url: action.target_url, proposed: String(action.proposed_value?.value ?? "") },
    reason,
  );
  const { error } = await supabase
    .from("seo_actions")
    .update({ status: "manual_required", apply_mode: "manual", manual_instructions: instructions, error: null })
    .eq("id", action.id);
  if (error) console.error(`seo-publish: marking ${action.id} manual failed: ${error.message}`);
}

/** An article as the exact file to add, for when the publisher can't. */
async function toManualArticleGithub(action: ActionRow, file: string, path: string, why: string) {
  const { error } = await supabase
    .from("seo_actions")
    .update({
      status: "manual_required",
      apply_mode: "manual",
      error: null,
      manual_instructions: {
        reason: "no_site_connection",
        why,
        steps: [`Add a file at ${path} in the site's repository with exactly the text below.`, "Commit and push; the post is live a couple of minutes after the deploy."],
        copy: { label: path, text: file },
      },
    })
    .eq("id", action.id);
  if (error) console.error(`seo-publish: marking article ${action.id} manual failed: ${error.message}`);
}

/** Map a GithubError onto the action, the same way the Shopify paths do. */
async function githubFailure(action: ActionRow, creds: SiteCreds, e: unknown, onManual: (reason: GithubManualReason) => Promise<void>): Promise<"manual" | "retry"> {
  if (e instanceof GithubError && (e.kind === "auth" || e.kind === "scope")) {
    if (e.kind === "auth") await markConnection(creds.connection_id, { status: "revoked", last_error: e.message, last_checked_at: new Date().toISOString() });
    await onManual("connection_revoked");
    return "manual";
  }
  const message = e instanceof Error ? e.message : String(e);
  console.error(`seo-publish github ${action.id}: ${message}`);
  await supabase.from("seo_actions").update({ status: "approved", error: message }).eq("id", action.id);
  return "retry";
}

const siteHosts = (creds: SiteCreds) => [creds.primary_domain, creds.shop_domain].filter((h): h is string => !!h);

async function publishOverrideGithub(action: ActionRow, creds: SiteCreds): Promise<"published" | "manual" | "retry" | "skipped"> {
  const { data: claimed, error: claimErr } = await supabase.rpc("claim_seo_action", { p_action_id: action.id, p_kind: "publish" });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  if (!claimed) return "skipped";

  const decision = decideGithub(action, { status: creds.status, site_hosts: siteHosts(creds) });
  const ctx = makeGhCtx(creds);
  if (decision.mode === "manual" || !ctx) {
    await toManualGithub(action, decision.mode === "manual" ? decision.reason : "no_site_connection");
    return "manual";
  }
  const proposed = String(action.proposed_value?.value ?? "");
  if (!proposed) {
    await supabase.from("seo_actions").update({ status: "failed", error: "the draft has no proposed value" }).eq("id", action.id);
    return "skipped";
  }

  try {
    // Read-modify-write on one shared file: a concurrent commit makes the sha
    // stale (409/422), so re-read and try again.
    for (let attempt = 1; ; attempt++) {
      const file = await readFile(ctx, OVERRIDES_FILE);
      const current = parseOverrides(file?.text ?? null);
      const { next, prior } = setOverride(current, decision.path, decision.key, proposed);
      const recorded = { id: null, value: prior, recorded_at: new Date().toISOString() };
      // RULE 3: what was there before is stored before the write.
      const { error: prErr } = await supabase
        .from("seo_actions")
        .update({ publish_result: { ...(action.publish_result ?? {}), previous_override: recorded } })
        .eq("id", action.id);
      if (prErr) throw new Error(`could not record the prior state: ${prErr.message}`);

      let commit: string | null = null;
      const noop = prior === proposed;
      if (!noop) {
        try {
          commit = (await writeFile(ctx, OVERRIDES_FILE, serializeOverrides(next), `SEO: ${decision.key} for ${decision.path} (approved draft ${action.id})`, file?.sha ?? null)).commit;
        } catch (e) {
          if (e instanceof GithubError && e.kind === "conflict" && attempt < 3) continue;
          throw e;
        }
      }
      const now = new Date().toISOString();
      const { error: upErr } = await supabase
        .from("seo_actions")
        .update({
          status: "published",
          apply_mode: "api",
          published_at: now,
          error: null,
          resource_ref: { platform: "github", kind: "override", path: decision.path, key: decision.key },
          publish_result: { previous_override: recorded, written: proposed, verified: true, noop, commit },
        })
        .eq("id", action.id);
      if (upErr) throw new Error(`the change was committed but recording it failed: ${upErr.message}`);
      if (action.finding_id) await supabase.from("seo_findings").update({ status: "resolved", resolved_at: now }).eq("id", action.finding_id);
      return "published";
    }
  } catch (e) {
    return await githubFailure(action, creds, e, (reason) => toManualGithub(action, reason));
  }
}

async function publishArticleGithub(action: ActionRow, creds: SiteCreds): Promise<"published" | "manual" | "retry" | "skipped"> {
  const { data: claimed, error: claimErr } = await supabase.rpc("claim_seo_action", { p_action_id: action.id, p_kind: "publish" });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  if (!claimed) return "skipped";

  const article = articleFromProposal(action.proposed_value);
  if (!article) {
    await supabase.from("seo_actions").update({ status: "failed", error: "the draft is malformed and can't be published" }).eq("id", action.id);
    return "skipped";
  }
  // The approval date, not today's: a retry tomorrow must produce the same file.
  const date = utcDate(action.approved_at ? new Date(action.approved_at) : new Date());
  const text = articleFile({ ...article, date });
  const base = slugify(article.title);

  const ctx = makeGhCtx(creds);
  if (!ctx || creds.status === "revoked") {
    await toManualArticleGithub(action, text, blogPath(base), ctx ? GITHUB_WHY_REVOKED : "This site isn't connected to LumiLink for publishing yet.");
    return "manual";
  }

  const blocked = await uniquenessBlock(action);
  if (blocked) {
    await supabase.from("seo_actions").update({ status: "failed", error: `Not published: ${blocked}` }).eq("id", action.id);
    return "skipped";
  }

  try {
    // First free slug; a file that already holds exactly this article is ours
    // from an earlier attempt, so adopt it rather than publish a second copy.
    let slug = base;
    let sha: string | null = null;
    let adopted = false;
    for (let i = 1; i < 100; i++) {
      slug = i === 1 ? base : `${base}-${i}`;
      const existing = await readFile(ctx, blogPath(slug));
      if (!existing) break;
      if (existing.text === text) {
        sha = existing.sha;
        adopted = true;
        break;
      }
    }
    const path = blogPath(slug);
    let commit: string | null = null;
    if (!adopted) {
      const w = await writeFile(ctx, path, text, `SEO: publish article "${article.title}" (approved draft ${action.id})`, null);
      sha = w.sha;
      commit = w.commit;
    }
    const host = creds.primary_domain ?? creds.shop_domain;
    const now = new Date().toISOString();
    const { error: upErr } = await supabase
      .from("seo_actions")
      .update({
        status: "published",
        apply_mode: "api",
        published_at: now,
        error: null,
        target_url: `https://${host}/blog/${slug}`,
        resource_ref: { platform: "github", kind: "article", path, sha },
        publish_result: { written: { title: article.title, body_html: article.body_html }, verified: true, adopted, commit, image_error: null, meta_verified: true },
      })
      .eq("id", action.id);
    if (upErr) throw new Error(`the article was committed but recording it failed: ${upErr.message}`);
    return "published";
  } catch (e) {
    return await githubFailure(action, creds, e, () => toManualArticleGithub(action, text, blogPath(base), GITHUB_WHY_REVOKED));
  }
}

const GITHUB_WHY_REVOKED = "LumiLink's access to the site's GitHub repository was revoked or has expired.";

async function rollbackGithub(action: ActionRow, creds: SiteCreds): Promise<"rolled_back" | "kept" | "retry" | "skipped"> {
  const { data: claimed, error: claimErr } = await supabase.rpc("claim_seo_action", { p_action_id: action.id, p_kind: "rollback" });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  if (!claimed) return "skipped";

  const keep = async (message: string) => {
    await supabase.from("seo_actions").update({ status: "published", error: `Rollback not done: ${message}` }).eq("id", action.id);
    return "kept" as const;
  };
  const done = async () => {
    await supabase.from("seo_actions").update({ status: "rolled_back", rolled_back_at: new Date().toISOString(), error: null }).eq("id", action.id);
    return "rolled_back" as const;
  };
  const ref = action.resource_ref;
  const ctx = makeGhCtx(creds);
  if (!ctx || creds.status === "revoked") return await keep("LumiLink no longer has working access to the repository.");

  try {
    if (ref?.kind === "article" && ref.path && ref.sha) {
      const file = await readFile(ctx, ref.path);
      if (!file) return await done(); // already removed by hand
      if (file.sha !== ref.sha) return await keep("the article file was edited after LumiLink published it, so it was left as it is.");
      await deleteFile(ctx, ref.path, file.sha, `SEO: roll back article ${ref.path} (draft ${action.id})`);
      return await done();
    }
    if (ref?.kind === "override" && ref.path && ref.key) {
      const written = (action.publish_result as { written?: string } | null)?.written;
      const prior = priorFromPublishResult(action.publish_result);
      if (written === undefined || !prior) return await keep("LumiLink has no record of what the page held before, so it can't safely restore it.");
      for (let attempt = 1; ; attempt++) {
        const file = await readFile(ctx, OVERRIDES_FILE);
        const r = revertOverride(parseOverrides(file?.text ?? null), ref.path, ref.key as OverrideKey, written, prior.value);
        if (r === "drift") return await keep("the title or description was changed after LumiLink set it, so it was left as it is.");
        try {
          await writeFile(ctx, OVERRIDES_FILE, serializeOverrides(r.next), `SEO: roll back ${ref.key} for ${ref.path} (draft ${action.id})`, file?.sha ?? null);
        } catch (e) {
          if (e instanceof GithubError && e.kind === "conflict" && attempt < 3) continue;
          throw e;
        }
        return await done();
      }
    }
    return await keep("LumiLink has no record of what it published, so it can't safely undo it.");
  } catch (e) {
    if (e instanceof GithubError && (e.kind === "auth" || e.kind === "scope")) {
      if (e.kind === "auth") await markConnection(creds.connection_id, { status: "revoked", last_error: e.message, last_checked_at: new Date().toISOString() });
      return await keep("LumiLink's access to the repository was revoked.");
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error(`seo-publish github rollback ${action.id}: ${message}`);
    await supabase.from("seo_actions").update({ status: "rollback_requested", error: message }).eq("id", action.id);
    return "retry";
  }
}

async function runPublish(locationId: string, clientId: string): Promise<Record<string, unknown>> {
  const { data: actions, error } = await supabase
    .from("seo_actions")
    .select("id, client_id, location_id, finding_id, action_type, status, target_field, target_url, apply_mode, proposed_value, resource_ref, publish_result, approved_at, updated_at")
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
    // Module 4: profile edits go to Google, whatever the website runs on.
    if (a.action_type === "gbp_field_update") {
      const o = isRollback ? await rollbackGbpOne(a) : await publishGbpOne(a);
      tally[o as keyof typeof tally]++;
      continue;
    }
    const outcome = isGithub(creds)
      ? isRollback
        ? await rollbackGithub(a, creds!)
        : a.action_type === "content_publish"
          ? await publishArticleGithub(a, creds!)
          : await publishOverrideGithub(a, creds!)
      : isRollback
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
