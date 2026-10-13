// =============================================================================
// loyalty-shopify — push LL Loyalty state into a store (0203).
//
//   POST /loyalty-shopify   header x-voice-tool-secret, body {"program_id"}
//
// One call does whatever is due, in this order, within ~45s:
//   1. customer metafield definitions ll_loyalty.tier / .points (once)
//   2. a segment per tier ('LL Tier <Name>' tag) for tiers that have perks
//   3. tier perks as automatic discounts limited to those segments
//      (config changed: delete the old discount, create the new one)
//   4. pending reward / referral codes -> discountCodeBasicCreate
//   5. members whose tier or points changed -> tier tag + metafields
// pg_cron (run_due_loyalty_shopify) calls it every minute, but only for
// programs with work. Everything is safe to repeat: a code that already
// exists in Shopify (an earlier attempt landed) is looked up, not duplicated.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET; SHOPIFY_SHOP_BASE (optional, test only: mock store).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { shopifyGraphql } from "../_loyalty/shopify.ts";
import {
  AUTOMATIC_BASIC_CREATE,
  AUTOMATIC_DELETE,
  CODE_BASIC_CREATE,
  CODE_LOOKUP,
  type CodeRow,
  codeDiscountInput,
  FREE_SHIPPING_CREATE,
  isCodeTaken,
  METAFIELD_DEFINITION_CREATE,
  METAFIELD_DEFINITIONS,
  memberMetafields,
  METAFIELDS_SET,
  type PerkRow,
  perkDiscountInput,
  SEGMENT_CREATE,
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
const METAFIELD_BATCH = 12; // members per metafieldsSet (2 metafields each, max 25)

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
  const rows = await rpc<(CodeRow & { id: string })[]>("loyalty_codes_to_issue", { p_program: c.programId, p_limit: 25 });
  let issued = 0;
  for (const row of rows) {
    if (!timeLeft(c)) break;
    try {
      const data = await gql(c, CODE_BASIC_CREATE, { input: codeDiscountInput(row, now()) });
      const r = data.discountCodeBasicCreate as { codeDiscountNode?: { id: string } | null; userErrors?: unknown };
      let id = r?.codeDiscountNode?.id ?? null;
      if (!id && isCodeTaken(r?.userErrors)) {
        id = ((await gql(c, CODE_LOOKUP, { code: row.code })).codeDiscountNodeByCode as { id?: string } | null)?.id ?? null;
      }
      if (!id) throw new Error(userErrorText(r?.userErrors) || "no id returned");
      await rpc("loyalty_code_issued", { p_code: row.id, p_shopify_discount_id: id });
      issued++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const final = await rpc<boolean>("loyalty_code_failed", { p_code: row.id, p_error: msg, p_max_attempts: 5 });
      console.error(`loyalty-shopify ${c.shop}: code ${row.id}${final ? " FAILED (points returned)" : ""}: ${msg}`);
    }
  }
  if (issued) c.log.push(`${issued} codes`);
}

type SyncMember = { member_id: string; customer_id: number; tier_key: string; tier_name: string; points: number; tier_changed: boolean };

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
        metafields: memberMetafields(batch.map((m) => ({ customerId: m.customer_id, tierName: m.tier_name, points: m.points }))),
      });
      const err = userErrorText((data.metafieldsSet as { userErrors?: unknown })?.userErrors);
      if (err) batch.forEach((m) => errors.set(m.member_id, `metafields: ${err}`));
    } catch (e) {
      batch.forEach((m) => errors.set(m.member_id, `metafields: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  if (pushed.length) {
    await rpc("loyalty_mark_members_synced", {
      p_items: pushed.map((m) => ({ member_id: m.member_id, tier_key: m.tier_key, points: m.points, error: errors.get(m.member_id) ?? null })),
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
    if (await segments(c, w)) w = await rpc<Work>("loyalty_shopify_work", { p_program: programId }); // segment ids feed the perk hash
    await perks(c, w);
    if (timeLeft(c)) await codes(c);
    if (timeLeft(c)) await members(c);

    console.log(`loyalty-shopify ${c.shop}: ${c.log.join(", ") || "nothing to do"} (${Date.now() - c.started}ms)`);
    return Response.json({ ok: true, did: c.log });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`loyalty-shopify ${programId}: ${msg}`);
    return Response.json({ error: msg }, { status: 500 });
  }
});
