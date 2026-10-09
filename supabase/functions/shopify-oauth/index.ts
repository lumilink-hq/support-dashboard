// =============================================================================
// shopify-oauth — "Connect Shopify" (0077): the authorization code grant for a
// client's custom-distribution LumiLink app, ending with the store's offline
// token in Vault and every one of the client's locations pointed at it.
//
//   GET /shopify-oauth?shop=<x>.myshopify.com[&hmac=&timestamp=&host=]
//       Start. Reached from the portal's Connect Shopify button, or from
//       Shopify itself (the app's install link sends the store here as the
//       App URL, signed with hmac, which is then verified).
//   GET /shopify-oauth/callback?code=&shop=&state=&hmac=&timestamp=
//       Shopify's redirect after the owner approves. state must match the
//       cookie set at the start, hmac must be Shopify's signature with the
//       app's secret, then the code is exchanged for the offline token.
//
// PUBLIC BY DESIGN: browsers hit it, so it MUST be deployed with
// --no-verify-jwt and has no x-voice-tool-secret. It is safe because it only
// acts for a shop an operator registered in seo_shopify_apps, every Shopify
// request is HMAC-checked, and the token always goes to that shop's own
// client, never to whoever clicked.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role);
//      SHOPIFY_OAUTH_URL (optional; this function's public URL, default
//      `${SUPABASE_URL}/functions/v1/shopify-oauth`, which is right when
//      hosted); SEO_PORTAL_URL (optional, default https://www.lumilinkhub.com);
//      SHOPIFY_SHOP_BASE (optional, test only: the token exchange goes to
//      `${SHOPIFY_SHOP_BASE}/<shop>/admin/oauth/access_token` so a local run
//      can point at a mock store).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { authorizeUrl, parseAppCredentials, parseTokenResponse, portalUrl, readCookie, validShop, verifyHmac } from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const SELF_URL = (Deno.env.get("SHOPIFY_OAUTH_URL") ?? `${SUPABASE_URL}/functions/v1/shopify-oauth`).replace(/\/+$/, "");
const PORTAL = (Deno.env.get("SEO_PORTAL_URL") ?? "https://www.lumilinkhub.com").replace(/\/+$/, "");
const STATE_COOKIE = "lumilink_shopify_state";
const SHOP_BASE = (Deno.env.get("SHOPIFY_SHOP_BASE") ?? "").replace(/\/+$/, "");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type App = { shop: string; clientId: string; clientSecret: string; scopes: string };

async function loadApp(shop: string): Promise<App | null> {
  const { data, error } = await supabase.rpc("get_seo_shopify_app", { p_shop: shop });
  if (error) throw new Error(`loading the app failed: ${error.message}`);
  const row = data as { shop_domain: string; scopes: string; credentials: string | null } | null;
  if (!row) return null;
  const creds = parseAppCredentials(row.credentials);
  if (!creds) throw new Error(`the Vault secret for ${shop} is missing or isn't JSON with client_id and client_secret`);
  return { shop: row.shop_domain, clientId: creds.clientId, clientSecret: creds.clientSecret, scopes: row.scopes };
}

function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store", ...extraHeaders } });
}

function back(outcome: { notice?: string; error?: string }, clearCookie = false): Response {
  return redirect(
    portalUrl(PORTAL, outcome),
    clearCookie ? { "Set-Cookie": `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } : {},
  );
}

async function start(params: URLSearchParams): Promise<Response> {
  const shop = validShop(params.get("shop"));
  if (!shop) return back({ error: "That isn't a Shopify store address (it should end in .myshopify.com)." });
  const app = await loadApp(shop);
  if (!app) return back({ error: `${shop} isn't set up for Connect Shopify yet. Ask LumiLink to register it.` });

  // Arriving from Shopify (install link / admin): it must be Shopify's signature.
  if (params.has("hmac") && !(await verifyHmac(params, app.clientSecret))) {
    return back({ error: "Shopify's signature didn't check out. Start again from LumiLink." });
  }

  const state = crypto.randomUUID().replace(/-/g, "");
  const url = authorizeUrl({ shop, clientId: app.clientId, scopes: app.scopes, redirectUri: `${SELF_URL}/callback`, state });
  return redirect(url, { "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax` });
}

async function callback(req: Request, params: URLSearchParams): Promise<Response> {
  const shop = validShop(params.get("shop"));
  const code = params.get("code");
  const state = params.get("state");
  const cookieState = readCookie(req.headers.get("cookie"), STATE_COOKIE);
  if (params.get("error")) return back({ error: "Shopify connection was cancelled." }, true);
  if (!shop || !code || !state || !cookieState || state !== cookieState) {
    return back({ error: "That Shopify connection link expired or was invalid. Try again." }, true);
  }
  const app = await loadApp(shop);
  if (!app) return back({ error: `${shop} isn't set up for Connect Shopify yet.` }, true);
  if (!(await verifyHmac(params, app.clientSecret))) {
    return back({ error: "Shopify's signature didn't check out. Try again." }, true);
  }

  let res: Response;
  try {
    res = await fetch(SHOP_BASE ? `${SHOP_BASE}/${shop}/admin/oauth/access_token` : `https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, code }),
    });
  } catch (e) {
    await supabase.rpc("mark_seo_shopify_error", { p_shop: shop, p_error: `token exchange failed: ${String(e)}` });
    return back({ error: "Couldn't reach Shopify to finish connecting. Try again." }, true);
  }
  const result = parseTokenResponse(res.status, await res.text());
  if (!result.ok) {
    console.error(`shopify-oauth ${shop}: ${result.error}`);
    await supabase.rpc("mark_seo_shopify_error", { p_shop: shop, p_error: result.error });
    return back({ error: `Shopify refused the connection (${result.error}).` }, true);
  }

  const { data: count, error } = await supabase.rpc("store_seo_shopify_token", {
    p_shop: shop,
    p_access_token: result.token,
    p_scopes: result.scopes,
  });
  if (error) {
    console.error(`shopify-oauth ${shop}: storing the token failed: ${error.message}`);
    return back({ error: "Connected to Shopify, but saving the connection failed. Try again." }, true);
  }
  // Check the new connections now rather than at the next 5-minute tick.
  const { error: runErr } = await supabase.rpc("run_due_seo_site_jobs");
  if (runErr) console.warn(`shopify-oauth ${shop}: run_due_seo_site_jobs failed: ${runErr.message}`);

  console.log(`shopify-oauth ${shop}: connected, ${count} location(s), scopes ${result.scopes.join(",")}`);
  return back({ notice: `Shopify connected (${shop}). The connection check runs within a few minutes.` }, true);
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  try {
    if (url.pathname.endsWith("/callback")) return await callback(req, url.searchParams);
    return await start(url.searchParams);
  } catch (e) {
    console.error(`shopify-oauth: ${e instanceof Error ? e.message : String(e)}`);
    return back({ error: "Something went wrong connecting Shopify. Try again." }, true);
  }
});
