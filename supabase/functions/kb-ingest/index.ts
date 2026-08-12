// =============================================================================
// kb-ingest — turns kb_documents rows into embedded, retrievable chunks.
//
// Drains documents at status='pending', exactly like provision-feature drains
// provisioning_tasks. Same reasons: work that touches the network needs
// retries, visible failures and one place to kick.
//
//   pending  -> fetch (if source_type='url') -> chunk -> embed -> ready
//                                                            \-> failed + last_error
//
// EMBEDDINGS ARE LOCAL. `Supabase.ai.Session('gte-small')` runs inside this
// Edge Function: no API key, no per-embedding bill, and no client content
// leaving the project. 384 dimensions, matching kb_chunks.embedding after 0033.
//
// A document sitting at 'pending' is INVISIBLE to the agent — match_kb filters
// on status='ready' — so a stalled queue is a silently empty knowledge base.
// That is the failure worth watching for; §Verify in the docs has the query.
//
//   POST /kb-ingest                    drain the queue
//   POST /kb-ingest {"document_id":…}  re-ingest one document, any status
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      KB_CRAWL_ENABLED ('1' default), KB_USER_AGENT (optional).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  CRAWL_PAGE_LIMIT,
  chunkText,
  contentHash,
  discoverLinks,
  extractTitle,
  hasUsableText,
  htmlToText,
  isAllowedByRobots,
  normalizeUrl,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const CRAWL_ENABLED = (Deno.env.get("KB_CRAWL_ENABLED") ?? "1") === "1";

// Identify ourselves honestly. We are fetching someone else's server on a
// schedule; a contactable user-agent is what makes that a courtesy rather than
// an intrusion, and it is what robots.txt rules can then name.
const USER_AGENT =
  Deno.env.get("KB_USER_AGENT") ??
  "LumilinkBot/1.0 (+https://lumilink.ai/bot; knowledge sync for our customer's own site)";

// How many documents to process per invocation. Embedding is CPU-bound inside
// the isolate, so a large batch risks the wall-clock limit and leaves documents
// half-processed. Small batches plus a repeating trigger drain just as fast.
const BATCH_SIZE = 5;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_DOC_CHARS = 400_000; // ~200 chunks; past this a page is a data dump

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---- Embeddings -------------------------------------------------------------

// One session reused across the whole invocation. Constructing it per chunk
// reloads the model and turns a fast batch into a timeout.
let session: { run: (input: string, opts: Record<string, unknown>) => Promise<number[]> } | null =
  null;

function embedder() {
  if (!session) {
    // deno-lint-ignore no-explicit-any
    const AI = (globalThis as any).Supabase?.ai;
    if (!AI) {
      throw new Error(
        "Supabase.ai unavailable. Embeddings run in the Edge Runtime; deploy this " +
          "function rather than running it under plain Deno.",
      );
    }
    session = new AI.Session("gte-small");
  }
  return session!;
}

async function embed(text: string): Promise<number[]> {
  // mean_pool + normalize is what makes the output a unit vector suitable for
  // cosine distance. Without normalize, `<=>` still returns an ordering but the
  // similarity numbers stop being comparable to a threshold, so
  // match_kb's p_min_similarity would silently mean nothing.
  const out = await embedder().run(text, { mean_pool: true, normalize: true });
  const vec = out as unknown as number[];
  if (!Array.isArray(vec) || vec.length !== 384) {
    throw new Error(`expected a 384-dim embedding, got ${Array.isArray(vec) ? vec.length : typeof vec}`);
  }
  return vec;
}

// ---- Fetching ---------------------------------------------------------------

type Fetched = { url: string; html: string };

async function fetchPage(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    // Only parse HTML. A PDF or an image fetched by accident would otherwise be
    // decoded as mojibake and embedded as though it were prose.
    const ctype = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(ctype)) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRobots(origin: string): Promise<string | null> {
  try {
    const res = await fetch(new URL("/robots.txt", origin).toString(), {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Fetch the document's URL and, when crawling is on, up to CRAWL_PAGE_LIMIT-1
 * same-domain pages linked from it.
 *
 * ONE LEVEL DEEP, and that is a product decision rather than a shortcut. Depth
 * two on a small business site reaches the blog archive and every paginated
 * category, which does not make the agent better informed — it buries the
 * returns policy under two hundred chunks of blog prose and makes retrieval
 * worse. Twenty relevant pages beats two hundred pages of mostly noise.
 */
async function fetchSite(startUrl: string): Promise<Fetched[]> {
  const origin = new URL(startUrl).origin;
  const robots = await fetchRobots(origin);

  const allowed = (u: string) => {
    try {
      return isAllowedByRobots(robots, new URL(u).pathname, "lumilinkbot");
    } catch {
      return false;
    }
  };

  if (!allowed(startUrl)) {
    throw new Error(`robots.txt on ${origin} disallows ${startUrl}`);
  }

  const rootHtml = await fetchPage(startUrl);
  if (rootHtml === null) throw new Error(`could not fetch ${startUrl}`);

  const pages: Fetched[] = [{ url: startUrl, html: rootHtml }];
  if (!CRAWL_ENABLED) return pages;

  const links = discoverLinks(rootHtml, startUrl, CRAWL_PAGE_LIMIT * 2)
    .filter(allowed)
    .slice(0, CRAWL_PAGE_LIMIT - 1);

  for (const link of links) {
    // Sequential, with a small gap. Concurrent requests to a small business's
    // shared host is how a knowledge sync becomes an outage they blame on us.
    await new Promise((r) => setTimeout(r, 250));
    const html = await fetchPage(link);
    if (html !== null) pages.push({ url: link, html });
  }

  return pages;
}

// ---- Ingestion --------------------------------------------------------------

type DocRow = {
  id: string;
  client_id: string;
  title: string;
  source_type: string;
  source_uri: string | null;
  content: string;
  content_hash: string | null;
};

async function markFailed(id: string, reason: string): Promise<void> {
  await supabase
    .from("kb_documents")
    .update({ status: "failed", last_error: reason.slice(0, 500) })
    .eq("id", id);
}

/** Replace a document's chunks with freshly embedded ones. */
async function writeChunks(doc: DocRow, text: string): Promise<number> {
  const chunks = chunkText(text);
  if (chunks.length === 0) throw new Error("no text to index after chunking");

  // Delete-then-insert rather than upsert on (document_id, chunk_index).
  // A re-sync of a SHORTER page leaves orphaned high-index chunks behind under
  // upsert — stale content that still retrieves, which is worse than no content
  // because it is confidently wrong and nothing points at it.
  const { error: delErr } = await supabase
    .from("kb_chunks")
    .delete()
    .eq("document_id", doc.id);
  if (delErr) throw new Error(`clearing old chunks: ${delErr.message}`);

  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < chunks.length; i++) {
    rows.push({
      client_id: doc.client_id,
      document_id: doc.id,
      chunk_index: i,
      content: chunks[i],
      embedding: await embed(chunks[i]),
      token_count: Math.ceil(chunks[i].length / 4),
    });
  }

  const { error: insErr } = await supabase.from("kb_chunks").insert(rows);
  if (insErr) throw new Error(`inserting chunks: ${insErr.message}`);

  return rows.length;
}

async function ingestDocument(doc: DocRow): Promise<{ chunks: number; skipped: boolean }> {
  let text = doc.content ?? "";
  let title = doc.title;

  if (doc.source_type === "url") {
    if (!doc.source_uri) throw new Error("source_type is 'url' but source_uri is null");

    const pages = await fetchSite(normalizeUrl(doc.source_uri));

    const parts: string[] = [];
    for (const page of pages) {
      const pageText = htmlToText(page.html);
      if (!hasUsableText(pageText)) continue;
      // Label each page so a retrieved chunk can be traced back, and so the
      // embedding carries a little context about where it came from.
      parts.push(`## ${extractTitle(page.html, page.url)}\n${pageText}`);
    }

    if (parts.length === 0) {
      // Almost always a client-rendered site: a plain fetch gets the shell and
      // none of the copy. Say so, because "0 chunks" alone sends whoever reads
      // it looking for a bug in the chunker.
      throw new Error(
        `fetched ${pages.length} page(s) but found no readable text. The site is ` +
          `probably JavaScript-rendered; paste the key pages in as text instead.`,
      );
    }

    text = parts.join("\n\n").slice(0, MAX_DOC_CHARS);
    title = extractTitle(pages[0].html, pages[0].url);
  }

  if (!text.trim()) throw new Error("document has no content");

  // Unchanged since the last successful sync: skip the embedding work entirely.
  // This is what makes a nightly re-sync nearly free instead of re-embedding
  // every client's whole site every night.
  const hash = contentHash(text);
  if (doc.content_hash && doc.content_hash === hash) {
    await supabase
      .from("kb_documents")
      .update({ status: "ready", last_error: null, synced_at: new Date().toISOString() })
      .eq("id", doc.id);
    return { chunks: 0, skipped: true };
  }

  const count = await writeChunks(doc, text);

  const { error } = await supabase
    .from("kb_documents")
    .update({
      status: "ready",
      title,
      content: text,
      content_hash: hash,
      chunk_count: count,
      last_error: null,
      synced_at: new Date().toISOString(),
    })
    .eq("id", doc.id);
  if (error) throw new Error(`finalising document: ${error.message}`);

  return { chunks: count, skipped: false };
}

// ---- Queue drain ------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown> = {};
  try {
    body = ((await req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    // An empty body is the normal cron case.
  }

  const single = typeof body.document_id === "string" ? body.document_id : null;

  const query = supabase
    .from("kb_documents")
    .select("id, client_id, title, source_type, source_uri, content, content_hash");

  const { data: docs, error } = single
    ? await query.eq("id", single).limit(1)
    : await query.eq("status", "pending").order("created_at", { ascending: true }).limit(BATCH_SIZE);

  if (error) return json({ error: error.message }, 500);

  const results: Record<string, unknown>[] = [];

  for (const doc of (docs ?? []) as DocRow[]) {
    try {
      const { chunks, skipped } = await ingestDocument(doc);
      results.push({ id: doc.id, ok: true, chunks, skipped });
    } catch (e) {
      const reason = e instanceof Error ? e.message : "ingestion failed";
      // Never log the fetched page body — it is a customer's content and can
      // contain anything. The URL and the reason are enough to act on.
      console.error(`kb-ingest ${doc.id} (${doc.source_uri ?? doc.source_type}): ${reason}`);
      await markFailed(doc.id, reason);
      results.push({ id: doc.id, ok: false, error: reason });
    }
  }

  return json({ ok: true, processed: results.length, results });
});
