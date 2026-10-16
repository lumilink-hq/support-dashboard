// =============================================================================
// loyalty-shopify — push LL Loyalty state into a store (0203).
//
//   POST /loyalty-shopify   header x-voice-tool-secret, body {"program_id"}
//
// One call does whatever is due, in this order, within ~45s:
//   1. metafield definitions (versioned, 0212): customer ll_loyalty.tier /
//      .points / .tier_spend_cents / .group, shop ll_loyalty.program
//   1b. the shop's ll_loyalty.program rules, when they changed (0212)
//   2. a segment per tier ('LL Tier <Name>' tag) for tiers that have perks
//   3. tier perks as automatic discounts limited to those segments
//      (config changed: delete the old discount, create the new one)
//   4. pending reward / referral codes -> discountCodeBasicCreate
//   5. order tags on paid orders that used our codes (0204; needs write_orders)
//   6. members whose tier, points, tier spend or group changed -> tier tag + metafields
//   7. bonus campaign and challenge scopes (0214, 0216): a collection's or tag's products
//   8. product types for new order-line products (0216) -> badges / challenges re-checked
// pg_cron (run_due_loyalty_shopify) calls it every minute, but only for
// programs with work. Everything is safe to repeat: a code that already
// exists in Shopify (an earlier attempt landed) is looked up, not duplicated.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET; SHOPIFY_SHOP_BASE (optional, test only: mock store).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { shopifyGraphql } from "../_loyalty/shopify.ts";
import { issueCode, type PendingCode } from "../_loyalty/codes.ts";
import {
  AUTOMATIC_BASIC_CREATE,
  AUTOMATIC_DELETE,
  FREE_SHIPPING_CREATE,
  METAFIELD_DEFINITION_CREATE,
  METAFIELD_DEFINITIONS,
  memberMetafields,
  METAFIELDS_SET,
  orderTagsMutation,
  type PerkRow,
  COLLECTION_PRODUCTS,
  perkDiscountInput,
  PRODUCT_TYPES,
  productGid,
  productIdFromGid,
  productTypeItems,
  programMetafield,
  SEGMENT_CREATE,
  SHOP_ID,
  TAG_PRODUCTS,
  tagSearch,
  tierSegmentQuery,
  tierTagsMutation,
  userErrorText,
} from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");
const SHOP_BASE = (Deno.env.get("SHOPIFY_SHOP_BASE") ?? "").replace(/\/+$/, "");

const BUDGET_MS = 45_000;
const TAG_BATCH = 10;       // members per aliased tagsAdd/tagsRemove request
const METAFIELD_BATCH = 6;  // members per metafieldsSet (4 metafields each, max 25)

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

type Ctx = { programId: string; shop: string; token: string; started: number; log: string[] };
const gql = (c: Ctx, query: string, variables: Record<string, unknown>) => shopifyGraphql(c.shop, c.token, query, variables, SHOP_BASE);
const timeLeft = (c: Ctx) => Date.now() - c.started < BUDGET_MS;
const now = () => new Date().toISOString();

type Work = {
  tiers: { id: string; key: string; name: string; rank: number; segment_id: string | null }[];
  segment_min_rank: number | null;
  perks: { id: string; is_active: boolean; discount_id: string | null; hash: string; config: PerkRow & { segment_ids: (string | null)[] } }[];
  definitions_needed: boolean;
  program_metafield: { hash: string; value: unknown } | null;
};

async function definitions(c: Ctx, w: Work) {
  if (!w.definitions_needed) return;
  for (const d of METAFIELD_DEFINITIONS) {
    const data = await gql(c, METAFIELD_DEFINITION_CREATE, { definition: d });
    const errs = (data.metafieldDefinitionCreate as { userErrors?: unknown })?.userErrors;
    // TAKEN: it already exists (a re-run, or created by hand) - fine.
    if (userErrorText(errs) && !(errs as { code?: string }[]).every((e) => e.code === "TAKEN")) {
      throw new Error(`metafield definition ${d.key}: ${userErrorText(errs)}`);
    }
  }
  await rpc("loyalty_definitions_done", { p_program: c.programId });
  c.log.push("definitions");
}

async function programRules(c: Ctx, w: Work) {
  if (!w.program_metafield) return;
  const shopGid = String(((await gql(c, SHOP_ID, {})).shop as { id?: string } | undefined)?.id ?? "");
  if (!shopGid) throw new Error("shop id not returned");
  const data = await gql(c, METAFIELDS_SET, { metafields: [programMetafield(shopGid, w.program_metafield.value)] });
  const err = userErrorText((data.metafieldsSet as { userErrors?: unknown })?.userErrors);
  if (err) throw new Error(`program metafield: ${err}`);
  await rpc("loyalty_program_metafield_synced", { p_program: c.programId, p_hash: w.program_metafield.hash });
  c.log.push("program rules");
}

async function segments(c: Ctx, w: Work): Promise<boolean> {
  if (w.segment_min_rank === null) return false;
  let made = false;
  for (const t of w.tiers) {
    if (t.rank < w.segment_min_rank || t.segment_id) continue;
    const data = await gql(c, SEGMENT_CREATE, { name: `LL Loyalty: ${t.name}`, query: tierSegmentQuery([t.name]) });
    const r = data.segmentCreate as { segment?: { id: string } | null; userErrors?: unknown };
    if (!r?.segment?.id) throw new Error(`segment for ${t.name}: ${userErrorText(r?.userErrors) || "no id returned"}`);
    await rpc("loyalty_set_tier_segment", { p_tier: t.id, p_segment_id: r.segment.id });
    made = true;
  }
  if (made) c.log.push("segments");
  return made;
}

async function perks(c: Ctx, w: Work) {
  for (const p of w.perks) {
    if (!timeLeft(c)) return;
    let live = p.discount_id; // what exists in Shopify right now
    try {
      if (live) {
        const data = await gql(c, AUTOMATIC_DELETE, { id: live });
        const errs = (data.discountAutomaticDelete as { userErrors?: unknown })?.userErrors;
        // Already gone (deleted by hand in Shopify) is fine.
        if (userErrorText(errs) && !/not exist|not found/i.test(userErrorText(errs))) throw new Error(`delete: ${userErrorText(errs)}`);
        live = null;
      }
      if (!p.is_active) {
        await rpc("loyalty_perk_synced", { p_perk: p.id, p_discount_id: null, p_hash: null, p_error: null });
        continue;
      }
      const segs = p.config.segment_ids;
      if (segs.length === 0 || segs.some((s) => !s)) throw new Error("tier segment not created yet");
      const input = perkDiscountInput(p.config, segs as string[], now());
      const data = await gql(c, p.config.kind === "free_shipping" ? FREE_SHIPPING_CREATE : AUTOMATIC_BASIC_CREATE, { input });
      const r = (data.discountAutomaticFreeShippingCreate ?? data.discountAutomaticBasicCreate) as
        { automaticDiscountNode?: { id: string } | null; userErrors?: unknown };
      if (!r?.automaticDiscountNode?.id) throw new Error(userErrorText(r?.userErrors) || "no id returned");
      await rpc("loyalty_perk_synced", { p_perk: p.id, p_discount_id: r.automaticDiscountNode.id, p_hash: p.hash, p_error: null });
      c.log.push(`perk ${p.config.key}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Record what's really live: the old discount if its delete failed, else none.
      await rpc("loyalty_perk_synced", { p_perk: p.id, p_discount_id: live, p_hash: null, p_error: msg });
      console.error(`loyalty-shopify ${c.shop}: perk ${p.config.key}: ${msg}`);
    }
  }
}

async function codes(c: Ctx) {
  const rows = await rpc<PendingCode[]>("loyalty_codes_to_issue", { p_program: c.programId, p_limit: 25 });
  let issued = 0;
  for (const row of rows) {
    if (!timeLeft(c)) break;
    const r = await issueCode(supabase, c.shop, c.token, row, SHOP_BASE);
    if (r.ok) issued++;
    else console.error(`loyalty-shopify ${c.shop}: code ${row.id}${r.final ? " FAILED (points returned)" : ""}: ${r.error}`);
  }
  if (issued) c.log.push(`${issued} codes`);
}

const ORDER_TAG_BATCH = 10;

async function orderTags(c: Ctx) {
  const rows = await rpc<{ order_id: number; tags: string[] }[]>("loyalty_order_tags_to_apply", { p_program: c.programId, p_limit: 50 });
  let done = 0;
  for (let i = 0; i < rows.length && timeLeft(c); i += ORDER_TAG_BATCH) {
    const batch = rows.slice(i, i + ORDER_TAG_BATCH);
    let results: (string | null)[];
    try {
      const { query, variables } = orderTagsMutation(batch.map((r) => ({ orderId: r.order_id, tags: r.tags })));
      const data = await gql(c, query, variables);
      results = batch.map((_, j) => userErrorText((data[`o${j}`] as { userErrors?: unknown })?.userErrors) || null);
    } catch (e) {
      results = batch.map(() => e instanceof Error ? e.message : String(e));
    }
    for (const [j, r] of batch.entries()) {
      await rpc("loyalty_order_tags_result", { p_program: c.programId, p_order_id: r.order_id, p_error: results[j] });
      if (!results[j]) done++;
    }
  }
  if (done) c.log.push(`${done} order tags`);
}

const MAX_CAMPAIGN_PAGES = 20; // 5,000 products per campaign or challenge scope

// Campaign (0214) and tagged-product challenge (0216) scopes: same lookup,
// different tables.
const SCOPES = {
  campaign: { due: "loyalty_campaigns_to_resolve", done: "loyalty_campaign_resolved", idArg: "p_campaign" },
  challenge: { due: "loyalty_challenges_to_resolve", done: "loyalty_challenge_resolved", idArg: "p_challenge" },
} as const;

async function scopeProducts(c: Ctx, kind: keyof typeof SCOPES) {
  const s = SCOPES[kind];
  const due = await rpc<{ id: string; collection_gid: string | null; product_tag: string | null }[]>(s.due, { p_program: c.programId });
  for (const camp of due) {
    if (!timeLeft(c)) return;
    try {
      const ids: number[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_CAMPAIGN_PAGES; page++) {
        const data: Record<string, unknown> = camp.collection_gid
          ? await gql(c, COLLECTION_PRODUCTS, { id: camp.collection_gid, after })
          : await gql(c, TAG_PRODUCTS, { query: tagSearch(camp.product_tag ?? ""), after });
        const conn = (camp.collection_gid
          ? (data.collection as { products?: unknown } | null)?.products
          : data.products) as { nodes?: { id?: string }[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } | undefined;
        if (!conn) throw new Error(camp.collection_gid ? `collection ${camp.collection_gid} not found` : "products query returned nothing");
        for (const n of conn.nodes ?? []) {
          const id = productIdFromGid(n.id);
          if (id) ids.push(id);
        }
        if (!conn.pageInfo?.hasNextPage) {
          after = null;
          break;
        }
        after = conn.pageInfo.endCursor ?? null;
      }
      if (after) throw new Error(`more than ${MAX_CAMPAIGN_PAGES * 250} products in scope`);
      await rpc(s.done, { [s.idArg]: camp.id, p_product_ids: ids, p_error: null });
      c.log.push(`${kind} ${camp.id}: ${ids.length} products`);
    } catch (e) {
      await rpc(s.done, { [s.idArg]: camp.id, p_product_ids: null, p_error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// Product types of products seen on order lines (0216); fetching them
// re-evaluates the members who bought them (badges, challenges).
async function productTypes(c: Ctx) {
  while (timeLeft(c)) {
    const ids = await rpc<number[]>("loyalty_products_to_fetch", { p_program: c.programId, p_limit: 250 });
    if (!ids.length) return;
    const data = await gql(c, PRODUCT_TYPES, { ids: ids.map(productGid) });
    const n = await rpc<number>("loyalty_products_fetched", { p_program: c.programId, p_items: productTypeItems(ids, data.nodes) });
    c.log.push(`${ids.length} product types (${n} members re-checked)`);
  }
}

type SyncMember = {
  member_id: string; customer_id: number; tier_key: string; tier_name: string; points: number;
  tier_spend_cents: number; group: string; tier_changed: boolean;
};

async function members(c: Ctx) {
  const { tier_names, members } = await rpc<{ tier_names: string[]; members: SyncMember[] }>(
    "loyalty_members_to_sync", { p_program: c.programId, p_limit: 120 });
  const errors = new Map<string, string>();

  const tagging = members.filter((m) => m.tier_changed);
  for (let i = 0; i < tagging.length && timeLeft(c); i += TAG_BATCH) {
    const batch = tagging.slice(i, i + TAG_BATCH);
    try {
      const { query, variables } = tierTagsMutation(batch.map((m) => ({ customerId: m.customer_id, tierName: m.tier_name })), tier_names);
      const data = await gql(c, query, variables);
      batch.forEach((m, j) => {
        const err = userErrorText((data[`a${j}`] as { userErrors?: unknown })?.userErrors) ||
          userErrorText((data[`r${j}`] as { userErrors?: unknown })?.userErrors);
        if (err) errors.set(m.member_id, `tags: ${err}`);
      });
    } catch (e) {
      batch.forEach((m) => errors.set(m.member_id, `tags: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  const pushed: SyncMember[] = [];
  for (let i = 0; i < members.length && timeLeft(c); i += METAFIELD_BATCH) {
    const batch = members.slice(i, i + METAFIELD_BATCH);
    pushed.push(...batch);
    try {
      const data = await gql(c, METAFIELDS_SET, {
        metafields: memberMetafields(batch.map((m) => ({
          customerId: m.customer_id, tierName: m.tier_name, points: m.points, tierSpendCents: m.tier_spend_cents, group: m.group,
        }))),
      });
      const err = userErrorText((data.metafieldsSet as { userErrors?: unknown })?.userErrors);
      if (err) batch.forEach((m) => errors.set(m.member_id, `metafields: ${err}`));
    } catch (e) {
      batch.forEach((m) => errors.set(m.member_id, `metafields: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  if (pushed.length) {
    await rpc("loyalty_mark_members_synced", {
      p_items: pushed.map((m) => ({
        member_id: m.member_id, tier_key: m.tier_key, points: m.points, tier_spend_cents: m.tier_spend_cents, group: m.group,
        error: errors.get(m.member_id) ?? null,
      })),
    });
    c.log.push(`${pushed.length - errors.size}/${pushed.length} members`);
  }
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

  try {
    const tok = await rpc<{ shop_domain?: string; access_token?: string } | null>("get_loyalty_shopify_token", { p_program: programId });
    if (!tok?.shop_domain || !tok.access_token) return Response.json({ error: "no installed Shopify token for this program" }, { status: 404 });
    const c: Ctx = { programId, shop: tok.shop_domain, token: tok.access_token, started: Date.now(), log: [] };

    let w = await rpc<Work>("loyalty_shopify_work", { p_program: programId });
    await definitions(c, w);
    await programRules(c, w);
    if (await segments(c, w)) w = await rpc<Work>("loyalty_shopify_work", { p_program: programId }); // segment ids feed the perk hash
    await perks(c, w);
    if (timeLeft(c)) await codes(c);
    if (timeLeft(c)) await orderTags(c);
    if (timeLeft(c)) await members(c);
    if (timeLeft(c)) await scopeProducts(c, "campaign");
    if (timeLeft(c)) await scopeProducts(c, "challenge");
    if (timeLeft(c)) await productTypes(c);

    console.log(`loyalty-shopify ${c.shop}: ${c.log.join(", ") || "nothing to do"} (${Date.now() - c.started}ms)`);
    return Response.json({ ok: true, did: c.log });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`loyalty-shopify ${programId}: ${msg}`);
    return Response.json({ error: msg }, { status: 500 });
  }
});
