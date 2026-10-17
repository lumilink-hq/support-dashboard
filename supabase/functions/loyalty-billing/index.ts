// =============================================================================
// loyalty-billing — Shopify App Pricing for LL Loyalty (0224, Phase 2 P3).
//
//   POST /loyalty-billing   header x-voice-tool-secret, body {"program_id"}
//     Called by pg_cron (run_due_loyalty_billing) for programs with pending
//     usage events, and once a day per public-app store. Fills the shop gid if
//     missing, checks the plan on the Partner API when it's a day old, then
//     sends the pending order events to the App Events API.
//   GET /loyalty-billing/return?shop=<x>.myshopify.com[&plan_handle=]
//     Where Shopify sends the merchant after the plan page (set it as the
//     redirect URL in the app's pricing settings). The plan_handle parameter
//     isn't trusted: it only triggers a plan check against the Partner API.
//
// Custom-distribution stores never come through here (no Shopify billing for
// custom apps): staff set their plan with loyalty_staff_set_plan.
//
// Deploy with --no-verify-jwt (CLAUDE.md): the POST uses the shared secret and
// the GET is a public redirect target.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET; SHOPIFY_PARTNER_ORG_ID + SHOPIFY_PARTNER_API_TOKEN
//      (Partner Dashboard > Settings > Partner API clients, Manage apps);
//      SHOPIFY_API_BASE, SHOPIFY_PARTNER_BASE,
//      SHOPIFY_SHOP_BASE (optional, test only: mocks).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { parseAppCredentials, validShop } from "../shopify-oauth/lib.ts";
import { shopifyGraphql } from "../_loyalty/shopify.ts";
import { ACTIVE_SUBSCRIPTION_QUERY, APP_EVENTS_VERSION, classifyEventResponse, planFromSubscription, usageEvent } from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const PARTNER_ORG = Deno.env.get("SHOPIFY_PARTNER_ORG_ID") ?? "";
const PARTNER_TOKEN = Deno.env.get("SHOPIFY_PARTNER_API_TOKEN") ?? "";
const API_BASE = (Deno.env.get("SHOPIFY_API_BASE") ?? "https://api.shopify.com").replace(/\/+$/, "");
const PARTNER_BASE = (Deno.env.get("SHOPIFY_PARTNER_BASE") ?? "https://partners.shopify.com").replace(/\/+$/, "");
const SHOP_BASE = (Deno.env.get("SHOPIFY_SHOP_BASE") ?? "").replace(/\/+$/, "");
const PLAN_CHECK_EVERY_MS = 24 * 3600 * 1000;
const BUDGET_MS = 45_000;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Due = {
  program_id: string;
  shop_domain: string;
  shop_gid: string | null;
  app_client_id: string | null;
  partner_app_gid: string | null;
  plan_checked_at: string | null;
  credentials: string | null;
  events: { id: number; order_id: number; occurred_at: string }[];
};

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

async function ensureShopGid(due: Due): Promise<string | null> {
  if (due.shop_gid) return due.shop_gid;
  const tok = await rpc<{ access_token?: string } | null>("get_loyalty_shopify_token", { p_program: due.program_id });
  if (!tok?.access_token) return null;
  const data = await shopifyGraphql(due.shop_domain, tok.access_token, `query LoyaltyShopId { shop { id } }`, {}, SHOP_BASE);
  const gid = (data.shop as { id?: string } | undefined)?.id ?? null;
  if (gid) {
    const { error } = await supabase.from("loyalty_programs").update({ shopify_shop_gid: gid }).eq("id", due.program_id);
    if (error) throw new Error(`saving the shop gid failed: ${error.message}`);
  }
  return gid;
}

/** Partner API plan check. Returns what happened, for the log. */
async function checkPlan(due: Due, shopGid: string): Promise<string> {
  if (!PARTNER_ORG || !PARTNER_TOKEN || !due.partner_app_gid) return "plan check skipped: no Partner API config";
  const res = await fetch(`${PARTNER_BASE}/${PARTNER_ORG}/api/${APP_EVENTS_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": PARTNER_TOKEN },
    body: JSON.stringify({ query: ACTIVE_SUBSCRIPTION_QUERY, variables: { appId: due.partner_app_gid, shopId: shopGid } }),
  });
  const j = (await res.json().catch(() => ({}))) as { data?: { activeSubscription?: unknown }; errors?: unknown };
  if (res.status !== 200 || j.errors) throw new Error(`Partner API ${res.status}: ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);

  const { data: plans, error } = await supabase.from("loyalty_plans").select("key, shopify_plan_handle");
  if (error) throw new Error(`loading plans failed: ${error.message}`);
  const handles: Record<string, string> = {};
  for (const p of plans ?? []) if (p.shopify_plan_handle) handles[p.shopify_plan_handle] = p.key;

  const key = planFromSubscription(j.data?.activeSubscription ?? null, handles);
  if (!key) return `plan check: unknown Shopify plan handle, left as is (${JSON.stringify(j.data?.activeSubscription).slice(0, 200)})`;
  const r = await rpc<{ from: string; to: string }>("loyalty_set_plan", { p_program: due.program_id, p_plan_key: key, p_source: "shopify" });
  return `plan ${r.from} -> ${r.to}`;
}

async function appEventsToken(clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (res.status !== 200 || !j.access_token) throw new Error(`App Events token ${res.status}`);
  return j.access_token;
}

async function sendEvents(due: Due, shopGid: string, started: number): Promise<{ sent: number; retry: number; failed: number }> {
  const out = { sent: 0, retry: 0, failed: 0 };
  if (!due.events.length) return out;
  const creds = parseAppCredentials(due.credentials);
  if (!creds) throw new Error("the public app's Vault secret is missing or isn't JSON with client_id and client_secret");
  const token = await appEventsToken(creds.clientId, creds.clientSecret);
  for (const e of due.events) {
    if (Date.now() - started > BUDGET_MS) break;
    const body = usageEvent({ shopGid, programId: due.program_id, orderId: e.order_id, occurredAt: e.occurred_at });
    let status = 0;
    let text = "";
    try {
      const res = await fetch(`${API_BASE}/app/${APP_EVENTS_VERSION}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      status = res.status;
      text = (await res.text()).slice(0, 300);
    } catch (err) {
      text = String(err);
    }
    const kind = status ? classifyEventResponse(status) : "retry";
    if (kind === "sent") {
      await rpc("loyalty_billing_mark", { p_event: e.id, p_ok: true });
      out.sent++;
    } else {
      await rpc("loyalty_billing_mark", { p_event: e.id, p_ok: false, p_error: `${status || "network"}: ${text}` });
      if (kind === "retry") {
        out.retry++;
        if (status === 429) break; // rate limited: the next run picks up the rest
      } else {
        out.failed++;
      }
    }
  }
  return out;
}

async function run(programId: string, forcePlanCheck: boolean): Promise<Record<string, unknown>> {
  const started = Date.now();
  const due = await rpc<Due | null>("loyalty_billing_due", { p_program: programId });
  if (!due) return { status: "unknown program" };
  if (!due.app_client_id) return { status: "no public app installed" };
  const shopGid = await ensureShopGid(due);
  if (!shopGid) return { status: "no shop gid (no token)" };

  let plan = "plan check not due";
  const stale = !due.plan_checked_at || Date.now() - new Date(due.plan_checked_at).getTime() > PLAN_CHECK_EVERY_MS;
  if (forcePlanCheck || stale) {
    try {
      plan = await checkPlan(due, shopGid);
    } catch (e) {
      plan = `plan check failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const events = await sendEvents(due, shopGid, started);
  return { status: "ok", plan, ...events };
}

// After the plan page. Nothing on it comes from the request except the plan
// name we looked up ourselves.
function returnPage(plan: string): Response {
  const line = plan ? `You're on the ${plan} plan.` : "Your plan change is being processed.";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LL Loyalty</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}</style></head>
<body><h1>Thanks</h1><p>${line.replace(/[<>&]/g, "")} Features for the plan turn on within a minute. You can close this tab.</p></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.pathname.endsWith("/return")) {
      const shop = validShop(url.searchParams.get("shop"));
      let plan = "";
      if (shop) {
        const { data } = await supabase.from("loyalty_programs").select("id").eq("shop_domain", shop).maybeSingle();
        if (data?.id) {
          const r = await run(data.id as string, true);
          console.log(`loyalty-billing return ${shop}: ${JSON.stringify(r)}`);
          const { data: p } = await supabase.from("loyalty_programs").select("loyalty_plans(name)").eq("id", data.id).maybeSingle();
          plan = (p?.loyalty_plans as unknown as { name?: string } | null)?.name ?? "";
        }
      }
      return returnPage(plan);
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (!VOICE_TOOL_SECRET || req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = (await req.json().catch(() => ({}))) as { program_id?: string };
    if (!body.program_id) return new Response("program_id required", { status: 400 });
    const result = await run(body.program_id, false);
    console.log(`loyalty-billing ${body.program_id}: ${JSON.stringify(result)}`);
    return Response.json(result);
  } catch (e) {
    console.error(`loyalty-billing: ${e instanceof Error ? e.message : String(e)}`);
    return new Response("Error", { status: 500 });
  }
});
