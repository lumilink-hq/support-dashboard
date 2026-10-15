// =============================================================================
// loyalty-proxy — the Wave Rewards theme block's backend, reached through the
// Shopify app proxy (storefront /apps/loyalty/* -> here). 0204.
//
//   GET  /state      program rules; the shopper's own state when logged in
//   POST /redeem     {reward_key, request_key}   spend points, get a code
//   POST /birthday   {birthday: "YYYY-MM-DD"}    once
//   POST /claim      {key}                       honor-system action (Instagram follow)
//   POST /referral   {ref, email}                referred friend's form -> their code
//
// AUTH: the app proxy signature (query string, app's client secret) and its
// timestamp; the shopper is logged_in_customer_id from the SIGNED query, never
// from the body. Member data is only ever the logged-in customer's own.
// Shopify sends no JWT, so deploy with --no-verify-jwt.
//
// A redeemed or referral code is created in Shopify right away when possible;
// if that attempt fails it stays pending and loyalty-shopify retries it within
// a minute, so the shopper sees "being created" rather than an error.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role);
//      SHOPIFY_SHOP_BASE (optional, test only: mock store).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { issueCode, type PendingCode } from "../_loyalty/codes.ts";
import { parseAppCredentials } from "../shopify-oauth/lib.ts";
import { parseBirthday, parseEmail, parseKey, parseReferralCode, parseRequestKey, route, verifyProxy } from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");
const SHOP_BASE = (Deno.env.get("SHOPIFY_SHOP_BASE") ?? "").replace(/\/+$/, "");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** Try to create a pending code in Shopify now; report its status either way. */
async function issueNow(programId: string, codeId: string): Promise<"issued" | "pending"> {
  const row = await rpc<PendingCode | null>("loyalty_code_for_issue", { p_code: codeId });
  if (!row) return "issued"; // already created (a retried request)
  const tok = await rpc<{ shop_domain?: string; access_token?: string } | null>("get_loyalty_shopify_token", { p_program: programId });
  if (!tok?.shop_domain || !tok.access_token) return "pending";
  const r = await issueCode(supabase, tok.shop_domain, tok.access_token, row, SHOP_BASE);
  if (!r.ok) console.warn(`loyalty-proxy ${tok.shop_domain}: code ${codeId} not created yet: ${r.error}`);
  return r.ok ? "issued" : "pending";
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const r = route(url.pathname, req.method);
  if (!r) return json({ error: "not_found" }, 404);

  // Shop's app secrets (custom + public app) verify the proxy signature.
  const shopParam = (url.searchParams.get("shop") ?? "").toLowerCase();
  let apps: { program_id: string; credentials: string | null }[];
  try {
    apps = await rpc("get_loyalty_shopify_apps", { p_shop: shopParam });
  } catch (e) {
    console.error(`loyalty-proxy: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "unavailable" }, 503);
  }
  const secrets = apps.map((a) => parseAppCredentials(a.credentials)?.clientSecret ?? "").filter(Boolean);
  const auth = await verifyProxy(url.searchParams, secrets, Math.floor(Date.now() / 1000));
  if (!auth.ok) return json({ error: "unauthorized" }, 401);

  try {
    const programId = await rpc<string | null>("loyalty_program_for_shop", { p_shop: auth.shop });
    if (!programId) return json({ error: "no_program" }, 404);

    if (r === "state") {
      return json(await rpc("loyalty_storefront_state", { p_program: programId, p_customer_id: auth.customerId }));
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "bad_request" }, 400);
    }

    // The friend's form is the only write that doesn't need a login.
    if (r === "referral") {
      const ref = parseReferralCode(body.ref);
      const email = parseEmail(body.email);
      if (!ref || !email) return json({ status: "invalid" }, 400);
      const res = await rpc<{ status: string; code?: string; code_id?: string }>("loyalty_referral_by_code", {
        p_program: programId, p_referral_code: ref, p_friend_email: email,
      });
      if (res.status !== "created" || !res.code_id) return json({ status: res.status });
      return json({ status: "created", code: res.code, code_status: await issueNow(programId, res.code_id) });
    }

    if (!auth.customerId) return json({ error: "login_required" }, 401);
    const memberId = await rpc<string | null>("loyalty_member_for_customer", { p_program: programId, p_customer_id: auth.customerId });
    if (!memberId) return json({ error: "not_a_member" }, 403);

    if (r === "redeem") {
      const reward = parseKey(body.reward_key);
      const requestKey = parseRequestKey(body.request_key);
      if (!reward || !requestKey) return json({ status: "invalid" }, 400);
      const res = await rpc<{ status: string; code_id?: string; code?: string; code_status?: string }>("loyalty_redeem", {
        p_member: memberId, p_reward_key: reward, p_request_key: requestKey,
      });
      if (res.status === "pending" && res.code_id) {
        return json({ status: "redeemed", code: res.code, code_status: await issueNow(programId, res.code_id) });
      }
      if (res.status === "duplicate") return json({ status: "redeemed", code: res.code, code_status: res.code_status === "pending" ? "pending" : "issued" });
      return json({ status: res.status });
    }

    if (r === "birthday") {
      const day = parseBirthday(body.birthday);
      if (!day) return json({ status: "invalid" }, 400);
      return json({ status: await rpc<string>("loyalty_set_birthday", { p_member: memberId, p_birthday: day }) });
    }

    // claim
    const key = parseKey(body.key);
    if (!key) return json({ status: "invalid" }, 400);
    const points = await rpc<number>("loyalty_claim_action", { p_member: memberId, p_rule_key: key });
    return json({ status: points > 0 ? "claimed" : "not_claimed", points });
  } catch (e) {
    console.error(`loyalty-proxy ${auth.shop} ${r}: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "server_error" }, 500);
  }
});
