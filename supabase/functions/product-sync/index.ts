// =============================================================================
// product-sync — pull a client's catalog into products_cache. Shopify or Woo.
//
// NOT called mid-conversation. The agent reads products_cache (via
// search_products) in tens of milliseconds; this function is what keeps that
// table honest. Run it on a schedule, and after a catalog change.
//
//   POST /product-sync
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "client_slug": "shopify-store" }   (or { "client_id": "<uuid>" })
//
// The platform comes from clients.store_platform; callers never choose it. Both
// adapters produce the same ProductRow (see types.ts), so everything downstream
// — upsert_products, search_products, voice-product-lookup, the agent prompt —
// is identical regardless of which store answered.
//
// Renamed from `shopify-product-sync` when the Woo adapter landed. If you have
// the old function deployed, delete it after deploying this one, or a stale
// scheduled call will keep hitting a Shopify-only build.
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
} from "./shopify.ts";
import {
  needsVariations,
  pickWooCreds,
  WOO_PER_PAGE,
  wooCurrencyFrom,
  wooProductsPageFrom,
  wooProductsUrl,
  wooSettingsUrl,
  wooTotalPages,
  wooVariationsUrl,
} from "./woo.ts";
import {
  STORE_API_PER_PAGE,
  storeProductsPageFrom,
  storeProductsUrl,
  storeTotalPages,
} from "./woo-store.ts";
import type { ProductRow } from "./types.ts";

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

  // `woocommerce` is the historical default for a client row whose platform was
  // never set (voice-order-lookup makes the same assumption), but a catalog sync
  // against a guess is worse than an error: it would authenticate nowhere and
  // report an empty catalog, which then reads as "we don't sell that".
  if (platform !== "shopify" && platform !== "woocommerce") {
    return json(
      {
        error: "unsupported_platform",
        platform: platform || null,
        note: "Set clients.store_platform to 'shopify' or 'woocommerce'.",
      },
      400,
    );
  }
  if (!storeBaseUrl) {
    return json({ error: "client has no store_base_url" }, 400);
  }

  // 2) Credentials out of Vault. Note the key-naming trap handled in
  //    pickShopifyCreds — the RPC labels the store blob "woocommerce" on BOTH
  //    platforms, because it predates Shopify.
  const { data: secrets, error: secErr } = await supabase.rpc(
    "get_client_integration_secrets",
    { p_client_id: clientId },
  );
  if (secErr) return json({ error: secErr.message }, 400);

  // Marks this pass. Anything older than this after a complete run is gone from
  // the store and should leave the cache.
  const syncStartedAt = new Date().toISOString();

  let pages = 0;
  let upserted = 0;
  let fetched = 0;
  let complete = false;
  const warnings: string[] = [];
  // Which API actually answered. Reported back and worth logging: a client
  // silently running on the public Store API explains "why can't it tell me how
  // many are left" without anyone having to guess.
  let source = platform === "shopify" ? "shopify_admin_graphql" : "woocommerce_rest";

  // ---------------------------------------------------------------------------
  // The pager. Each platform gets one function that returns the next page of
  // ProductRows and says whether more remain; everything after this point —
  // upserting, counting, pruning, the response — is shared. This is the seam
  // that keeps a future third platform from turning into a third copy of the
  // write-and-prune logic.
  //
  // A pager returns null to mean "could not fetch this page, stop but do NOT
  // treat the pass as complete" (which suppresses the prune). It throws a
  // SyncFailure for terminal conditions the caller should surface verbatim.
  // ---------------------------------------------------------------------------
  type Page = { rows: ProductRow[]; hasNext: boolean };
  class SyncFailure extends Error {
    constructor(readonly payload: Record<string, unknown>, readonly status: number) {
      super(String(payload.error ?? "sync_failed"));
    }
  }

  let pager: (pageIndex: number) => Promise<Page | null>;

  if (platform === "shopify") {
    const creds = pickShopifyCreds(secrets as Record<string, unknown>);
    if (!creds.access_token) {
      return json({ error: "no_shopify_credentials" }, 400);
    }
    const endpoint = shopifyGraphqlUrl(creds.base_url || storeBaseUrl);
    let cursor: string | null = null;

    pager = async () => {
      let pageBody: Record<string, any> | null = null;

      // Fetch one page, retrying only on throttling.
      for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": creds.access_token!,
          },
          body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor } }),
        });

        // 401/403 are terminal: the token is wrong or under-scoped.
        if (res.status === 401 || res.status === 403) {
          throw new SyncFailure(
            { error: "shopify_unauthorized", status: res.status },
            502,
          );
        }

        const text = await res.text();
        try {
          pageBody = JSON.parse(text);
        } catch {
          throw new SyncFailure({ error: "shopify_unparseable_response" }, 502);
        }

        if (isThrottled(pageBody)) {
          if (attempt === MAX_THROTTLE_RETRIES) {
            warnings.push("gave up after repeated throttling");
            return null;
          }
          await sleep(throttleWaitMs(pageBody, attempt));
          continue;
        }
        break;
      }

      if (!pageBody) return null;

      // Shopify returns 200 for query errors, so the body decides.
      const err = shopifyErrorFrom(pageBody);
      if (err) {
        console.error("shopify error during product sync:", err);
        throw new SyncFailure({ error: "shopify_error", detail: err }, 502);
      }

      const { rows, cursor: next, hasNext } = productsPageFrom(pageBody.data ?? null);
      cursor = next;
      return { rows, hasNext };
    };
  } else {
    // ---- WooCommerce -------------------------------------------------------
    // Two sources, same ProductRow output:
    //   • /wc/v3    — authenticated. Exact stock counts, per-variant prices.
    //   • /wc/store — public. No credentials, no counts.
    // Prefer the authenticated one when a key exists; otherwise fall back to the
    // public Store API rather than failing. A client with no key still gets a
    // working catalog, and a REVOKED key degrades to correct-but-coarse instead
    // of going stale — which matters because 0021's stock_policy='always' means
    // a stale catalog is quoted with full confidence.
    const creds = pickWooCreds(secrets as Record<string, unknown>);
    const wooBase = creds.base_url || storeBaseUrl;
    const requestedSource = String(body.source ?? "").trim().toLowerCase();
    const hasKeys = Boolean(creds.consumer_key && creds.consumer_secret);
    const usePublic = requestedSource === "public" || !hasKeys;

    if (requestedSource === "auth" && !hasKeys) {
      return json({ error: "no_woocommerce_credentials" }, 400);
    }

    if (usePublic) {
      source = "woocommerce_store_api";
      if (!hasKeys) {
        warnings.push(
          "no REST key for this client — synced from the public Store API " +
            "(no exact stock counts, no per-variant prices)",
        );
      }
      let totalPages: number | null = null;

      pager = async (pageIndex: number) => {
        const page = pageIndex + 1;
        const res = await fetch(storeProductsUrl(wooBase, page), {
          headers: { Accept: "application/json" },
        });

        // Past the last page the Store API answers 400, not an empty list.
        if (res.status === 400 && totalPages !== null && page > totalPages) {
          return { rows: [], hasNext: false };
        }
        if (res.status === 404) {
          throw new SyncFailure(
            {
              error: "store_api_unavailable",
              note:
                "No /wp-json/wc/store/v1 on this host. Either WooCommerce Blocks " +
                "is disabled or /wp-json is not routed (permalinks set to Plain).",
            },
            502,
          );
        }
        if (!res.ok) {
          throw new SyncFailure({ error: "store_api_http_error", status: res.status }, 502);
        }
        if (totalPages === null) totalPages = storeTotalPages(res.headers);

        let payload: unknown;
        try {
          payload = await res.json();
        } catch {
          throw new SyncFailure({ error: "store_api_unparseable_response" }, 502);
        }

        const list = Array.isArray(payload) ? payload : [];
        const { rows } = storeProductsPageFrom(payload);
        const hasNext =
          totalPages !== null ? page < totalPages : list.length === STORE_API_PER_PAGE;
        return { rows, hasNext };
      };
    } else {
    source = "woocommerce_rest";

    const auth =
      "Basic " + btoa(`${creds.consumer_key}:${creds.consumer_secret}`);
    const wooHeaders = { Authorization: auth, "Content-Type": "application/json" };

    // Woo has ONE store currency and does not repeat it per product. Fetched
    // once here rather than per page; a failure is not fatal because a price
    // without a currency is still a usable answer ("nineteen ninety-nine").
    let currency = "USD";
    try {
      const cRes = await fetch(wooSettingsUrl(wooBase), { headers: wooHeaders });
      if (cRes.ok) currency = wooCurrencyFrom(await cRes.json());
      else warnings.push(`could not read store currency (http ${cRes.status})`);
    } catch {
      warnings.push("could not read store currency");
    }

    // Woo reports the page count in a HEADER, so the first response is what
    // tells us where the end is.
    let totalPages: number | null = null;

    pager = async (pageIndex: number) => {
      const page = pageIndex + 1; // Woo pages are 1-based
      const res = await fetch(wooProductsUrl(wooBase, page), { headers: wooHeaders });

      if (res.status === 401 || res.status === 403) {
        throw new SyncFailure({ error: "woo_unauthorized", status: res.status }, 502);
      }
      // Asking past the last page is a 400 with code rest_invalid_param, not an
      // empty list. Treat it as a clean end rather than an error.
      if (res.status === 400 && totalPages !== null && page > totalPages) {
        return { rows: [], hasNext: false };
      }
      if (!res.ok) {
        throw new SyncFailure({ error: "woo_http_error", status: res.status }, 502);
      }

      if (totalPages === null) totalPages = wooTotalPages(res.headers);

      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        throw new SyncFailure({ error: "woo_unparseable_response" }, 502);
      }

      const list = Array.isArray(payload) ? payload : [];

      // Variable products need a second request each for their variations —
      // that's where per-size price and stock live, and "is the 3.5g in stock"
      // is the most common product question there is. Sequential on purpose:
      // a burst of parallel requests is the fastest way to get rate-limited by
      // a WordPress host, and this is a background job with no caller waiting.
      const variationsById: Record<string, Record<string, any>[]> = {};
      for (const node of list) {
        if (!needsVariations(node)) continue;
        try {
          const vRes = await fetch(wooVariationsUrl(wooBase, node.id), {
            headers: wooHeaders,
          });
          if (vRes.ok) {
            const vs = await vRes.json();
            if (Array.isArray(vs)) variationsById[String(node.id)] = vs;
          } else {
            warnings.push(`variations http ${vRes.status} for product ${node.id}`);
          }
        } catch {
          // Fall back to the parent's own price/stock rather than dropping the
          // product: a product with a coarse answer beats a missing one.
          warnings.push(`variations fetch failed for product ${node.id}`);
        }
      }

      const { rows } = wooProductsPageFrom(payload, { currency, variationsById });

      // Without the header we cannot prove we reached the end, so stop only on
      // a short/empty page and leave `complete` to the caller's own check.
      const hasNext =
        totalPages !== null ? page < totalPages : list.length === WOO_PER_PAGE;
      return { rows, hasNext };
    };
    }
  }

  try {
    while (pages < MAX_PAGES) {
      // 3) Fetch one page through the platform's pager.
      const page = await pager(pages);
      if (!page) break; // could not fetch; leave `complete` false

      const { rows, hasNext } = page;
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
      platform,
      source,
      complete,
      pages,
      fetched,
      upserted,
      pruned,
      synced_at: syncStartedAt,
      warnings,
    });
  } catch (e) {
    // A pager's terminal condition — surface it as it was raised.
    if (e instanceof SyncFailure) return json(e.payload, e.status);
    // Never let a stack trace carrying a URL or header reach the response.
    console.error("product sync crashed:", String(e));
    return json({ error: "sync_failed" }, 500);
  }
});
