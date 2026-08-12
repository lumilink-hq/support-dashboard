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
  checkCallTime,
  formatPlacedOn,
  shopifyOrderQueries,
  timeNotice,
  type TimeCheck,
  extractClientRef,
  mapShopifyOrder,
  mapWooOrder,
  normalizeOrderNumber,
  parseCreds,
  orderNumberCandidates,
  pickExactOrder,
  pickShipment,
  pickShopifyCreds,
  pickWooOrder,
  shipStationOrderNumber,
  SHOPIFY_API_VERSION,
  SHOPIFY_ORDER_QUERY,
  shopifyErrorFrom,
  shopifyGraphqlUrl,
  stripHash,
  stripTrailingSlash,
  verifyCaller,
  wooOrderUrl,
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
  // ElevenLabs {{system__call_duration_secs}} — how long the call has been
  // running. Lets us warn before the hard cut instead of being severed.
  call_duration_secs?: number | string;
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
  // Per-call duration clock. ElevenLabs cuts the line without warning at the
  // ceiling, so the agent is told how long is left and asked to close it out.
  seconds_remaining?: number;
  wind_down?: boolean;  // finish this topic, don't start another
  final_call?: boolean; // one sentence, say goodbye, end_call
  // spoken order facts (present when found):
  order_number?: string;
  status?: string | null;
  placed_at?: string | null;
  // Store-local, speech-ready. What the agent reads aloud.
  placed_on?: string | null;
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

/**
 * One structured line per "no order matched".
 *
 * WHY THIS EXISTS: a not-found is the one outcome with several unrelated causes
 * that are INDISTINGUISHABLE from the response — the payload says
 * `order_not_found: true` whether the store was asked for the wrong name, asked
 * with a token that can't see the order, or asked on the wrong store entirely
 * (the Vault->env credential fallback below is silent by design). Reconstructing
 * which one it was from a call transcript is guesswork, so every fact needed to
 * tell them apart is written here instead:
 *
 *   • `attempts`  — what we ASKED for and what came back. Empty `returned`
 *     everywhere means the store genuinely has no such name; non-empty
 *     `returned` with no hit means the exact-match guard rejected near-misses,
 *     and `names` shows what it rejected.
 *   • `*_source`  — vault | client_config | env. An `env` here on a live tenant
 *     is the tell that we queried whatever store the fallback env vars name,
 *     not the client's.
 *   • `shop_host` / `api_version` — which store, which API contract.
 *
 * Grep with: `supabase functions logs voice-order-lookup | grep order_not_found`
 * No secrets: tokens are never included, only WHERE they came from.
 */
function logNotFound(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event: "order_not_found", ...fields }));
}

/** Host only — never log a base URL that might carry credentials in it. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return String(url ?? "").replace(/^https?:\/\//, "").split("/")[0];
  }
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
  let timing: TimeCheck = { remaining: null, windDown: false, finalCall: false };
  try {
    const { data: allowance } = await supabase.rpc("check_voice_allowance", {
      p_client_id: clientId,
    });
    wrapUp = allowance ? allowance.allowed === false : false;
    // The OTHER clock: this call's own duration ceiling. ElevenLabs enforces it
    // by terminating mid-sentence with no warning, so the agent needs to know
    // how long it has and close the call itself.
    timing = checkCallTime(body.call_duration_secs, allowance?.max_call_secs);
  } catch (e) {
    console.error("check_voice_allowance failed (continuing)", String(e));
  }

  /** Attach the wrap-up and time signals to whatever we tell the agent. */
  const withWrap = (r: LookupResponse): LookupResponse => {
    const notes = [
      r.message ?? "",
      wrapUp
        ? "This line has reached its usage limit — give the answer you have, then close the call politely."
        : "",
      timeNotice(timing) ?? "",
    ].filter(Boolean);

    return {
      ...r,
      ...(wrapUp ? { wrap_up: true } : {}),
      ...(timing.remaining !== null
        ? {
            seconds_remaining: timing.remaining,
            wind_down: timing.windDown,
            final_call: timing.finalCall,
          }
        : {}),
      message: notes.join(" ").trim(),
    };
  };

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

  // IANA name from client_timezone() via get_client_config (0029). Always
  // present and already validated; UTC only if the client set nothing.
  const clientTimezone: string = config?.timezone ?? "UTC";
  // 'callback' (default) | 'email'. Decides where the agent sends a caller it
  // cannot finish with; see the escalation copy below.
  const escalationMode: string = config?.escalation_mode === "email" ? "email" : "callback";
  const storeBaseUrl: string | null = config?.store_base_url ?? null;
  const platform: string = String(
    config?.store_platform ?? "woocommerce",
  ).toLowerCase();
  // Order-name prefix, e.g. "TSU#" -> orders are named "TSU#1749".
  // Null/absent = the default "#1234" shape. Added by migration 0017.
  // Applies to BOTH platforms: a Woo store with a sequential-number plugin can
  // prefix its numbers exactly the same way.
  const orderPrefix: string | null = config?.order_number_prefix ?? null;
  // WooCommerce only. 'id' (default) | 'search' | 'meta:<key>' — see wooOrderUrl.
  // Added to get_client_config by migration 0022; absent on older DBs, and the
  // ?? keeps this function working against one.
  const orderScheme: string = config?.order_number_scheme ?? "id";

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

      // WHICH store answered, and on whose credentials. The env fallback above
      // is deliberate (single-pilot crunch mode) but SILENT: a client whose
      // Vault blob is missing or mis-keyed doesn't fail loudly, it quietly gets
      // whatever store SHOPIFY_STORE_URL names — and every one of its orders
      // then "doesn't exist" while sitting in the real store. Nothing in the
      // response reveals this, so it goes in the not-found log.
      const tokenSource = shop.access_token ? "vault" : "env";
      const baseSource = shop.base_url
        ? "vault"
        : storeBaseUrl
          ? "client_config"
          : "env";

      if (!token || !shopBase) {
        return json({
          found: false,
          message: "Store credentials are not configured for this client.",
        });
      }

      // Try the caller's value as given, then digits-only if it carried letters.
      // Customers read "TSU#1749" off a confirmation while Shopify names the
      // order "#1749"; orders_cache proves the store's names are bare digits.
      // The second attempt only widens what we ASK for — pickExactOrder still
      // requires an exact match on the real name.
      // Two dimensions to try, flattened into one ordered list of queries:
      //   • what the caller said, then digits-only if it carried letters
      //   • with the store's prefix, then without it
      // The second dimension is what makes a MISCONFIGURED prefix survivable:
      // "TSU#" is what Tsunami's customers read off their email, not what
      // Shopify names the order, so re-attaching it to a bare "1756" asks for a
      // name that doesn't exist. Trying both shapes costs one extra request on a
      // miss and turns a failed call into a found order.
      const queries = [
        ...new Set(
          orderNumberCandidates(orderNumber).flatMap((c) =>
            shopifyOrderQueries(c, orderPrefix)
          ),
        ),
      ];

      let node: Record<string, any> | null = null;
      // One entry per query actually sent. This is what separates "the store
      // has no such order" from "the store returned candidates and the
      // exact-match guard rejected them" — two very different bugs that look
      // identical from the outside.
      const attempts: Record<string, unknown>[] = [];
      for (const q of queries) {
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
              variables: { q },
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
        // Matched against what the CALLER said, not against the query we
        // happened to send — pickExactOrder already accepts the caller's digits
        // with or without the store's prefix, in either direction.
        const hit = pickExactOrder(nodes, orderNumber, orderPrefix);
        attempts.push({
          q,
          returned: nodes.length,
          // The names the store DID return. If the real order is in here, the
          // bug is in pickExactOrder/the prefix, not in the store.
          names: nodes.map((n: any) => n?.name).filter(Boolean),
          hit: Boolean(hit),
        });
        if (hit) {
          node = hit;
          break;
        }
      }

      if (!node) {
        logNotFound({
          platform: "shopify",
          client_id: clientId,
          call_sid: callSid,
          // What the model heard, after normalizeOrderNumber.
          heard: orderNumber,
          prefix: orderPrefix,
          shop_host: hostOf(shopBase),
          token_source: tokenSource,
          base_source: baseSource,
          api_version: SHOPIFY_API_VERSION,
          attempts,
        });
        return json(withWrap({
          found: false,
          order_not_found: true,
          // NB: this string is handed to the LLM and is therefore sayable. The
          // previous version explained the `read_all_orders` 60-day scope
          // limit — an internal API detail the agent could read out to a
          // customer, and a cause it has no way to confirm. That caveat now
          // lives in the log line above, where it can be checked instead of
          // guessed.
          message:
            "No order matched that number. Ask the caller to re-read it digit by digit; if it's the same number, don't keep asking — take their details for a callback.",
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
      // Same silent-fallback tell as the Shopify branch above.
      const wooKeySource = woo.consumer_key ? "vault" : "env";
      const wooBaseSource = woo.base_url ? "vault" : "client_config";
      const shipKey = ship.api_key ?? Deno.env.get("SHIPSTATION_API_KEY");
      const shipSecret = ship.api_secret ?? Deno.env.get("SHIPSTATION_API_SECRET");

      if (!wooKey || !wooSecret || !wooBase) {
        return json({
          found: false,
          message: "Store credentials are not configured for this client.",
        });
      }

      // Try the caller's value as given, then digits-only if it carried letters
      // — the same widening the Shopify branch does, for the same reason: a
      // customer reading "TSU#1749" off a confirmation when the store's own
      // number is "1749".
      let o: Record<string, any> | null = null;
      const attempts: Record<string, unknown>[] = [];
      for (const candidate of orderNumberCandidates(orderNumber)) {
        const { url, returnsList } = wooOrderUrl(wooBase, candidate, orderScheme);

        let wooRes: Response;
        try {
          wooRes = await fetch(url, {
            headers: { Authorization: basicAuth(wooKey, wooSecret) },
          });
        } catch (e) {
          console.error("woo fetch failed", String(e));
          return json(LOOKUP_ERROR);
        }

        // 404 means "no such order" only on the /orders/{id} form. The list
        // forms answer 200 with [].
        if (wooRes.status === 404) {
          attempts.push({ candidate, scheme: orderScheme, status: 404, returned: 0 });
          continue;
        }
        if (!wooRes.ok) {
          console.error("woo http error", wooRes.status);
          return json(LOOKUP_ERROR);
        }

        const payload = await wooRes.json().catch(() => null);
        // `search` is a full-text match and can return a NEIGHBOURING order, so
        // this insists on an exact hit rather than reading out a stranger's
        // order — the same guard as pickExactOrder on the Shopify side.
        const hit = pickWooOrder(payload, candidate, orderPrefix);
        const rows: Record<string, any>[] = Array.isArray(payload)
          ? payload
          : payload && typeof payload === "object"
            ? [payload]
            : [];
        attempts.push({
          candidate,
          scheme: orderScheme,
          status: wooRes.status,
          returned: rows.length,
          // Customer-facing number when the store has one, else the post id.
          numbers: rows
            .map((r) => String(r?.number ?? r?.id ?? ""))
            .filter(Boolean),
          hit: Boolean(hit),
        });
        if (hit) {
          o = hit;
          break;
        }
        void returnsList;
      }

      if (!o) {
        logNotFound({
          platform: "woocommerce",
          client_id: clientId,
          call_sid: callSid,
          heard: orderNumber,
          prefix: orderPrefix,
          // The scheme is the usual Woo culprit: `id` looks up the POST ID,
          // which is not the number the customer reads off their email.
          scheme: orderScheme,
          shop_host: hostOf(wooBase),
          key_source: wooKeySource,
          base_source: wooBaseSource,
          attempts,
        });
        return json(withWrap({
          found: false,
          order_not_found: true,
          message:
            "No order matched that number. Ask the caller to re-read it digit by digit; if it's the same number, don't keep asking — take their details for a callback.",
        }));
      }

      // Echo back what the STORE calls the order, not what the caller said —
      // and, critically, key orders_cache on it. Under the `id` scheme these
      // differ, so without this the same order lands in the cache twice.
      canonicalOrderNumber = shipStationOrderNumber(o, orderNumber);

      // ShipStation tracking (best-effort — missing shipping is not an error).
      let tracking: Record<string, any> | null = null;
      if (shipKey && shipSecret) {
        try {
          // ShipStation matches the CUSTOMER-FACING number, not Woo's post id.
          const ssNumber = shipStationOrderNumber(o, orderNumber);
          const ssRes = await fetch(
            `https://ssapi.shipstation.com/shipments?orderNumber=${encodeURIComponent(ssNumber)}`,
            { headers: { Authorization: basicAuth(shipKey, shipSecret) } },
          );
          if (ssRes.ok) {
            const ss = (await ssRes.json()) as Record<string, any>;
            // Skips voided labels and prefers the most recent one with tracking.
            tracking = pickShipment(ss.shipments) as Record<string, any> | null;
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

  // 4b) RECONCILE the conversation's order number to the store's canonical name.
  //
  //     The early ingest_call above wrote what the CALLER said, normalized —
  //     "TSU1749" for Tsunami, because normalizeOrderNumber strips the "#" as
  //     punctuation. orders_cache is keyed on the STORE's name, "TSU#1749". Those
  //     two disagreeing broke two things silently:
  //
  //       1. The dashboard's order panel joins orders_cache on the conversation's
  //          order_number, so it found nothing and showed no order context.
  //       2. voice-call-logger step 4 reads conversations.order_number, looks up
  //          orders_cache, and runs evaluate_flag on it. No row meant no
  //          evaluation, so a flagged order NEVER escalated after the call.
  //
  //     Invisible for clients whose order names are plain digits (normalized ==
  //     canonical), which is why it surfaced only once Tsunami's prefix landed.
  //
  //     ingest_call is idempotent on (client_id, external_ref) and its upsert is
  //     `coalesce(excluded.order_number, conversations.order_number)` — a non-null
  //     new value wins — so re-calling it is the supported way to correct this.
  if (callSid && canonicalOrderNumber && canonicalOrderNumber !== orderNumber) {
    const { error: reconcileErr } = await supabase.rpc("ingest_call", {
      p_client_id: clientId,
      p_call_sid: callSid,
      p_caller_identifier: body.caller_number ?? null,
      p_caller_name: body.caller_name ?? null,
      p_order_number: canonicalOrderNumber,
    });
    // Non-fatal: the caller still gets their answer. But log it, because the
    // dashboard and the post-call escalation both depend on this landing.
    if (reconcileErr) {
      console.error(
        "failed to reconcile conversation order_number",
        reconcileErr.message,
      );
    }
  }

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
    // Already converted to the store's timezone and worded for speech. The
    // agent must read THIS, not placed_at: the raw ISO is a UTC instant, and
    // reading its calendar date tells an evening caller their order was placed
    // tomorrow. See formatPlacedOn.
    placed_on: formatPlacedOn(n.order_placed_at, clientTimezone),
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
    // The escalation wording is config-driven. With the email channel paused,
    // sending a caller to a support inbox points them at something nobody is
    // reading — so the default takes their details and creates a callback
    // ticket, which is a plan feature ("no customer request disappears").
    // A client running a real inbox can set settings.escalation_mode = 'email'.
    message: flagged
      ? escalationMode === "email"
        ? "Order is flagged — give a holding answer and escalate (transfer in hours, else offer the support email)."
        : "Order is flagged — give a holding answer, take the caller's details and create a callback ticket. Do NOT give out an email address."
      : escalationMode === "email"
        ? "Answer the caller's question from these fields. Say dates using placed_on, not placed_at."
        : "Answer the caller's question from these fields. Say dates using placed_on, not placed_at. If you cannot resolve it, take details for a callback rather than referring them to email.",
    }),
  );
});
