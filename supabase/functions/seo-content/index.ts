// =============================================================================
// seo-content — module 16 (plan.md): weekly, per client, choose topics from the
// ranking gap, draft an article and an image, and queue them for approval.
//
//   POST /seo-content
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "client_id": "<uuid>" }
//
// Admin endpoint, same posture as seo-crawl: the shared secret is the whole gate,
// dispatched by request_seo_content (0056) via pg_cron -> pg_net.
//
// RULE 1: this only writes a DRAFT (seo_actions, action_type 'content_publish',
//   status pending_approval). Publishing is seo-publish's job, after a human
//   approves. RULE 3: previous_value and an idempotency key are stored. RULE 5:
//   see lib.ts. RULE 6: the Anthropic SDK retries with exponential backoff;
//   replicate.ts does its own; both reserve against vendor_budgets per call.
//
// COST BOUND. At most the week's cadence (default 2, clamped 1-3) articles, and
// none at all while 4 are already waiting for a human, so an unattended queue
// can't grow. At most 3x that many candidates are tried per run (a validator
// rejection costs a model call), and a run that drafts nothing retries the next
// day, not the next hour.
//
// WHAT RUNS WHERE. gte-small embeddings run INSIDE the Edge Runtime
// (Supabase.ai), like kb-ingest: no key, no bill, nothing leaves the project.
// That means this function cannot be run under plain Deno; deploy it.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, ANTHROPIC_API_KEY, REPLICATE_API_TOKEN (optional: without
//      it articles are drafted with no image), SEO_CONTENT_MODEL (optional),
//      SEO_CONTENT_ARTICLES_PER_WEEK (optional, 1-3).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import Anthropic from "npm:@anthropic-ai/sdk@0.127.0";
import {
  articlesThisRun,
  buildArticlePayload,
  buildImagePrompt,
  checkUniqueness,
  dropCannibalizing,
  idempotencyKey,
  normalizeKeyword,
  parseArticleOutput,
  pickCandidates,
  SYSTEM_PROMPT,
  validateArticle,
  type GapRow,
  type PriorPost,
} from "./lib.ts";
import { downloadImage, extensionFor, generateImage, ReplicateError, type ImageTier } from "./replicate.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const REPLICATE_API_TOKEN = Deno.env.get("REPLICATE_API_TOKEN");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const MODEL = Deno.env.get("SEO_CONTENT_MODEL") ?? "claude-sonnet-5"; // Sonnet-class for drafts, plan.md
const PER_WEEK = Number(Deno.env.get("SEO_CONTENT_ARTICLES_PER_WEEK") ?? "");
const MAX_BACKLOG = 4;
const ATTEMPT_MULTIPLIER = 3;
const IMAGE_TIER: ImageTier = "standard";
const BUCKET = "seo-content-images";
const BUDGET_RETRY_MS = 2_000;
const BUDGET_MAX_TRIES = 30;
const BASE_INTERVAL_MINUTES = 7 * 24 * 60;
const RETRY_INTERVAL_MINUTES = 24 * 60;
const MAX_BACKOFF_MINUTES = 24 * 60;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: 4 }) : null;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

async function reserveBudget(vendor: "anthropic" | "replicate"): Promise<void> {
  for (let i = 0; i < BUDGET_MAX_TRIES; i++) {
    const { data: allowed, error } = await supabase.rpc("check_and_reserve_vendor_budget", { p_vendor: vendor });
    if (error) throw new Error(`vendor budget check failed: ${error.message}`);
    if (allowed) return;
    await sleep(BUDGET_RETRY_MS);
  }
  throw new Error(`${vendor} vendor budget stayed exhausted`);
}

// ---- Embeddings (gte-small, in the Edge Runtime) ----------------------------

let session: { run: (input: string, opts: Record<string, unknown>) => Promise<number[]> } | null = null;

async function embed(text: string): Promise<number[]> {
  if (!session) {
    // deno-lint-ignore no-explicit-any
    const AI = (globalThis as any).Supabase?.ai;
    if (!AI) throw new Error("Supabase.ai unavailable: deploy this function; it can't run under plain Deno");
    session = new AI.Session("gte-small");
  }
  // mean_pool + normalize: unit vectors, so cosine thresholds mean something.
  const vec = (await session!.run(text, { mean_pool: true, normalize: true })) as unknown as number[];
  if (!Array.isArray(vec) || vec.length !== 384) throw new Error(`expected a 384-dim embedding, got ${Array.isArray(vec) ? vec.length : typeof vec}`);
  return vec;
}

/** PostgREST returns a pgvector column as the text "[0.1,0.2,...]". */
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

// ---- The model --------------------------------------------------------------

async function writeArticle(payload: string): Promise<string> {
  await reserveBudget("anthropic");
  const res = await anthropic!.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: payload }],
  });
  if (res.stop_reason === "refusal") throw new Error("model refused");
  if (res.stop_reason === "max_tokens") throw new Error("model output was cut off");
  const block = res.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : "";
}

// ---- The image --------------------------------------------------------------

type ImageResult = { image: { url: string; alt: string; path: string; model: string; tier: string; brief: string } | null; image_error: string | null };

async function makeImage(clientId: string, brief: string, alt: string): Promise<ImageResult> {
  if (!REPLICATE_API_TOKEN) return { image: null, image_error: "REPLICATE_API_TOKEN is not set, so no image was generated" };
  const ctx = { token: REPLICATE_API_TOKEN, fetch, sleep };
  try {
    await reserveBudget("replicate");
    const { url, model } = await generateImage(ctx, IMAGE_TIER, buildImagePrompt(brief));
    // Copy it out at once: the Replicate URL is not stored and may not last.
    const { bytes, contentType } = await downloadImage(ctx, url);
    const path = `${clientId}/${crypto.randomUUID()}.${extensionFor(contentType)}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: false });
    if (error) return { image: null, image_error: `the image was generated but could not be stored: ${error.message}` };
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return { image: { url: data.publicUrl, alt, path, model, tier: IMAGE_TIER, brief }, image_error: null };
  } catch (e) {
    // An image is optional: the article stands without one, and the reviewer is
    // told why. A safety refusal is not retried with the same prompt.
    const kind = e instanceof ReplicateError ? e.kind : "error";
    return { image: null, image_error: `no image (${kind}): ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }
}

// ---- The run ----------------------------------------------------------------

type Loc = { id: string; name: string | null; city: string | null; region: string | null; primary_category: string | null };
type PostRow = { id: string; location_id: string; topic_key: string; title: string; body_text: string; topic_embedding: unknown; content_embedding: unknown };

async function settle(clientId: string, success: boolean, error: string | null, interval: number) {
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: clientId,
    p_job_type: "seo_content",
    p_success: success,
    p_error: error,
    p_base_interval_minutes: interval,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: null,
  });
  if (jobError) console.error(`seo-content ${clientId}: complete_job_attempt failed: ${jobError.message}`);
}

async function runClient(clientId: string): Promise<Record<string, unknown>> {
  const { data: locRows, error: lErr } = await supabase
    .from("seo_locations")
    .select("id, name, city, region, primary_category")
    .eq("client_id", clientId)
    .eq("is_active", true)
    .not("website_url", "is", null);
  if (lErr) throw new Error(`loading locations failed: ${lErr.message}`);
  const locations = new Map((locRows as Loc[]).map((l) => [l.id, l]));

  const { count: backlog, error: bErr } = await supabase
    .from("seo_actions")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .eq("action_type", "content_publish")
    .in("status", ["pending_approval", "approved", "publishing", "manual_required"]);
  if (bErr) throw new Error(`counting the backlog failed: ${bErr.message}`);

  const want = articlesThisRun(Number.isFinite(PER_WEEK) && PER_WEEK > 0 ? PER_WEEK : undefined, backlog ?? 0, MAX_BACKLOG);
  if (want === 0) {
    await settle(clientId, true, null, BASE_INTERVAL_MINUTES);
    return { status: "backlog_full", backlog };
  }
  if (!anthropic) throw new Error("ANTHROPIC_API_KEY is not set");

  const { data: gapRows, error: gErr } = await supabase.from("seo_keyword_gaps").select("*").eq("client_id", clientId);
  if (gErr) throw new Error(`loading keyword gaps failed: ${gErr.message}`);

  const { data: postRows, error: pErr } = await supabase
    .from("seo_content_posts")
    .select("id, location_id, topic_key, title, body_text, topic_embedding, content_embedding")
    .eq("client_id", clientId)
    .eq("state", "active");
  if (pErr) throw new Error(`loading past posts failed: ${pErr.message}`);
  const posts = (postRows ?? []) as PostRow[];

  const activeKeys = new Set(posts.map((p) => p.topic_key));
  const postsByLocation: Record<string, number> = {};
  for (const p of posts) postsByLocation[p.location_id] = (postsByLocation[p.location_id] ?? 0) + 1;

  const picked = pickCandidates((gapRows ?? []) as GapRow[], activeKeys, postsByLocation, want * ATTEMPT_MULTIPLIER);
  if (picked.length === 0) {
    await settle(clientId, true, null, BASE_INTERVAL_MINUTES);
    return { status: "no_gap", drafted: 0 };
  }

  // Topic-level cannibalisation: near-synonyms of what any location already
  // covers (or of an earlier pick in this run) are dropped.
  const withVec = [];
  for (const g of picked) withVec.push({ g, vec: await embed(g.keyword) });
  const takenTopicVecs = posts.map((p) => parseVec(p.topic_embedding)).filter((v): v is number[] => v !== null);
  const candidates = dropCannibalizing(withVec, takenTopicVecs);

  // Every active post of the client, own location and siblings alike, for the
  // text-level check. Grows as this run adds articles.
  const priors: PriorPost[] = posts.map((p) => ({
    id: p.id,
    location_id: p.location_id,
    title: p.title,
    body_text: p.body_text,
    content_embedding: parseVec(p.content_embedding),
  }));

  const out = { drafted: 0, rejected: 0, failed: 0, skipped_topics: picked.length - candidates.length };
  const now = new Date();

  for (const { g, vec } of candidates) {
    if (out.drafted >= want) break;
    const loc = locations.get(g.location_id);
    if (!loc) continue;

    let raw: string;
    try {
      raw = await writeArticle(buildArticlePayload(loc, g.keyword));
    } catch (e) {
      console.error(`seo-content ${clientId} "${g.keyword}": model call failed: ${e instanceof Error ? e.message : e}`);
      out.failed++;
      continue;
    }

    const parsed = parseArticleOutput(raw);
    if (!parsed.ok) {
      console.log(`seo-content ${clientId} "${g.keyword}": rejected: ${parsed.reason}`);
      out.rejected++;
      continue;
    }
    const verdict = validateArticle(parsed.value, { keyword: g.keyword, city: loc.city });
    if (!verdict.ok) {
      console.log(`seo-content ${clientId} "${g.keyword}": rejected by validator: ${verdict.reason}`);
      out.rejected++;
      continue;
    }
    const { article } = verdict;

    // Embed the title, the meta description and the opening: gte-small reads 512
    // tokens and silently drops the rest, so the whole body would be a lie.
    const intro = article.text.split(/\s+/).slice(0, 250).join(" ");
    const contentVec = await embed(`${article.title}. ${article.meta_description}. ${intro}`);
    const uniqueness = checkUniqueness(article.text, contentVec, priors);
    if (!uniqueness.ok) {
      console.log(`seo-content ${clientId} "${g.keyword}": rejected, not unique: ${uniqueness.reason}`);
      out.rejected++;
      continue;
    }

    const img = await makeImage(clientId, verdict.image_brief, verdict.alt);
    const topicKey = normalizeKeyword(g.keyword);

    const proposal = {
      kind: "article",
      title: article.title,
      meta_description: article.meta_description,
      body_html: article.html,
      blocks: article.blocks,
      word_count: article.word_count,
      keyword: g.keyword,
      image: img.image,
      image_error: img.image_error,
      uniqueness,
    };

    const { data: action, error: aErr } = await supabase
      .from("seo_actions")
      .insert({
        client_id: clientId,
        location_id: g.location_id,
        action_type: "content_publish",
        target_field: "article",
        target_url: null,
        previous_value: { value: null },
        proposed_value: proposal,
        diff: { field: "article", before: null, after: article.title },
        status: "pending_approval",
        idempotency_key: idempotencyKey(clientId, topicKey, now),
        drafted_by: MODEL,
      })
      .select("id")
      .single();
    if (aErr || !action) {
      // 23505 on the idempotency key: this run's twin already drafted it.
      if (aErr?.code !== "23505") {
        console.error(`seo-content ${clientId} "${g.keyword}": inserting the draft failed: ${aErr?.message}`);
        out.failed++;
      }
      continue;
    }

    const { data: post, error: postErr } = await supabase
      .from("seo_content_posts")
      .insert({
        client_id: clientId,
        location_id: g.location_id,
        action_id: action.id,
        topic_keyword: g.keyword,
        topic_key: topicKey,
        title: article.title,
        body_text: article.text,
        topic_embedding: JSON.stringify(vec),
        content_embedding: JSON.stringify(contentVec),
        similarity: uniqueness,
      })
      .select("id")
      .single();
    if (postErr || !post) {
      // Most likely uq_seo_content_posts_topic: another run claimed this topic
      // between our read and now. Withdraw the draft rather than leave an article
      // the ledger doesn't know about (its uniqueness could never be checked).
      console.error(`seo-content ${clientId} "${g.keyword}": ledger insert failed (${postErr?.code}): ${postErr?.message}; withdrawing the draft`);
      await supabase.from("seo_actions").delete().eq("id", action.id);
      out.failed++;
      continue;
    }

    out.drafted++;
    priors.push({ id: post.id, location_id: g.location_id, title: article.title, body_text: article.text, content_embedding: contentVec });
  }

  // Nothing drafted despite candidates: try again tomorrow, not next week.
  const success = out.drafted > 0 || out.failed === 0 && out.rejected === 0;
  await settle(clientId, success, success ? null : `drafted 0 (rejected ${out.rejected}, failed ${out.failed})`, out.drafted > 0 ? BASE_INTERVAL_MINUTES : RETRY_INTERVAL_MINUTES);
  return { status: "ok", ...out };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!VOICE_TOOL_SECRET) {
    console.error("VOICE_TOOL_SECRET unset — refusing to run");
    return json({ error: "Server not configured" }, 500);
  }
  if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) return json({ error: "Unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const clientId = String(body.client_id ?? "").trim();
  if (!clientId) return json({ error: "client_id is required" }, 400);

  try {
    const result = await runClient(clientId);
    console.log(`seo-content ${clientId}: ${JSON.stringify(result)}`);
    return json({ client_id: clientId, ...result });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "failed";
    console.error(`seo-content ${clientId} unhandled: ${reason}`);
    await settle(clientId, false, reason, RETRY_INTERVAL_MINUTES);
    return json({ ok: false, error: reason }, 500);
  }
});
