// =============================================================================
// google-token-refresh — module 2 (plan.md): refresh one client's cached
// Google access token from its Vault-stored refresh token.
//
// Called by run_due_google_token_refreshes() (0046) via pg_cron -> pg_net,
// one client per invocation — same per-client isolation rationale as
// product-sync (0023): one client's revoked/dead grant must not block
// another's refresh, and an edge function has a wall-clock limit a single
// function looping every tenant would eventually hit.
//
//   POST /google-token-refresh
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>   (same shared admin
//           secret product-sync/voice-call-logger already use — not a new one)
//   body:   { "client_id": "<uuid>" }
//
// Admin endpoint: the shared secret is the whole gate, same posture as
// product-sync. Never accepts a caller-supplied client from an
// unauthenticated request.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const GOOGLE_OAUTH_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
const GOOGLE_OAUTH_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) {
  throw new Error("SUPABASE_SECRET_KEYS['default'] (service role) not found.");
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    console.error("GOOGLE_OAUTH_CLIENT_ID/SECRET unset — refusing to run");
    return json({ error: "Server not configured" }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const clientId = String(body.client_id ?? "").trim();
  if (!clientId) return json({ error: "client_id is required" }, 400);

  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: refreshToken, error: rtError } = await supabase.rpc(
    "get_google_refresh_token",
    { p_client_id: clientId },
  );
  if (rtError) {
    console.error(`get_google_refresh_token failed for ${clientId}:`, rtError.message);
    return json({ error: rtError.message }, 500);
  }
  if (!refreshToken) {
    // Nothing to refresh — the connect flow never completed, or disconnect
    // already ran. Not an error the scheduler needs to see as a failure, and
    // there's no job_attempts row worth completing (start_job_attempt, 0048,
    // is called by the DISPATCHER before this function ever runs — a
    // disconnect between dispatch and execution is rare but not a bug).
    return json({ status: "no_connection", client_id: clientId });
  }

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken as string,
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  const tokenBody = await tokenRes.json();

  if (!tokenRes.ok) {
    // invalid_grant is Google's own signal that the grant is dead (revoked
    // from the user's Google Account, or otherwise no longer valid) — module
    // 2's "handling for revoked access". Anything else is treated as
    // transient and retried with exponential backoff (0048's
    // complete_job_attempt), not every 15-minute tick.
    const revoked = tokenBody.error === "invalid_grant";
    const message = `${tokenBody.error ?? tokenRes.status} ${tokenBody.error_description ?? ""}`.trim();
    const { error: markError } = await supabase.rpc("mark_google_oauth_error", {
      p_client_id: clientId,
      p_error: message,
      p_revoked: revoked,
    });
    if (markError) console.error(`mark_google_oauth_error failed for ${clientId}:`, markError.message);

    // A revoked grant isn't a transient failure to back off and retry — it's
    // over until the client reconnects, which run_due_google_token_refreshes
    // already stops offering (google_oauth_connections.status <> 'revoked').
    // Recording it as a job_attempts "success" (no backoff growth) reflects
    // that correctly; recording it as a repeated failure would just grow an
    // attempt count nothing will ever consult again.
    const { error: jobError } = await supabase.rpc("complete_job_attempt", {
      p_client_id: clientId,
      p_job_type: "google_token_refresh",
      p_success: revoked,
      p_error: revoked ? null : message,
    });
    if (jobError) console.error(`complete_job_attempt failed for ${clientId}:`, jobError.message);

    return json({ status: revoked ? "revoked" : "error", client_id: clientId, error: message });
  }

  const expiresAt = new Date(Date.now() + tokenBody.expires_in * 1000).toISOString();
  const { error: updateError } = await supabase.rpc("update_google_access_token", {
    p_client_id: clientId,
    p_access_token: tokenBody.access_token,
    p_expires_at: expiresAt,
  });
  if (updateError) {
    console.error(`update_google_access_token failed for ${clientId}:`, updateError.message);
    await supabase.rpc("complete_job_attempt", {
      p_client_id: clientId,
      p_job_type: "google_token_refresh",
      p_success: false,
      p_error: updateError.message,
    });
    return json({ error: updateError.message }, 500);
  }

  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: clientId,
    p_job_type: "google_token_refresh",
    p_success: true,
  });
  if (jobError) console.error(`complete_job_attempt failed for ${clientId}:`, jobError.message);

  return json({ status: "refreshed", client_id: clientId, expires_at: expiresAt });
});
