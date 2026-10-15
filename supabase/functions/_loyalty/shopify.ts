// Shared by the loyalty edge functions: an Admin GraphQL call that stays
// under Shopify's cost-based rate limit and retries throttling and 5xx.
// (Folders starting with "_" are not deployed as functions.)

import { API_VERSION, isThrottled, throttleWaitMs } from "../loyalty-backfill/lib.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST a GraphQL document. Returns `data`; throws on HTTP errors and on
 * top-level GraphQL errors. userErrors inside `data` are the caller's to read.
 * shopBase: optional mock store (test only), `${shopBase}/<shop>/admin/...`.
 */
export async function shopifyGraphql(
  shop: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  shopBase = "",
): Promise<Record<string, unknown>> {
  const url = shopBase ? `${shopBase}/${shop}/admin/api/${API_VERSION}/graphql.json` : `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const j = (await res.json()) as { data?: Record<string, unknown>; errors?: unknown; extensions?: unknown };
    if (res.status !== 200) throw new Error(`Shopify ${res.status}: ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
    if (isThrottled(j.errors)) {
      await sleep(Math.max(throttleWaitMs(j.extensions), 2000));
      continue;
    }
    if (j.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(j.errors).slice(0, 300)}`);
    const wait = throttleWaitMs(j.extensions);
    if (wait > 0) await sleep(wait);
    return j.data ?? {};
  }
  throw new Error("Shopify kept throttling or failing after 5 attempts");
}
