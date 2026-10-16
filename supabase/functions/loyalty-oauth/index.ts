// =============================================================================
// loyalty-oauth — install for the LL Loyalty Shopify app (0201): the
// authorization code grant, ending with the store's offline token in Vault and
// the program's live period started. The token is what the backfill and the
// discount writes (module 4) use.
//
//   GET /loyalty-oauth?shop=<x>.myshopify.com[&hmac=&timestamp=&host=]
//       Start. Shopify opens this as the app's App URL after install and
//       every time the app is clicked in the admin sidebar (signed with
//       hmac). Signed opens for a store that already has its token go
//       straight to the LumiLink dashboard; otherwise the install runs. A
//       staff member can also open it with just ?shop= to reinstall.
//   GET /loyalty-oauth/callback?code=&shop=&state=&hmac=&timestamp=
//       Shopify's redirect after approval. state must match the cookie, hmac
//       must verify with the app's secret, then the code is exchanged.
//
// Several apps can serve one shop (the Phase 2 public app beside the custom
// one, plan §1), so the app is the one whose secret verifies Shopify's hmac.
// An unsigned start needs ?app=<client id> unless the shop has exactly one app.
//
// PUBLIC BY DESIGN, like shopify-oauth: deploy with --no-verify-jwt. Safe
// because it only acts for shops an operator registered in
// loyalty_shopify_apps and every Shopify request is HMAC-checked.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role);
//      LOYALTY_OAUTH_URL (optional; default `${SUPABASE_URL}/functions/v1/loyalty-oauth`);
//      LOYALTY_PORTAL_URL (optional; default https://www.lumilinkhub.com/loyalty);
//      SHOPIFY_SHOP_BASE (optional, test only: mock store for the token exchange).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { authorizeUrl, parseAppCredentials, parseTokenResponse, readCookie, validShop, verifyHmac } from "../shopify-oauth/lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const SELF_URL = (Deno.env.get("LOYALTY_OAUTH_URL") ?? `${SUPABASE_URL}/functions/v1/loyalty-oauth`).replace(/\/+$/, "");
const PORTAL_URL = (Deno.env.get("LOYALTY_PORTAL_URL") ?? "https://www.lumilinkhub.com/loyalty").replace(/\/+$/, "");
const STATE_COOKIE = "ll_loyalty_state";
const SHOP_BASE = (Deno.env.get("SHOPIFY_SHOP_BASE") ?? "").replace(/\/+$/, "");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type App = { clientId: string; clientSecret: string; scopes: string };

async function loadApps(shop: string): Promise<App[]> {
  const { data, error } = await supabase.rpc("get_loyalty_shopify_apps", { p_shop: shop });
  if (error) throw new Error(`loading apps failed: ${error.message}`);
  const out: App[] = [];
  for (const row of (data ?? []) as { app_client_id: string; scopes: string; credentials: string | null }[]) {
    const creds = parseAppCredentials(row.credentials);
    if (!creds) throw new Error(`the Vault secret for ${shop} / ${row.app_client_id} is missing or isn't JSON with client_id and client_secret`);
    out.push({ clientId: creds.clientId, clientSecret: creds.clientSecret, scopes: row.scopes });
  }
  return out;
}

async function appBySignature(apps: App[], params: URLSearchParams): Promise<App | null> {
  for (const a of apps) if (await verifyHmac(params, a.clientSecret)) return a;
  return null;
}

// Installed = this app has a stored token that Shopify still accepts. A store
// that uninstalled and reinstalled keeps its old token_ref, so the token is
// checked (access_scopes, cheap) before skipping the install.
async function isInstalled(shop: string, clientId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("loyalty_shopify_apps")
    .select("token_ref, program_id")
    .eq("shop_domain", shop)
    .eq("app_client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(`loading install state failed: ${error.message}`);
  if (!data?.token_ref) return false;
  const { data: tok } = await supabase.rpc("get_loyalty_shopify_token", { p_program: data.program_id });
  const token = (tok as { access_token?: string } | null)?.access_token;
  if (!token) return false;
  try {
    const res = await fetch(SHOP_BASE ? `${SHOP_BASE}/${shop}/admin/oauth/access_scopes.json` : `https://${shop}/admin/oauth/access_scopes.json`, {
      headers: { "X-Shopify-Access-Token": token, Accept: "application/json" },
    });
    await res.body?.cancel();
    return res.status !== 401 && res.status !== 403;
  } catch {
    return true; // Shopify unreachable: a reinstall would fail too, so open the dashboard.
  }
}

function toPortal(clearCookie = false): Response {
  const headers: Record<string, string> = { Location: PORTAL_URL, "Cache-Control": "no-store" };
  if (clearCookie) headers["Set-Cookie"] = `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  return new Response(null, { status: 302, headers });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, message: string, status = 200, clearCookie = true): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LL Loyalty</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
  if (clearCookie) headers["Set-Cookie"] = `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  return new Response(html, { status, headers });
}

async function start(params: URLSearchParams): Promise<Response> {
  const shop = validShop(params.get("shop"));
  if (!shop) return page("Not a Shopify store", "The address should end in .myshopify.com.", 400);
  const apps = await loadApps(shop);
  if (apps.length === 0) return page("Store not set up", `${shop} isn't registered for LL Loyalty yet. Ask LumiLink to set it up.`, 404);

  let app: App | null;
  if (params.has("hmac")) {
    app = await appBySignature(apps, params);
    if (!app) return page("Signature check failed", "Shopify's signature didn't check out. Open the app again from Shopify admin.", 401);
    // Sidebar click on an installed store: open the dashboard, not a reinstall.
    if (await isInstalled(shop, app.clientId)) return toPortal();
  } else {
    const wanted = params.get("app");
    app = wanted ? (apps.find((a) => a.clientId === wanted) ?? null) : apps.length === 1 ? apps[0] : null;
    if (!app) return page("Which app?", "This store has more than one LL Loyalty app. Open it from Shopify admin.", 400);
  }

  const state = crypto.randomUUID().replace(/-/g, "");
  const url = authorizeUrl({ shop, clientId: app.clientId, scopes: app.scopes, redirectUri: `${SELF_URL}/callback`, state });
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "no-store",
      "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

async function callback(req: Request, params: URLSearchParams): Promise<Response> {
  const shop = validShop(params.get("shop"));
  const code = params.get("code");
  const state = params.get("state");
  const cookieState = readCookie(req.headers.get("cookie"), STATE_COOKIE);
  if (params.get("error")) return page("Cancelled", "The LL Loyalty install was cancelled.");
  if (!shop || !code || !state || !cookieState || state !== cookieState) {
    return page("Link expired", "That install link expired or was invalid. Open the app again from Shopify admin.", 400);
  }
  const app = await appBySignature(await loadApps(shop), params);
  if (!app) return page("Signature check failed", "Shopify's signature didn't check out. Try again.", 401);

  let res: Response;
  try {
    res = await fetch(SHOP_BASE ? `${SHOP_BASE}/${shop}/admin/oauth/access_token` : `https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, code }),
    });
  } catch (e) {
    await supabase.rpc("mark_loyalty_shopify_error", { p_shop: shop, p_app_client_id: app.clientId, p_error: `token exchange failed: ${String(e)}` });
    return page("Couldn't reach Shopify", "Try opening the app again in a minute.", 502);
  }
  const result = parseTokenResponse(res.status, await res.text());
  if (!result.ok) {
    console.error(`loyalty-oauth ${shop}: ${result.error}`);
    await supabase.rpc("mark_loyalty_shopify_error", { p_shop: shop, p_app_client_id: app.clientId, p_error: result.error });
    return page("Shopify refused the install", result.error, 502);
  }

  const { error } = await supabase.rpc("store_loyalty_shopify_token", {
    p_shop: shop,
    p_app_client_id: app.clientId,
    p_access_token: result.token,
    p_scopes: result.scopes,
  });
  if (error) {
    console.error(`loyalty-oauth ${shop}: storing the token failed: ${error.message}`);
    return page("Install didn't finish", "Connected to Shopify, but saving the connection failed. Try again.", 500);
  }
  console.log(`loyalty-oauth ${shop}: installed app ${app.clientId}, scopes ${result.scopes.join(",")}`);
  return toPortal(true);
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  try {
    if (url.pathname.endsWith("/callback")) return await callback(req, url.searchParams);
    return await start(url.searchParams);
  } catch (e) {
    console.error(`loyalty-oauth: ${e instanceof Error ? e.message : String(e)}`);
    return page("Something went wrong", "Something went wrong connecting LL Loyalty. Try again.", 500);
  }
});
