// =============================================================================
// voice-kb-search — the `search_knowledge` agent tool.
//
// Answers "do you offer financing", "what's your warranty", "can I bring my dog"
// from the client's own knowledge base instead of from the model's priors. This
// is the difference between an agent that says "let me take a message" to every
// general question and one that sounds like it works there.
//
// Routing mirrors voice-product-lookup: phone resolves by DIALED NUMBER, web by
// client slug behind the same opt-in.
//
// THE TENANT IS NEVER TAKEN FROM THE MODEL. client_id comes from the dialed
// number, resolved server-side. The agent supplies only the question. This is
// the whole reason the KB lives in Postgres rather than in the shared
// ElevenLabs agent: one agent serves every client, so a knowledge base attached
// to it would be attached to all of them.
//
//   POST /voice-kb-search
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { called_number, client_ref, question, call_sid, conversation_id }
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, KB_MIN_SIMILARITY (optional).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("SUPABASE_SECRET_KEYS['default'] (service role) not found.");

// Three passages is about as much as can be turned into a spoken answer. More
// context does not make the reply better; it makes it longer, and on a phone
// call length is the thing the caller actually notices.
const MAX_PASSAGES = 3;

// Cosine similarity floor. Below this the "best" match is usually an unrelated
// paragraph that happens to share vocabulary — and handing that to the model is
// how an agent invents a policy in the client's name. Returning nothing is a
// better outcome than returning something plausible and wrong.
const MIN_SIMILARITY = Number(Deno.env.get("KB_MIN_SIMILARITY") ?? 0.62);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let session: { run: (input: string, opts: Record<string, unknown>) => Promise<number[]> } | null = null;

function embedder() {
  if (!session) {
    // deno-lint-ignore no-explicit-any
    const AI = (globalThis as any).Supabase?.ai;
    if (!AI) throw new Error("Supabase.ai unavailable in this runtime");
    session = new AI.Session("gte-small");
  }
  return session!;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", Connection: "keep-alive" },
  });
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

type KbResponse = {
  found: boolean;
  /** What the agent should say, or the instruction to fall back. */
  message: string;
  passages?: { content: string; title: string; similarity: number }[];
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (VOICE_TOOL_SECRET) {
    if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
      return json({ error: "Unauthorized" }, 401);
    }
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const calledNumber = str(body.called_number);
  const clientSlug = str(body.client_ref) ?? str(body.client_slug);
  const question = str(body.question) ?? str(body.query);

  if (!calledNumber && !clientSlug) {
    return json({ error: "Missing called_number or client_ref" }, 400);
  }
  if (!question) {
    return json({ found: false, message: "No question was provided." } satisfies KbResponse);
  }

  // 1) Resolve the tenant. Server-side, from the line that was dialed.
  let clientId: string | null = null;
  if (calledNumber) {
    const { data, error } = await supabase.rpc("resolve_client_by_number", {
      p_called_number: calledNumber,
    });
    if (error) return json({ error: error.message }, 400);
    clientId = (data as string | null) ?? null;
  } else {
    const { data: row, error } = await supabase
      .from("clients")
      .select("id, is_active, settings")
      .eq("slug", clientSlug)
      .maybeSingle();
    if (error) return json({ error: error.message }, 400);
    if (row && row.is_active !== false) {
      const settings = (row.settings ?? {}) as Record<string, unknown>;
      // Same opt-in gate the other web-reachable tools use. A slug is public
      // page HTML, so it identifies but never authorises.
      if (settings.web_lookup_enabled === true || settings.is_demo === true) {
        clientId = row.id as string;
      }
    }
  }

  if (!clientId) {
    return json({
      found: false,
      message: "This line isn't set up for knowledge lookups.",
    } satisfies KbResponse);
  }

  // 2) Embed the question with the same model that embedded the corpus.
  //    Mixing models silently produces vectors from different spaces: the
  //    distances still compute, the ordering is meaningless, and the agent
  //    confidently reads out an unrelated paragraph.
  let queryEmbedding: number[];
  try {
    queryEmbedding = (await embedder().run(question, {
      mean_pool: true,
      normalize: true,
    })) as unknown as number[];
  } catch (e) {
    console.error("kb embed failed:", e instanceof Error ? e.message : String(e));
    return json({
      found: false,
      message: "Knowledge lookup is temporarily unavailable.",
    } satisfies KbResponse);
  }

  // 3) Retrieve. match_kb is service-role only and filters to this client.
  const { data, error } = await supabase.rpc("match_kb", {
    p_client_id: clientId,
    p_query_embedding: queryEmbedding,
    p_match_count: MAX_PASSAGES,
    p_min_similarity: MIN_SIMILARITY,
  });

  if (error) {
    console.error("match_kb failed:", error.message);
    return json({
      found: false,
      message: "Knowledge lookup is temporarily unavailable.",
    } satisfies KbResponse);
  }

  const rows = (data ?? []) as {
    content: string;
    title: string;
    similarity: number;
  }[];

  if (rows.length === 0) {
    // THE IMPORTANT BRANCH. The message is phrased as an instruction to the
    // agent, not as words to read out, because the agent's next move matters
    // more than its next sentence: with nothing retrieved it must offer to take
    // a message rather than answer from general knowledge. An empty result that
    // simply said "not found" invites the model to fill the gap itself, in the
    // client's name, to their customer.
    return json({
      found: false,
      message:
        "Nothing in this business's knowledge base covers that. Do not answer " +
        "from general knowledge. Tell the caller you'll check with the team and " +
        "offer to take a message.",
    } satisfies KbResponse);
  }

  return json({
    found: true,
    message:
      "Answer using only the passages below. If they don't fully cover the " +
      "question, say what you do know and offer to have someone follow up.",
    passages: rows.map((r) => ({
      title: r.title,
      content: r.content,
      similarity: Math.round(r.similarity * 100) / 100,
    })),
  } satisfies KbResponse);
});
