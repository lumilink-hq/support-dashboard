// =============================================================================
// shopify-product-sync — pull a client's catalog into products_cache.
//
// NOT called mid-conversation. The agent reads products_cache (via
// search_products) in tens of milliseconds; this function is what keeps that
// table honest. Run it on a schedule, and after a catalog change.
//
//   POST /shopify-product-sync
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "client_slug": "shopify-store" }   (or { "client_id": "<uuid>" })
//
// Admin endpoint, so it does NOT apply the web_lookup_enabled / is_demo guard
// the caller-facing functions use — the shared secret is the whole gate. It
// never accepts a tenant from an unauthenticated caller.
//
// PRUNING: after a COMPLETE pass it deletes rows the pass didn't touch, so a
// product archived in Shopify stops being offered. On a partial pass (any page
// failing) it skips the prune, because deleting everything the sync never
// reached would empty the catalog.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  PRODUCTS_QUERY,
  isThrottled,
  pickShopifyCreds,
  productsPageFrom,
  shopifyErrorFrom,
  shopifyGraphqlUrl,
  throttleWaitMs,
  type ProductRow,
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

const MAX_PAGES = 40; // 40 x 50 = 2000 products. Guard against a cursor loop.
const MAX_THROTTLE_RETRIES = 4;

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!VOICE_TOOL_SECRET) {
    console.error("VOICE_TOOL_SECRET unset — refusing to run");
    return json({ error: "Server not configured" }, 500);
  }
  if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const clientSlug = String(body.client_slug ?? "").trim();
  const clientIdIn = String(body.client_id ?? "").trim();
  if (!clientSlug && !clientIdIn) {
    return json({ error: "client_slug or client_id is required" }, 400);
  }

  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Resolve the tenant.
  let clientId = clientIdIn;
  let platform = "";
  let storeBaseUrl = "";
  {
    const q = supabase.from("clients").select("id, slug, store_platform, store_base_url");
    const { data, error } = clientIdIn
      ? await q.eq("id", clientIdIn).maybeSingle()
      : await q.eq("slug", clientSlug).maybeSingle();
    if (error) return json({ error: error.message }, 400);
    if (!data) return json({ error: "unknown_client" }, 404);
    clientId = data.id as string;
    platform = String(data.store_platform ?? "").toLowerCase();
    storeBaseUrl = String(data.store_base_url ?? "");
  }

  if (platform !== "shopify") {
    return json(
      { error: `unsupported_platform`, platform, note: "This sync is Shopify-only." },
      400,
    );
  }
  if (!storeBaseUrl) {
    return json({ error: "client has no store_base_url" }, 400);
  }

  // 2) Credentials out of Vault. Note the key-naming trap handled in
  //    pickShopifyCreds — the RPC labels Shopify creds "woocommerce".
  const { data: secrets, error: secErr } = await supabase.rpc(
    "get_client_integration_secrets",
    { p_client_id: clientId },
  );
  if (secErr) return json({ error: secErr.message }, 400);

  const creds = pickShopifyCreds(secrets as Record<string, unknown>);
  if (!creds.access_token) {
    return json({ error: "no_shopify_credentials" }, 400);
  }
  const endpoint = shopifyGraphqlUrl(creds.base_url || storeBaseUrl);

  // Marks this pass. Anything older than this after a complete run is gone from
  // Shopify and should leave the cache.
  const syncStartedAt = new Date().toISOString();

  let cursor: string | null = null;
  let pages = 0;
  let upserted = 0;
  let fetched = 0;
  let complete = false;
  const warnings: string[] = [];

  try {
    while (pages < MAX_PAGES) {
      let pageBody: Record<string, any> | null = null;

      // 3) Fetch one page, retrying only on throttling.
      for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": creds.access_token!,
          },
          body: JSON.stringify({
            query: PRODUCTS_QUERY,
            variables: { cursor },
          }),
        });

        // 401/403 are terminal: the token is wrong or under-scoped.
        if (res.status === 401 || res.status === 403) {
          return json(
            { error: "shopify_unauthorized", status: res.status },
            502,
          );
        }

        const text = await res.text();
        try {
          pageBody = JSON.parse(text);
        } catch {
          return json({ error: "shopify_unparseable_response" }, 502);
        }

        if (isThrottled(pageBody)) {
          if (attempt === MAX_THROTTLE_RETRIES) {
            warnings.push("gave up after repeated throttling");
            pageBody = null;
            break;
          }
          await sleep(throttleWaitMs(pageBody, attempt));
          continue;
        }
        break;
      }

      if (!pageBody) break; // throttled out; leave `complete` false

      // Shopify returns 200 for query errors, so the body decides.
      const err = shopifyErrorFrom(pageBody);
      if (err) {
        console.error("shopify error during product sync:", err);
        return json({ error: "shopify_error", detail: err }, 502);
      }

      const { rows, cursor: next, hasNext } = productsPageFrom(pageBody.data ?? null);
      fetched += rows.length;
      pages++;

      // 4) Write the page. One RPC per page, not per product.
      if (rows.length) {
        const { data: up, error: upErr } = await supabase.rpc("upsert_products", {
          p_client_id: clientId,
          p_products: rows as unknown as ProductRow[],
        });
        if (upErr) {
          console.error("upsert_products failed:", upErr.message);
          return json({ error: "upsert_failed", detail: upErr.message }, 500);
        }
        if (up?.ok === false) {
          return json({ error: "upsert_rejected", detail: up.error }, 400);
        }
        upserted += Number(up?.upserted ?? 0);
      }

      if (!hasNext) {
        complete = true;
        break;
      }
      cursor = next;
    }

    if (pages >= MAX_PAGES && !complete) {
      warnings.push(`stopped at the ${MAX_PAGES}-page ceiling`);
    }

    // 5) Prune ONLY after a full pass. A partial pass would delete everything
    //    the sync never got to.
    let pruned: number | null = null;
    if (complete) {
      const { data: pr, error: prErr } = await supabase.rpc("prune_products", {
        p_client_id: clientId,
        p_synced_before: syncStartedAt,
      });
      if (prErr) {
        warnings.push(`prune failed: ${prErr.message}`);
      } else {
        pruned = Number(pr?.pruned ?? 0);
      }
    } else {
      warnings.push("incomplete pass — skipped prune to avoid emptying the cache");
    }

    return json({
      ok: true,
      client_id: clientId,
      complete,
      pages,
      fetched,
      upserted,
      pruned,
      synced_at: syncStartedAt,
      warnings,
    });
  } catch (e) {
    // Never let a stack trace carrying a URL or header reach the response.
    console.error("product sync crashed:", String(e));
    return json({ error: "sync_failed" }, 500);
  }
});
