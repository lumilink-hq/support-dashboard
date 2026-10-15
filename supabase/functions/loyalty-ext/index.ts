// =============================================================================
// loyalty-ext — backend for LL Loyalty's UI extensions (0212, module 11):
// the thank-you block, the order status block and the account profile block.
//
//   GET /loyalty-ext?order=<order GID>    header Authorization: Bearer <session token>
//
// AUTH: the Shopify session token (HS256, the app's client secret), checked
// against the app named by its aud. The shop is the token's dest and the
// customer its sub, never a request parameter. A token without sub is a
// guest checkout: program rules only, no member data. ?order is only used to
// return that order's points when it belongs to the token's customer.
//
// Extensions run on Shopify's CDN origin, so this answers CORS preflights.
// Shopify sends no Supabase JWT: deploy with --no-verify-jwt.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { parseAppCredentials } from "../shopify-oauth/lib.ts";
import { bearer, CORS, gidId, peekClaims, verifySessionToken } from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const token = bearer(req.headers.get("authorization"));
  const peek = token ? peekClaims(token) : null;
  if (!token || !peek) return json({ error: "unauthorized" }, 401);

  let app: { program_id: string; credentials: string | null } | undefined;
  try {
    const apps = await rpc<{ app_client_id: string; program_id: string; credentials: string | null }[]>(
      "get_loyalty_shopify_apps", { p_shop: peek.shop });
    app = apps.find((a) => a.app_client_id === peek.aud);
  } catch (e) {
    console.error(`loyalty-ext: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "unavailable" }, 503);
  }
  const secret = parseAppCredentials(app?.credentials ?? null)?.clientSecret ?? "";
  const auth = await verifySessionToken(token, peek.aud, secret, Math.floor(Date.now() / 1000));
  if (!app || !auth.ok) return json({ error: "unauthorized" }, 401);

  try {
    const programId = await rpc<string | null>("loyalty_program_for_shop", { p_shop: auth.shop });
    if (!programId || programId !== app.program_id) return json({ error: "no_program" }, 404);
    const orderId = gidId(new URL(req.url).searchParams.get("order"), "Order");
    const state = await rpc<unknown>("loyalty_extension_state", {
      p_program: programId, p_customer_id: auth.customerId, p_order_id: orderId,
    });
    return json(state);
  } catch (e) {
    console.error(`loyalty-ext ${auth.shop}: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "server_error" }, 500);
  }
});
