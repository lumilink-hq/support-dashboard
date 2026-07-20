// =============================================================================
// voice-order-lookup — server tool for the ElevenLabs voice agent.
//
// The agent calls this mid-call (as a "server tool") once it has an order number.
// It does what the email Zap does in steps 2/5/6/7/8, packaged as one HTTPS call:
//   1. resolve the tenant from the DIALED number (clients.phone_number)
//   2. resolve store + shipping secrets (Supabase Vault, with env fallback)
//   3. fetch the WooCommerce order + ShipStation shipment
//   4. normalize + cache into orders_cache
//   5. evaluate the flag rule
//   6. ensure the voice conversation exists (ingest_call) and link the order
// and returns a COMPACT, speakable payload the agent uses to answer or escalate.
//
// Auth: expects header  x-voice-tool-secret: <VOICE_TOOL_SECRET>  so the endpoint
// isn't open to the world. Configure the same secret in the ElevenLabs tool.
//
// Env (supabase secrets set ...):
//   SUPABASE_URL, SUPABASE_SECRET_KEYS  (JSON; ["default"] = service role) — same
//     convention as zapier-upsert-allowlist.
//   VOICE_TOOL_SECRET                   — shared secret with the ElevenLabs tool.
//   MOCK_STORE=1                        — skip real Woo/ShipStation calls and use a
//     canned order (for testing the whole loop without store creds).
//   WOO_CONSUMER_KEY / WOO_CONSUMER_SECRET / SHIPSTATION_API_KEY /
//   SHIPSTATION_API_SECRET              — optional single-pilot fallback used only
//     when the client's *_credentials_ref (Vault) are not set (crunch mode).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const MOCK_STORE = Deno.env.get("MOCK_STORE") === "1";

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");

const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)[
  "default"
];
if (!SERVICE_ROLE_SECRET) {
  throw new Error("SUPABASE_SECRET_KEYS['default'] (service role) not found.");
}

// -----------------------------------------------------------------------------
// Tool request/response shapes. Keep the response small and pronounceable — the
// agent reads these fields aloud, so no raw payloads or internal ids leak.
// -----------------------------------------------------------------------------
type LookupRequest = {
  called_number?: string; // the number the customer dialed (Twilio "To")
  caller_number?: string; // the customer's number (Twilio "From")
  order_number?: string;
  call_sid?: string; // Twilio call SID -> conversation.external_ref
  caller_name?: string;
};

type LineItemLite = { name?: string; quantity?: number };

type LookupResponse = {
  found: boolean;
  // control signals for the agent's script:
  need_order_number?: boolean; // ask the caller for it
  order_not_found?: boolean; // number given but no matching order
  unknown_number?: boolean; // dialed number isn't a configured client
  // spoken order facts (present when found):
  order_number?: string;
  status?: string | null;
  placed_at?: string | null;
  items?: LineItemLite[];
  total?: string | null;
  currency?: string | null;
  tracking_number?: string | null;
  carrier?: string | null;
  shipping_status?: string | null;
  estimated_delivery?: string | null;
  // escalation:
  flagged?: boolean;
  flag_reason?: string | null;
  should_escalate?: boolean; // true when flagged — agent should transfer/callback
  message?: string; // human-readable note (errors / guidance)
};

function json(payload: LookupResponse | { error: string }, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", Connection: "keep-alive" },
  });
}

function basicAuth(user: string, pass: string) {
  return "Basic " + btoa(`${user}:${pass}`);
}

function stripTrailingSlash(u: string) {
  return u.replace(/\/+$/, "");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Shared-secret gate.
  if (VOICE_TOOL_SECRET) {
    if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
      return json({ error: "Unauthorized" }, 401);
    }
  }

  let body: LookupRequest;
  try {
    body = (await req.json()) as LookupRequest;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const calledNumber = body.called_number?.trim();
  const orderNumber = body.order_number?.toString().trim();
  const callSid = body.call_sid?.trim();

  if (!calledNumber) {
    return json({ error: "Missing called_number" }, 400);
  }

  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Resolve the tenant from the dialed number.
  const { data: clientId, error: resolveErr } = await supabase.rpc(
    "resolve_client_by_number",
    { p_called_number: calledNumber },
  );
  if (resolveErr) return json({ error: resolveErr.message }, 400);
  if (!clientId) {
    return json({
      found: false,
      unknown_number: true,
      message: "This phone line isn't configured for a store.",
    });
  }

  // Ensure the conversation row exists early so even a failed lookup is logged
  // against a real call. (No-op safe if call_sid is missing.)
  if (callSid) {
    await supabase.rpc("ingest_call", {
      p_client_id: clientId,
      p_call_sid: callSid,
      p_caller_identifier: body.caller_number ?? null,
      p_caller_name: body.caller_name ?? null,
      p_order_number: orderNumber ?? null,
    });
  }

  // No order number yet -> tell the agent to ask for it.
  if (!orderNumber) {
    return json({
      found: false,
      need_order_number: true,
      message: "Ask the caller for their order number.",
    });
  }

  // 2) Client config (store platform / base url / order_number_scheme).
  const { data: config, error: cfgErr } = await supabase.rpc(
    "get_client_config",
    { p_client_id: clientId },
  );
  if (cfgErr) return json({ error: cfgErr.message }, 400);

  const storeBaseUrl: string | null = config?.store_base_url ?? null;

  // ---------------------------------------------------------------------------
  // 3) Fetch the order. WooCommerce pilot. MOCK_STORE short-circuits with a
  //    canned order so the loop is testable without live store creds.
  // ---------------------------------------------------------------------------
  let normalized: Record<string, unknown> | null = null;

  if (MOCK_STORE) {
    normalized = {
      store_status: orderNumber === "0" ? "on-hold" : "processing",
      customer_name: "Test Caller",
      customer_email: "test@example.com",
      currency: "USD",
      order_total: 142.0,
      order_placed_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      line_items: [{ name: "Test Widget", quantity: 1 }],
      tracking_number: "1Z999TEST",
      carrier: "UPS",
      shipping_status: "in_transit",
      shipped_at: null,
      estimated_delivery: null,
      raw_store: { mock: true },
      raw_shipping: { mock: true },
    };
  } else {
    // Resolve store + shipping secrets: Vault first, env fallback (single pilot).
    const { data: secrets } = await supabase.rpc(
      "get_client_integration_secrets",
      { p_client_id: clientId },
    );
    let woo: { consumer_key?: string; consumer_secret?: string; base_url?: string } =
      {};
    let ship: { api_key?: string; api_secret?: string } = {};
    try {
      if (secrets?.woocommerce) woo = JSON.parse(secrets.woocommerce);
    } catch { /* fall through to env */ }
    try {
      if (secrets?.shipstation) ship = JSON.parse(secrets.shipstation);
    } catch { /* fall through to env */ }

    const wooKey = woo.consumer_key ?? Deno.env.get("WOO_CONSUMER_KEY");
    const wooSecret = woo.consumer_secret ?? Deno.env.get("WOO_CONSUMER_SECRET");
    const wooBase = stripTrailingSlash(woo.base_url ?? storeBaseUrl ?? "");
    const shipKey = ship.api_key ?? Deno.env.get("SHIPSTATION_API_KEY");
    const shipSecret = ship.api_secret ?? Deno.env.get("SHIPSTATION_API_SECRET");

    if (!wooKey || !wooSecret || !wooBase) {
      return json({
        found: false,
        message: "Store credentials are not configured for this client.",
      });
    }

    // WooCommerce: pilot uses order_number_scheme "id" (customer # == Woo order id).
    const wooRes = await fetch(
      `${wooBase}/wp-json/wc/v3/orders/${encodeURIComponent(orderNumber)}`,
      { headers: { Authorization: basicAuth(wooKey, wooSecret) } },
    );

    if (wooRes.status === 404) {
      return json({
        found: false,
        order_not_found: true,
        message: "No order matched that number.",
      });
    }
    if (!wooRes.ok) {
      // Never fabricate — treat as escalate-worthy.
      return json({
        found: false,
        should_escalate: true,
        flagged: true,
        flag_reason: "lookup_error",
        message: "Couldn't reach the store. Offer a callback or transfer.",
      });
    }

    const o = (await wooRes.json()) as Record<string, any>;
    const lineItems: LineItemLite[] = Array.isArray(o.line_items)
      ? o.line_items.map((li: any) => ({
          name: li.name,
          quantity: li.quantity,
        }))
      : [];

    // ShipStation tracking (best-effort — missing shipping is not an error).
    let tracking: Record<string, any> | null = null;
    if (shipKey && shipSecret) {
      try {
        const ssRes = await fetch(
          `https://ssapi.shipstation.com/shipments?orderNumber=${encodeURIComponent(orderNumber)}`,
          { headers: { Authorization: basicAuth(shipKey, shipSecret) } },
        );
        if (ssRes.ok) {
          const ss = (await ssRes.json()) as Record<string, any>;
          tracking = Array.isArray(ss.shipments) ? ss.shipments[0] ?? null : null;
        }
      } catch { /* tracking stays null */ }
    }

    normalized = {
      store_status: o.status ?? null,
      customer_name:
        [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(" ") ||
        null,
      customer_email: o.billing?.email ?? null,
      currency: o.currency ?? null,
      order_total: o.total ? Number(o.total) : null,
      order_placed_at: o.date_created ? new Date(o.date_created).toISOString() : null,
      line_items: lineItems,
      tracking_number: tracking?.trackingNumber ?? null,
      carrier: tracking?.carrierCode ?? null,
      shipping_status: tracking?.shipmentStatus ?? null,
      shipped_at: tracking?.shipDate
        ? new Date(tracking.shipDate).toISOString()
        : null,
      estimated_delivery: null,
      raw_store: o,
      raw_shipping: tracking ?? {},
    };
  }

  const n = normalized!;

  // 4) Evaluate the flag rule (shared with email).
  const { data: flagEval } = await supabase.rpc("evaluate_flag", {
    p_client_id: clientId,
    p_store_status: n.store_status ?? null,
    p_order_placed_at: n.order_placed_at ?? null,
  });
  const flagged: boolean = Boolean(flagEval?.flagged);
  const flagReason: string | null = flagEval?.reason ?? null;

  // 5) Cache the normalized order.
  await supabase
    .from("orders_cache")
    .upsert(
      {
        client_id: clientId,
        order_number: orderNumber,
        store_platform: config?.store_platform ?? null,
        is_abnormal: flagReason === "abnormal_status",
        ...n,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "client_id,order_number" },
    );

  // 6) Compact, speakable answer for the agent.
  return json({
    found: true,
    order_number: orderNumber,
    status: (n.store_status as string) ?? null,
    placed_at: (n.order_placed_at as string) ?? null,
    items: (n.line_items as LineItemLite[]) ?? [],
    total: n.order_total != null ? String(n.order_total) : null,
    currency: (n.currency as string) ?? null,
    tracking_number: (n.tracking_number as string) ?? null,
    carrier: (n.carrier as string) ?? null,
    shipping_status: (n.shipping_status as string) ?? null,
    estimated_delivery: (n.estimated_delivery as string) ?? null,
    flagged,
    flag_reason: flagReason,
    should_escalate: flagged,
    message: flagged
      ? "Order is flagged — give a holding answer and escalate (transfer in hours, else callback)."
      : "Answer the caller's question from these fields.",
  });
});
