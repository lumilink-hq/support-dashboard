// =============================================================================
// loyalty-webhooks — Shopify webhooks for LL Loyalty (0201).
//
//   POST /loyalty-webhooks   (Shopify only; topic in X-Shopify-Topic)
//     orders/paid             count the order, earn points + milestones, complete a referral
//     refunds/create          claw back points and tier spend
//     customers/create|update enroll account holders, refresh name/email; signup and
//                             newsletter points when they happen after go-live (0202)
//     customers/redact        delete the member (privacy, plan §8b L1-8)
//     shop/redact             delete the store's program (48h after uninstall)
//     customers/data_request  logged for staff to answer by hand
//
// AUTH: Shopify's HMAC over the raw body with the app's client secret, looked
// up by X-Shopify-Shop-Domain in loyalty_shopify_apps. Not x-voice-tool-secret,
// and Shopify sends no JWT, so it MUST be deployed with --no-verify-jwt.
//
// RETRIES: Shopify retries anything but a 2xx (up to 8 times over 4 hours).
// A failure returns 500 so the retry happens; loyalty_webhook_receipts skips a
// delivery that already succeeded, and every ledger write is idempotent on its
// own key, so a retry can't double-award either way.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { parseAppCredentials, validShop } from "../shopify-oauth/lib.ts";
import { asTopic, parseCustomer, parseOrder, parseRedactCustomerId, parseRefund, verifyWebhook, type Topic } from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type AppRow = { app_client_id: string; program_id: string; credentials: string | null };

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

/** Does the work for one verified delivery. Returns a short outcome for the receipt. */
async function handle(topic: Topic, shop: string, programId: string, payload: unknown): Promise<string> {
  switch (topic) {
    case "orders/paid": {
      const order = parseOrder(payload);
      if (!order) return "ignored: no order id";
      const r = await rpc<{ status: string }>("loyalty_record_order", { p_program: programId, p_order: order, p_source: "webhook" });
      // Bonus campaigns (0214). Also on "duplicate": a retry finishes what a failed delivery started.
      const bonus = r.status === "recorded" || r.status === "duplicate"
        ? await rpc<number>("loyalty_apply_campaigns", { p_program: programId, p_order: order })
        : 0;
      const used = order.discount_codes.length
        ? await rpc<number>("loyalty_mark_codes_used", { p_program: programId, p_order: order })
        : 0;
      return [r.status, bonus ? `${bonus} bonus points` : "", used ? `${used} code(s) used` : ""].filter(Boolean).join(", ");
    }
    case "refunds/create": {
      const refund = parseRefund(payload);
      if (!refund) return "ignored: no refund id";
      return await rpc<string>("loyalty_record_refund", {
        p_program: programId,
        p_order_id: refund.order_id,
        p_refund_id: refund.id,
        p_refund_cents: refund.cents,
        p_occurred_at: refund.created_at,
      });
    }
    case "customers/create":
    case "customers/update": {
      const customer = parseCustomer(payload);
      if (!customer) return "ignored: no customer id";
      const id = await rpc<string | null>("loyalty_sync_customer", { p_program: programId, p_customer: customer, p_live: true });
      return id ? "member" : "not_member";
    }
    case "customers/redact": {
      const id = parseRedactCustomerId(payload);
      if (!id) return "ignored: no customer id";
      const n = await rpc<number>("loyalty_redact_customer", { p_shop: shop, p_customer_id: id });
      return `redacted ${n}`;
    }
    case "shop/redact": {
      const n = await rpc<number>("loyalty_redact_shop", { p_shop: shop });
      return `redacted shop ${n}`;
    }
    case "customers/data_request": {
      // Rare; answered by staff from /loyalty (module 7), which lists these
      // receipts. The customer id (no other PII) is what staff look up.
      const id = parseRedactCustomerId(payload);
      console.warn(`loyalty-webhooks ${shop}: customers/data_request for customer ${id ?? "?"}, needs a manual reply`);
      return `manual: data request, customer ${id ?? "unknown"}`;
    }
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const shop = validShop(req.headers.get("x-shopify-shop-domain"));
  const topic = asTopic(req.headers.get("x-shopify-topic"));
  const webhookId = req.headers.get("x-shopify-webhook-id") ?? req.headers.get("x-shopify-event-id");
  const body = new Uint8Array(await req.arrayBuffer());
  if (!shop || !webhookId) return new Response("Bad request", { status: 400 });

  let apps: AppRow[];
  try {
    apps = await rpc<AppRow[]>("get_loyalty_shopify_apps", { p_shop: shop });
  } catch (e) {
    console.error(`loyalty-webhooks ${shop}: ${e instanceof Error ? e.message : String(e)}`);
    return new Response("Error", { status: 500 });
  }
  // Same 401 for "unknown shop" and "bad signature".
  const secrets = apps.map((a) => parseAppCredentials(a.credentials)?.clientSecret ?? "").filter(Boolean);
  if (!(await verifyWebhook(body, req.headers.get("x-shopify-hmac-sha256"), secrets))) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!topic) return new Response("OK (topic not handled)", { status: 200 });

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  try {
    if (!(await rpc<boolean>("loyalty_webhook_begin", { p_shop: shop, p_webhook_id: webhookId, p_topic: topic }))) {
      return new Response("OK (already processed)", { status: 200 });
    }
  } catch (e) {
    console.error(`loyalty-webhooks ${shop} ${topic}: ${e instanceof Error ? e.message : String(e)}`);
    return new Response("Error", { status: 500 });
  }

  try {
    const outcome = await handle(topic, shop, apps[0].program_id, payload);
    await rpc("loyalty_webhook_finish", { p_shop: shop, p_webhook_id: webhookId, p_outcome: outcome, p_error: null });
    return new Response("OK", { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`loyalty-webhooks ${shop} ${topic} ${webhookId}: ${msg}`);
    await supabase.rpc("loyalty_webhook_finish", { p_shop: shop, p_webhook_id: webhookId, p_outcome: "error", p_error: msg });
    return new Response("Error", { status: 500 });
  }
});
