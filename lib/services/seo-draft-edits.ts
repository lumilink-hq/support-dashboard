// The one write a tenant's edit to an SEO draft needs (0074). The second and
// last use of the service-role client outside billing (see lib/supabase/service.ts).
//
// WHY SERVICE ROLE. 0054 makes a draft read-only to tenants, and that must
// stay true: the publisher trusts what's stored, so text may only change after
// lib/seo-draft-edit.ts has run the engine's own checks on it. Letting
// `authenticated` write proposed_value (or exposing an RPC that does) would
// let anyone skip those checks with a direct API call.
//
// WHAT KEEPS IT SAFE. The caller (editDraft in app/(dashboard)/seo-approvals/
// actions.ts) first reads the row under the tenant's own RLS, so it is theirs;
// this function then pins the UPDATE to that id, that client and
// status = 'pending_approval', so a draft that was decided in between, or a
// forged id, changes nothing. Only the four columns below are written.

import { createServiceClient } from "@/lib/supabase/service";

export type DraftEditPatch = {
  proposed_value: Record<string, unknown>;
  diff?: Record<string, unknown> | null;
  original_value: unknown;
};

/**
 * "saved"; "gone" when the draft was deleted or decided meanwhile; otherwise
 * the database's error message (e.g. before 0074 adds the edit columns).
 */
export async function saveDraftEdit(actionId: string, clientId: string, userId: string, patch: DraftEditPatch): Promise<"saved" | "gone" | { error: string }> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("seo_actions")
    .update({
      proposed_value: patch.proposed_value,
      ...(patch.diff !== undefined ? { diff: patch.diff } : {}),
      original_value: patch.original_value,
      edited_by: userId,
      edited_at: new Date().toISOString(),
    })
    .eq("id", actionId)
    .eq("client_id", clientId)
    .eq("status", "pending_approval")
    .select("id");
  if (error) return { error: error.message };
  return (data ?? []).length === 1 ? "saved" : "gone";
}

/**
 * A person's answer to an ESCALATED review (0090: 1-2 stars, no draft).
 * Writing the reply is the approval, so the row goes straight to 'approved'
 * with approved_by; declining marks it 'rejected'. Same safety as above: the
 * caller read the row under RLS and validated the text with
 * seo-draft/reviews.ts validateReviewReply; this pins id, client, action type
 * and status = 'escalated'.
 */
export async function answerEscalatedReview(
  actionId: string,
  clientId: string,
  userId: string,
  answer: { reply: string; proposed_value: Record<string, unknown>; diff: Record<string, unknown> } | { decline: true; note: string | null },
): Promise<"saved" | "gone" | { error: string }> {
  const db = createServiceClient();
  const now = new Date().toISOString();
  const patch =
    "decline" in answer
      ? { status: "rejected", decision_note: answer.note, approved_by: userId, approved_at: now }
      : { status: "approved", proposed_value: answer.proposed_value, diff: answer.diff, approved_by: userId, approved_at: now, edited_by: userId, edited_at: now };
  const { data, error } = await db
    .from("seo_actions")
    .update(patch)
    .eq("id", actionId)
    .eq("client_id", clientId)
    .eq("action_type", "review_reply")
    .eq("status", "escalated")
    .select("id");
  if (error) return { error: error.message };
  return (data ?? []).length === 1 ? "saved" : "gone";
}
