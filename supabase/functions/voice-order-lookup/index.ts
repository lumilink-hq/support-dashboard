// =============================================================================
// voice-order-lookup — server tool for the ElevenLabs voice agent.
//
// The agent calls this mid-call (as a "server tool") once it has an order number.
// It does what the email Zap does in steps 2/5/6/7/8, packaged as one HTTPS call:
//   1. resolve the tenant from the DIALED number (clients.phone_number)
//   2. resolve store + shipping secrets (Supabase Vault, with env fallback)
//   3. fetch the order — WooCommerce REST *or* Shopify Admin GraphQL
//   4. normalize + cache into orders_cache
//   5. evaluate the flag rule
//   6. ensure the voice conversation exists (ingest_call) and link the order
// and returns a COMPACT, speakable payload the agent uses to answer or escalate.
//
// Both platforms collapse into the same normalized shape (see lib.ts), so the
// agent prompt, orders_cache, evaluate_flag and the dashboard are all unaware of
// which store answered.
//
// Auth: expects header  x-voice-tool-secret: <VOICE_TOOL_SECRET>  so the endpoint
// isn't open to the world. Configure the same secret in the ElevenLabs tool.
//
// Env (supabase secrets set ...):
//   SUPABASE_URL, SUPABASE_SECRET_KEYS  (JSON; ["default"] = service role) — same
//     convention as zapier-upsert-allowlist.
//   VOICE_TOOL_SECRET                   — shared secret with the ElevenLabs tool.
//   MOCK_STORE=1                        — skip real store calls and use a canned
//     order (for testing the whole loop without store creds).
//   WOO_CONSUMER_KEY / WOO_CONSUMER_SECRET / SHIPSTATION_API_KEY /
//   SHIPSTATION_API_SECRET / SHOPIFY_ACCESS_TOKEN / SHOPIFY_STORE_URL
//                                       — optional single-pilot fallbacks used
//     only when the client's *_credentials_ref (Vault) are not set (crunch mode).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  buildShopifySearchQuery,
  extractClientRef,
  mapShopifyOrder,
  mapWooOrder,
  normalizeOrderNumber,
  parseCreds,
  pickExactOrder,
  pickShopifyCreds,
  SHOPIFY_ORDER_QUERY,
  shopifyErrorFrom,
  shopifyGraphqlUrl,
  stripHash,
  stripTrailingSlash,
  verifyCaller,
  type LineItemLite,
  type NormalizedOrder,
} from "./lib.ts";

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
  called_number?: string; // PHONE: the number the customer dialed (Twilio "To")
  client_ref?: string; // WEB: the tenant slug (browser calls have no number)
  client_slug?: string; // WEB: alias for client_ref
  caller_number?: string; // the customer's number (Twilio "From")
  order_number?: string;
  call_sid?: string; // Twilio call SID -> conversation.external_ref
  conversation_id?: string; // WEB: ElevenLabs conversation id, used instead
  caller_name?: string;
  // Caller verification — required on the web path (see the security note below).
  verify_email?: string;
  verify_zip?: string;
};

type LookupResponse = {
  found: boolean;
  // control signals for the agent's script:
  need_order_number?: boolean; // ask the caller for it
  order_not_found?: boolean; // number given but no matching order
  unknown_number?: boolean; // dialed number isn't a configured client
  unknown_client?: boolean; // slug isn't a configured client
  web_lookup_disabled?: boolean; // slug valid but not opted into web lookup
  verification_required?: boolean; // web: ask for email or ZIP before any details
  verification_failed?: boolean; // web: what they gave didn't match the order
  verify_with?: string; // what to ask for
  // Usage limiter, layer 3: this call started under the cap but the tenant is
  // over it now. Answer what's already known, then close out politely.
  wrap_up?: boolean;
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
  // identity check — the agent confirms this before reading anything personal
  // back. The value to be confirmed is never sent over the wire.
  verify_hint?: string | null;
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

// A store we couldn't reach must never become a confident wrong answer.
const LOOKUP_ERROR: LookupResponse = {
  found: false,
  should_escalate: true,
  flagged: true,
  flag_reason: "lookup_error",
  message: "Couldn't reach the store. Offer a callback or transfer.",
};

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

  // Phone sets called_number and an EMPTY client_ref; web sets client_ref and an
  // empty called_number. extractClientRef treats "" as absent — ElevenLabs sends
  // every configured parameter on every call.
  const { calledNumber, clientSlug, conversationRef } = extractClientRef(body);
  // Callers say "#1001" / "order ten oh one" — normalize before this reaches any
  // store API, where a stray "#" silently returns zero results.
  const orderNumber = normalizeOrderNumber(body.order_number);
  const callSid = conversationRef;
  // Everything routed by slug is a browser session on a public page.
  const isWeb = !calledNumber && !!clientSlug;

  if (!calledNumber && !clientSlug) {
    return json({ error: "Missing called_number or client_ref" }, 400);
  }

  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Resolve the tenant — by dialed number (phone) or slug (web).
  let clientId: string | null = null;

  if (calledNumber) {
    const { data, error: resolveErr } = await supabase.rpc(
      "resolve_client_by_number",
      { p_called_number: calledNumber },
    );
    if (resolveErr) return json({ error: resolveErr.message }, 400);
    clientId = (data as string | null) ?? null;
    if (!clientId) {
      return json({
        found: false,
        unknown_number: true,
        message: "This phone line isn't configured for a store.",
      });
    }
  } else {
    // -------------------------------------------------------------------------
    // WEB PATH. A slug is public — it sits in the page's HTML — so it is an
    // IDENTIFIER, NEVER A CREDENTIAL. Two gates stand behind it:
    //   (a) the client must explicitly opt in (settings.web_lookup_enabled, or
    //       is_demo for the sandbox tenants), so a leaked slug for a client that
    //       never enabled web can't reach their store; and
    //   (b) caller verification below, because on a public page an order lookup
    //       is otherwise an unauthenticated API over the order book.
    // -------------------------------------------------------------------------
    const { data: row, error: slugErr } = await supabase
      .from("clients")
      .select("id, is_active, settings")
      .eq("slug", clientSlug)
      .maybeSingle();
    if (slugErr) return json({ error: slugErr.message }, 400);
    if (!row || row.is_active === false) {
      return json({
        found: false,
        unknown_client: true,
        message: "This demo isn't configured.",
      });
    }
    const settings = (row.settings ?? {}) as Record<string, unknown>;
    const webEnabled =
      settings.web_lookup_enabled === true || settings.is_demo === true;
    if (!webEnabled) {
      return json({
        found: false,
        web_lookup_disabled: true,
        message: "Order lookup isn't available on this channel.",
      });
    }
    clientId = row.id as string;
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

  // ---------------------------------------------------------------------------
  // Usage limiter — LAYER 3 of 4 (see docs/tsunami-voice-orders-plan.md §4d).
  //
  // Layer 1 (the pre-call gate in voice-personalization) stops calls that begin
  // over the cap. This catches the other case: a call that STARTED under the cap
  // and crossed it while in progress. We don't refuse — the caller is already on
  // the line and hanging up mid-sentence is worse than the overage — we just
  // tell the agent to wrap up. A failure here must never block an answer, so it
  // is deliberately swallowed.
  // ---------------------------------------------------------------------------
  let wrapUp = false;
  try {
    const { data: allowance } = await supabase.rpc("check_voice_allowance", {
      p_client_id: clientId,
    });
    wrapUp = allowance ? allowance.allowed === false : false;
  } catch (e) {
    console.error("check_voice_allowance failed (continuing)", String(e));
  }

  /** Attach the wrap-up signal to whatever we're about to tell the agent. */
  const withWrap = (r: LookupResponse): LookupResponse =>
    wrapUp
      ? {
          ...r,
          wrap_up: true,
          message: `${r.message ?? ""} This line has reached its usage limit — give the answer you have, then close the call politely.`.trim(),
        }
      : r;

  // No order number yet -> tell the agent to ask for it.
  if (!orderNumber) {
    return json(
      withWrap({
        found: false,
        need_order_number: true,
        message: "Ask the caller for their order number.",
      }),
    );
  }

  // 2) Client config (store platform / base url / order_number_scheme).
  const { data: config, error: cfgErr } = await supabase.rpc(
    "get_client_config",
    { p_client_id: clientId },
  );
  if (cfgErr) return json({ error: cfgErr.message }, 400);

  const storeBaseUrl: string | null = config?.store_base_url ?? null;
  const platform: string = String(
    config?.store_platform ?? "woocommerce",
  ).toLowerCase();

  // ---------------------------------------------------------------------------
  // 3) Fetch the order. Branch per platform. MOCK_STORE short-circuits with a
  //    canned order so the loop is testable without live store creds.
  // ---------------------------------------------------------------------------
  let normalized: NormalizedOrder | null = null;
  // Shopify names are canonical ("#1001") — echo back what the STORE calls it,
  // not whatever the caller happened to say.
  let canonicalOrderNumber = orderNumber;
  // The raw order, Shopify-shaped, used only by the verification gate.
  let verifySubject: Record<string, any> | null = null;

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
    // Keep the verification gate on the same code path in mock mode, so tests
    // exercise it rather than routing around it.
    verifySubject = {
      email: "test@example.com",
      shippingAddress: { zip: "94110" },
    };
  } else {
    // Resolve store + shipping secrets: Vault first, env fallback (single pilot).
    const { data: secrets } = await supabase.rpc(
      "get_client_integration_secrets",
      { p_client_id: clientId },
    );

    // -------------------------------------------------------------------------
    // 3a. Shopify — Admin GraphQL, order looked up by NAME (#1001).
    //     No ShipStation on this path: Shopify carries tracking natively on
    //     fulfillments.trackingInfo, so that's one less API and one less secret.
    // -------------------------------------------------------------------------
    if (platform === "shopify") {
      // NB: the secrets RPC returns the generic store blob under the key
      // "woocommerce" even for Shopify clients — see pickShopifyCreds.
      const shop = pickShopifyCreds(secrets as Record<string, unknown>);
      const token = shop.access_token ?? Deno.env.get("SHOPIFY_ACCESS_TOKEN");
      const shopBase = stripTrailingSlash(
        shop.base_url ?? storeBaseUrl ?? Deno.env.get("SHOPIFY_STORE_URL") ?? "",
      );

      if (!token || !shopBase) {
        return json({
          found: false,
          message: "Store credentials are not configured for this client.",
        });
      }

      let shopRes: Response;
      try {
        shopRes = await fetch(shopifyGraphqlUrl(shopBase), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": token,
          },
          body: JSON.stringify({
            query: SHOPIFY_ORDER_QUERY,
            variables: { q: buildShopifySearchQuery(orderNumber) },
          }),
        });
      } catch (e) {
        console.error("shopify fetch failed", String(e));
        return json(LOOKUP_ERROR);
      }

      if (!shopRes.ok) {
        // 401/403 = bad or expired token, 429 = throttled. Never fabricate.
        console.error("shopify http error", shopRes.status);
        return json(LOOKUP_ERROR);
      }

      const payload = (await shopRes.json().catch(() => null)) as
        | Record<string, any>
        | null;

      // Shopify answers 200 even for query/throttle errors — check the body too.
      const gqlError = shopifyErrorFrom(payload);
      if (gqlError) {
        console.error("shopify graphql error", gqlError);
        return json(LOOKUP_ERROR);
      }

      const nodes = (payload?.data?.orders?.edges ?? [])
        .map((e: any) => e?.node)
        .filter(Boolean);

      // "name:1001" is a token match and can also return "1001-A". Require an
      // exact hit rather than reading a stranger's order down the phone.
      const node = pickExactOrder(nodes, orderNumber);
      if (!node) {
        return json(withWrap({
          found: false,
          order_not_found: true,
          message:
            "No order matched that number. (Only orders from the last 60 days are visible unless read_all_orders is granted.)",
        }));
      }

      canonicalOrderNumber = stripHash(node.name) || orderNumber;
      verifySubject = node;
      normalized = mapShopifyOrder(node);
    } else {
      // -----------------------------------------------------------------------
      // 3b. WooCommerce — REST, looked up by id (order_number_scheme "id").
      // -----------------------------------------------------------------------
      const woo = parseCreds<{
        consumer_key: string;
        consumer_secret: string;
        base_url: string;
      }>(secrets?.woocommerce);
      const ship = parseCreds<{ api_key: string; api_secret: string }>(
        secrets?.shipstation,
      );

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

      const wooRes = await fetch(
        `${wooBase}/wp-json/wc/v3/orders/${encodeURIComponent(orderNumber)}`,
        { headers: { Authorization: basicAuth(wooKey, wooSecret) } },
      );

      if (wooRes.status === 404) {
        return json(withWrap({
          found: false,
          order_not_found: true,
          message: "No order matched that number.",
        }));
      }
      if (!wooRes.ok) {
        console.error("woo http error", wooRes.status);
        return json(LOOKUP_ERROR);
      }

      const o = (await wooRes.json()) as Record<string, any>;

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

      // Shopify-shaped view of the Woo order, for the verification gate only.
      verifySubject = {
        email: o.billing?.email,
        shippingAddress: { zip: o.shipping?.postcode },
        billingAddress: { zip: o.billing?.postcode },
      };
      normalized = mapWooOrder(o, tracking);
    }
  }

  // ---------------------------------------------------------------------------
  // 3c) VERIFICATION GATE — web only.
  //
  // Returns BEFORE the cache write and before any order field is serialized, so
  // a failed attempt leaves no trace and leaks nothing. A phone caller skips
  // this: they came through a dialed number, and the prompt's verify_hint step
  // covers read-back of personal details there.
  //
  // Tradeoff worth naming: a "verification_failed" response does confirm that
  // the order number exists. Given Shopify order names are sequential and
  // guessable anyway, that's a far smaller exposure than the alternative of
  // leaking names and contents — and the caller experience of a generic error
  // on a mistyped ZIP would be bad.
  // ---------------------------------------------------------------------------
  if (isWeb) {
    const verification = verifyCaller(verifySubject, {
      email: body.verify_email,
      zip: body.verify_zip,
    });
    if (!verification.ok) {
      return json(
        withWrap(
          verification.reason === "missing"
            ? {
                found: false,
                verification_required: true,
                verify_with: "email_or_zip",
                message:
                  "Before sharing any order details, ask for the email address on the order or the shipping ZIP code, then call this tool again with it.",
              }
            : {
                found: false,
                verification_failed: true,
                verify_with: "email_or_zip",
                message:
                  "That didn't match this order. Ask them to double-check the email or ZIP. Do not reveal any order details.",
              },
        ),
      );
    }
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
        order_number: canonicalOrderNumber,
        store_platform: config?.store_platform ?? null,
        is_abnormal: flagReason === "abnormal_status",
        ...n,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "client_id,order_number" },
    );

  // 6) Compact, speakable answer for the agent.
  //    verify_hint tells the agent WHAT to ask the caller to confirm before it
  //    reads anything personal back; the value itself is deliberately not sent.
  const verifyHint = n.customer_name
    ? "name_on_order"
    : n.customer_email
      ? "email_on_order"
      : null;

  return json(
    withWrap({
    found: true,
    order_number: canonicalOrderNumber,
    status: n.store_status,
    placed_at: n.order_placed_at,
    items: n.line_items ?? [],
    total: n.order_total != null ? String(n.order_total) : null,
    currency: n.currency,
    tracking_number: n.tracking_number,
    carrier: n.carrier,
    shipping_status: n.shipping_status,
    estimated_delivery: n.estimated_delivery,
    verify_hint: verifyHint,
    flagged,
    flag_reason: flagReason,
    should_escalate: flagged,
    message: flagged
      ? "Order is flagged — give a holding answer and escalate (transfer in hours, else callback)."
      : "Answer the caller's question from these fields.",
    }),
  );
});
