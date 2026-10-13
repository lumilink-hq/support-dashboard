// =============================================================================
// loyalty-backfill — one time-boxed slice of a program's historical import
// (0201): customers (enroll account holders), then every paid order processed
// before the program went live (tier spend + order counts, 0 points).
//
//   POST /loyalty-backfill   header x-voice-tool-secret, body {"program_id"}
//
// Called every minute by pg_cron (run_due_loyalty_backfills) while the
// backfill is pending/running. Each call works ~100s, saves its cursor in
// loyalty_backfills after every page, and returns. Re-running a page is
// harmless: customers are upserts and orders are keyed.
//
// Start one with:  select start_loyalty_backfill('<program id>');
// Watch it with:   select * from loyalty_backfills;
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET; SHOPIFY_SHOP_BASE (optional, test only: mock store).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { API_VERSION, CUSTOMERS_QUERY, isThrottled, ORDERS_QUERY, ordersSearch, parseCustomersPage, parseOrdersPage, throttleWaitMs } from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");
const SHOP_BASE = (Deno.env.get("SHOPIFY_SHOP_BASE") ?? "").replace(/\/+$/, "");

const BUDGET_MS = 100_000;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Backfill = {
  program_id: string;
  status: string;
  phase: "customers" | "orders";
  cursor: string | null;
  before: string;
  customers_seen: number;
  members_synced: number;
  orders_seen: number;
  orders_counted: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gql(shop: string, token: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const url = SHOP_BASE ? `${SHOP_BASE}/${shop}/admin/api/${API_VERSION}/graphql.json` : `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
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
    const j = (await res.json()) as { data?: unknown; errors?: unknown; extensions?: unknown };
    if (res.status !== 200) throw new Error(`Shopify ${res.status}: ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
    if (isThrottled(j.errors)) {
      await sleep(Math.max(throttleWaitMs(j.extensions), 2000));
      continue;
    }
    if (j.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(j.errors).slice(0, 300)}`);
    const wait = throttleWaitMs(j.extensions);
    if (wait > 0) await sleep(wait);
    return j.data;
  }
  throw new Error("Shopify kept throttling or failing after 5 attempts");
}

async function save(b: Backfill, patch: Partial<Backfill> & { last_error?: string | null; finished_at?: string | null }) {
  const { error } = await supabase.from("loyalty_backfills").update(patch).eq("program_id", b.program_id);
  if (error) throw new Error(`saving backfill progress failed: ${error.message}`);
  Object.assign(b, patch);
}

async function slice(b: Backfill): Promise<Backfill> {
  const { data: tok, error } = await supabase.rpc("get_loyalty_shopify_token", { p_program: b.program_id });
  if (error) throw new Error(`token lookup failed: ${error.message}`);
  const { shop_domain: shop, access_token: token } = (tok ?? {}) as { shop_domain?: string; access_token?: string };
  if (!shop || !token) throw new Error("no installed Shopify token for this program");

  const started = Date.now();
  await save(b, { status: "running" });
  while (Date.now() - started < BUDGET_MS) {
    if (b.phase === "customers") {
      const p = parseCustomersPage(await gql(shop, token, CUSTOMERS_QUERY, { cursor: b.cursor }));
      const { data: n, error: e } = await supabase.rpc("loyalty_sync_customers", { p_program: b.program_id, p_customers: p.nodes });
      if (e) throw new Error(`loyalty_sync_customers: ${e.message}`);
      await save(b, {
        customers_seen: b.customers_seen + p.nodes.length,
        members_synced: b.members_synced + (n as number),
        ...(p.hasNext ? { cursor: p.cursor } : { phase: "orders", cursor: null }),
      });
    } else {
      const p = parseOrdersPage(await gql(shop, token, ORDERS_QUERY, { cursor: b.cursor, q: ordersSearch(b.before) }));
      const { data: counts, error: e } = await supabase.rpc("loyalty_record_orders", { p_program: b.program_id, p_orders: p.nodes, p_source: "backfill" });
      if (e) throw new Error(`loyalty_record_orders: ${e.message}`);
      await save(b, {
        orders_seen: b.orders_seen + p.nodes.length,
        orders_counted: b.orders_counted + ((counts as { recorded?: number })?.recorded ?? 0),
        cursor: p.hasNext ? p.cursor : b.cursor,
      });
      if (!p.hasNext) {
        await save(b, { status: "done", finished_at: new Date().toISOString(), last_error: null });
        break;
      }
    }
  }
  return b;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!VOICE_TOOL_SECRET || req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  let programId: string;
  try {
    programId = String(((await req.json()) as { program_id?: unknown }).program_id ?? "");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(programId)) return new Response("Bad request", { status: 400 });

  const { data, error } = await supabase.from("loyalty_backfills").select("*").eq("program_id", programId).maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "no backfill for this program; call start_loyalty_backfill first" }, { status: 404 });
  const b = data as Backfill;
  if (b.status === "done") return Response.json({ status: "done" });

  try {
    const after = await slice(b);
    console.log(`loyalty-backfill ${programId}: ${after.status} ${after.phase}, ${after.members_synced} members, ${after.orders_counted}/${after.orders_seen} orders`);
    return Response.json({ status: after.status, phase: after.phase, members_synced: after.members_synced, orders_seen: after.orders_seen, orders_counted: after.orders_counted });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`loyalty-backfill ${programId}: ${msg}`);
    await supabase.from("loyalty_backfills").update({ status: "error", last_error: msg.slice(0, 500) }).eq("program_id", programId);
    return Response.json({ error: msg }, { status: 500 });
  }
});
