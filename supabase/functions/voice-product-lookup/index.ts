// =============================================================================
// voice-product-lookup — the `lookup_product` agent tool.
//
// Answers "do you carry X", "what does X cost", "is the 14g in stock" from
// products_cache (0018), NOT from Shopify. The cache is refreshed out of band by
// shopify-product-sync. Reading Postgres costs tens of milliseconds; a live
// Shopify GraphQL call costs hundreds, and on voice that gap is the product.
//
// Routing mirrors voice-order-lookup exactly: phone resolves by dialed number,
// web by client slug behind the web_lookup_enabled opt-in.
//
// NO CALLER VERIFICATION HERE, deliberately. Product data is public — it's on
// the storefront. The verification gate on the ORDER path exists because order
// data is personal; applying it to a catalogue question would just make the
// agent interrogate someone for asking a price.
//
//   POST /voice-product-lookup
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { called_number, client_ref, product_query, call_sid, conversation_id }
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  buildProductResponse,
  extractClientRef,
  normalizeProductQuery,
  type ProductLookupResponse,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)[
  "default"
];
if (!SERVICE_ROLE_SECRET) {
  throw new Error("SUPABASE_SECRET_KEYS['default'] (service role) not found.");
}

const MAX_MATCHES = 3; // more than three read aloud is unlistenable

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", Connection: "keep-alive" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (VOICE_TOOL_SECRET) {
    if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
      return json({ error: "Unauthorized" }, 401);
    }
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { calledNumber, clientSlug } = extractClientRef(body);
  if (!calledNumber && !clientSlug) {
    return json({ error: "Missing called_number or client_ref" }, 400);
  }

  const query = normalizeProductQuery(
    body.product_query ?? body.product_name ?? body.query,
  );

  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Resolve the tenant.
  let clientId: string | null = null;
  if (calledNumber) {
    const { data, error } = await supabase.rpc("resolve_client_by_number", {
      p_called_number: calledNumber,
    });
    if (error) return json({ error: error.message }, 400);
    clientId = (data as string | null) ?? null;
    if (!clientId) {
      return json({
        found: false,
        message: "This phone line isn't configured for a store.",
      } satisfies ProductLookupResponse);
    }
  } else {
    // WEB PATH. A slug sits in public page HTML, so it's an identifier and never
    // a credential. Same opt-in gate as the order lookup.
    const { data: row, error: slugErr } = await supabase
      .from("clients")
      .select("id, is_active, settings")
      .eq("slug", clientSlug)
      .maybeSingle();
    if (slugErr) return json({ error: slugErr.message }, 400);
    if (!row || row.is_active === false) {
      return json({
        found: false,
        message: "This demo isn't configured.",
      } satisfies ProductLookupResponse);
    }
    const settings = (row.settings ?? {}) as Record<string, unknown>;
    if (
      settings.web_lookup_enabled !== true &&
      settings.is_demo !== true
    ) {
      return json({
        found: false,
        message: "Product lookup isn't available on this channel.",
      } satisfies ProductLookupResponse);
    }
    clientId = row.id as string;
  }

  // 2) Usage limiter, layer 3 — same as the order path. A call that began under
  //    the cap and crossed it mid-conversation gets told to wrap up rather than
  //    cut off. Without this here, a caller who only asks product questions
  //    would never receive the signal. Failure is swallowed: a metering problem
  //    must not cost the caller their answer.
  let wrapUp = false;
  {
    const { data: allowance, error: allowErr } = await supabase.rpc(
      "check_voice_allowance",
      { p_client_id: clientId },
    );
    if (allowErr) {
      console.error("check_voice_allowance failed (continuing):", allowErr.message);
    } else {
      wrapUp = allowance ? allowance.allowed === false : false;
    }
  }

  const withWrap = (r: ProductLookupResponse): ProductLookupResponse =>
    wrapUp
      ? {
          ...r,
          wrap_up: true,
          message: `${r.message ?? ""} This line has reached its usage limit — give the answer you have, then close the call politely.`.trim(),
        }
      : r;

  // 3) No product named yet -> ask, don't search.
  if (!query) {
    return json(
      withWrap({
        found: false,
        need_product_name: true,
        message: "Ask the caller which product they mean.",
      }),
    );
  }

  // 4) Search the cache. search_products reports its own freshness; the response
  //    builder is what decides whether stock may be spoken.
  const { data: rpc, error: rpcErr } = await supabase.rpc("search_products", {
    p_client_id: clientId,
    p_query: query,
    p_limit: MAX_MATCHES,
  });

  if (rpcErr) {
    console.error("search_products failed:", rpcErr.message);
    return json(
      withWrap({
        found: false,
        catalog_unavailable: true,
        message:
          "Product lookup failed. Do NOT guess. Offer to have a teammate follow up.",
      }),
    );
  }

  return json(withWrap(buildProductResponse(rpc)));
});
