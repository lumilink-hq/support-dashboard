// Shared by loyalty-shopify (the minute queue) and loyalty-proxy (a shopper
// redeeming right now): create one pending code in Shopify and record the
// outcome. A code that already exists with OUR title (an earlier attempt
// landed) is looked up, not duplicated; one with another title is an error,
// and after 5 the points come back (the shopper redeems again for a new code).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.49.1";
import { CODE_BASIC_CREATE, CODE_LOOKUP, type CodeRow, codeDiscountInput, isCodeTaken, userErrorText } from "../loyalty-shopify/lib.ts";
import { shopifyGraphql } from "./shopify.ts";

export type PendingCode = CodeRow & { id: string };

/** 'issued', or the error (the attempt is counted; the 5th failure refunds the points). */
export async function issueCode(
  supabase: SupabaseClient,
  shop: string,
  token: string,
  row: PendingCode,
  shopBase = "",
): Promise<{ ok: true } | { ok: false; error: string; final: boolean }> {
  try {
    const data = await shopifyGraphql(shop, token, CODE_BASIC_CREATE, { input: codeDiscountInput(row, new Date().toISOString()) }, shopBase);
    const r = data.discountCodeBasicCreate as { codeDiscountNode?: { id: string } | null; userErrors?: unknown };
    let id = r?.codeDiscountNode?.id ?? null;
    if (!id && isCodeTaken(r?.userErrors)) {
      const found = await shopifyGraphql(shop, token, CODE_LOOKUP, { code: row.code }, shopBase);
      const node = found.codeDiscountNodeByCode as { id?: string; codeDiscount?: { title?: string } } | null;
      // Ours only if the title matches; otherwise it's someone else's code (e.g. Joy's).
      if (node?.id && node.codeDiscount?.title !== row.title) throw new Error(`code ${row.code} already exists in Shopify and isn't ours`);
      id = node?.id ?? null;
    }
    if (!id) throw new Error(userErrorText(r?.userErrors) || "no id returned");
    const { error } = await supabase.rpc("loyalty_code_issued", { p_code: row.id, p_shopify_discount_id: id });
    if (error) throw new Error(`loyalty_code_issued: ${error.message}`);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const { data: final } = await supabase.rpc("loyalty_code_failed", { p_code: row.id, p_error: msg, p_max_attempts: 5 });
    return { ok: false, error: msg, final: Boolean(final) };
  }
}
