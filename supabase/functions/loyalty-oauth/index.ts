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
// SELF-SERVE (0222, Phase 2 P1): a store with no registered app can install
// through an app marked self_serve in loyalty_apps. The callback then reads
// the shop's name and time zone and loyalty_install creates its workspace and
// program with generic defaults. Self-serve installs end on a "what's next"
// page, not the staff dashboard.
//
// PUBLIC BY DESIGN, like shopify-oauth: deploy with --no-verify-jwt. Safe
// because it only acts for shops an operator registered in
// loyalty_shopify_apps, or through an app an operator marked self-serve, and
// every Shopify request is HMAC-checked.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role);
//      LOYALTY_OAUTH_URL (optional; default `${SUPABASE_URL}/functions/v1/loyalty-oauth`);
//      LOYALTY_PORTAL_URL (optional; default https://www.lumilinkhub.com/loyalty);
//      SHOPIFY_SHOP_BASE (optional, test only: mock store for the token exchange).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { authorizeUrl, parseAppCredentials, parseTokenResponse, readCookie, validShop, verifyHmac } from "../shopify-oauth/lib.ts";
import { shopifyGraphql } from "../_loyalty/shopify.ts";

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

type App = { clientId: string; clientSecret: string; scopes: string; selfServe: boolean };
type AppRow = { app_client_id: string; scopes: string; credentials: string | null };

function toApps(rows: AppRow[], label: string, selfServe: boolean): App[] {
  return rows.map((row) => {
    const creds = parseAppCredentials(row.credentials);
    if (!creds) throw new Error(`the Vault secret for ${label} / ${row.app_client_id} is missing or isn't JSON with client_id and client_secret`);
    return { clientId: creds.clientId, clientSecret: creds.clientSecret, scopes: row.scopes, selfServe };
  });
}

/** The shop's registered apps, then any self-serve app not already registered for it. */
async function loadApps(shop: string): Promise<App[]> {
  const [reg, self] = await Promise.all([
    supabase.rpc("get_loyalty_shopify_apps", { p_shop: shop }),
    supabase.rpc("get_loyalty_self_serve_apps"),
  ]);
  if (reg.error) throw new Error(`loading apps failed: ${reg.error.message}`);
  if (self.error) throw new Error(`loading self-serve apps failed: ${self.error.message}`);
  const registered = toApps((reg.data ?? []) as AppRow[], shop, false);
  const known = new Set(registered.map((a) => a.clientId));
  const open = toApps((self.data ?? []) as AppRow[], "self-serve", true).filter((a) => !known.has(a.clientId));
  return [...registered, ...open];
}

const SHOP_QUERY = `query LoyaltyInstallShop { shop { name ianaTimezone } }`;

/** Name and time zone for a new program. Missing values fall back to defaults in SQL. */
async function shopDetails(shop: string, token: string): Promise<{ name: string | null; timezone: string | null }> {
  try {
    const data = await shopifyGraphql(shop, token, SHOP_QUERY, {}, SHOP_BASE);
    const s = (data.shop ?? {}) as { name?: unknown; ianaTimezone?: unknown };
    return {
      name: typeof s.name === "string" ? s.name : null,
      timezone: typeof s.ianaTimezone === "string" ? s.ianaTimezone : null,
    };
  } catch (e) {
    console.warn(`loyalty-oauth ${shop}: shop details failed, using defaults: ${e instanceof Error ? e.message : String(e)}`);
    return { name: null, timezone: null };
  }
}

async function appBySignature(apps: App[], params: URLSearchParams): Promise<App | null> {
  for (const a of apps) if (await verifyHmac(params, a.clientSecret)) return a;
  return null;
}

// Installed = this app has a stored token that Shopify still accepts. A store
// that uninstalled and reinstalled keeps its old token_ref, so the token is
// checked (access_scopes, cheap) before skipping the install. Returns how the
// program was created (staff or self_serve), or null when not installed.
async function isInstalled(shop: string, clientId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("loyalty_shopify_apps")
    .select("token_ref, program_id, loyalty_programs(created_via)")
    .eq("shop_domain", shop)
    .eq("app_client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(`loading install state failed: ${error.message}`);
  if (!data?.token_ref) return null;
  const via = (data.loyalty_programs as unknown as { created_via?: string } | null)?.created_via ?? "staff";
  const { data: tok } = await supabase.rpc("get_loyalty_shopify_token", { p_program: data.program_id });
  const token = (tok as { access_token?: string } | null)?.access_token;
  if (!token) return null;
  try {
    const res = await fetch(SHOP_BASE ? `${SHOP_BASE}/${shop}/admin/oauth/access_scopes.json` : `https://${shop}/admin/oauth/access_scopes.json`, {
      headers: { "X-Shopify-Access-Token": token, Accept: "application/json" },
    });
    await res.body?.cancel();
    return res.status !== 401 && res.status !== 403 ? via : null;
  } catch {
    return via; // Shopify unreachable: a reinstall would fail too, so open the dashboard.
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

// After a self-serve install. There is no merchant admin yet (Phase 2 P4), so
// this says what happens next and links to the theme editor.
function welcome(shop: string): Response {
  const store = shop.replace(/\.myshopify\.com$/, "");
  const editor = `https://admin.shopify.com/store/${encodeURIComponent(store)}/themes/current/editor?context=apps`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LL Loyalty</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}a{color:#0b57d0}li{margin:.4rem 0}</style></head>
<body><h1>LL Loyalty is installed</h1>
<p>Your rewards program is set up with standard settings: 1 point per dollar, 200 points for $5 off, and Bronze, Silver and Gold tiers. Every customer is a member.</p>
<p>We're reading your past orders now so customers start in the right tier. That takes a few minutes. Past orders don't earn points.</p>
<h2>Next</h2>
<ol>
<li><a href="${escapeHtml(editor)}" target="_top">Open the theme editor</a>, turn on the <b>Wave Rewards launcher</b> app embed, and add the <b>Wave Rewards page</b> block to a page.</li>
<li>LumiLink will be in touch to adjust points, rewards and tiers to fit your store.</li>
</ol></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

async function start(params: URLSearchParams): Promise<Response> {
  const shop = validShop(params.get("shop"));
  if (!shop) return page("Not a Shopify store", "The address should end in .myshopify.com.", 400);
  const apps = await loadApps(shop);
  if (apps.length === 0) return page("Store not set up", `${shop} isn't registered for LL Loyalty yet. Ask LumiLink to set it up.`, 404);
  const registered = apps.filter((a) => !a.selfServe);

  let app: App | null;
  if (params.has("hmac")) {
    app = await appBySignature(apps, params);
    if (!app) return page("Signature check failed", "Shopify's signature didn't check out. Open the app again from Shopify admin.", 401);
    // Sidebar click on an installed store: open the dashboard, not a reinstall.
    // Self-serve merchants have no dashboard login yet (P2/P4), so they get
    // the welcome page again.
    const via = await isInstalled(shop, app.clientId);
    if (via === "self_serve") return welcome(shop);
    if (via) return toPortal();
  } else {
    // Unsigned (a staff reinstall link): the shop's own app, or ?app=. A
    // self-serve install always starts signed, from Shopify.
    const wanted = params.get("app");
    app = wanted ? (apps.find((a) => a.clientId === wanted) ?? null) : registered.length === 1 ? registered[0] : null;
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

  const details = app.selfServe ? await shopDetails(shop, result.token) : { name: null, timezone: null };
  const { data, error } = await supabase.rpc("loyalty_install", {
    p_shop: shop,
    p_app_client_id: app.clientId,
    p_access_token: result.token,
    p_scopes: result.scopes,
    p_shop_name: details.name,
    p_timezone: details.timezone,
  });
  if (error) {
    console.error(`loyalty-oauth ${shop}: storing the install failed: ${error.message}`);
    return page("Install didn't finish", "Connected to Shopify, but saving the connection failed. Try again.", 500);
  }
  const installed = data as { program_id: string; created: boolean; created_via: string };
  console.log(`loyalty-oauth ${shop}: installed app ${app.clientId}${installed.created ? ", new program" : ""}, scopes ${result.scopes.join(",")}`);
  if (installed.created_via === "self_serve") return welcome(shop);
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
