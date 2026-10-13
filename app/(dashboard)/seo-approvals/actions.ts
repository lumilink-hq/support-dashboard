"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentClientId } from "@/lib/entitlements";
import { canAct, getMembership, READ_ONLY_MESSAGE } from "@/lib/roles";
import { editArticle, editPageFix } from "@/lib/seo-draft-edit";
import { validateGbpDescription } from "@/supabase/functions/seo-draft/gbp";
import { validateReviewReply } from "@/supabase/functions/seo-draft/reviews";
import { answerEscalatedReview, saveDraftEdit } from "@/lib/services/seo-draft-edits";
import type { LocationDetails } from "@/supabase/functions/seo-content/details";

/** A reason or note with a decision (0074): one line, at most 500 characters. */
function cleanNote(raw: FormDataEntryValue | null): string | null {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  return s || null;
}

/**
 * Viewers are read-only (0083). The database refuses their approve/reject and
 * the rollback RPCs too; this check gives them a message instead of a silent
 * zero-row update, and it is the ONLY gate for editDraft, which writes with
 * the service role.
 */
async function requireCanAct(filter: string) {
  const me = await getMembership();
  if (!me) redirect("/login");
  if (!canAct(me.role)) redirect(backTo(filter, READ_ONLY_MESSAGE));
}

function backTo(filter: string, error?: string) {
  const status = filter || "pending_approval";
  const qs = error
    ? `?status=${encodeURIComponent(status)}&error=${encodeURIComponent(error)}`
    : `?status=${encodeURIComponent(status)}`;
  return `/seo-approvals${qs}`;
}

/**
 * Approve or reject a draft. This is rule 1's human click: it records the
 * decision and nothing else. Publishing is a separate backend job (module 5)
 * that reads status = 'approved'.
 *
 * Server Actions are reachable by direct POST, so this checks the session
 * itself. Authorisation is the database's: 0042's policy only lets a tenant
 * move ITS OWN pending_approval row to approved/rejected, and 0054's trigger
 * stops the same UPDATE from editing the draft or forging approved_by.
 *
 * `.select()` matters: RLS turns "not yours" and "no longer pending" into a
 * silent zero-row update rather than an error, so the row count is the only
 * proof the decision landed.
 */
async function decide(formData: FormData, next: "approved" | "rejected") {
  const id = String(formData.get("id") ?? "");
  const filter = String(formData.get("filter") ?? "pending_approval");
  if (!id) redirect(backTo(filter, "Missing draft id."));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  await requireCanAct(filter);

  const note = cleanNote(formData.get("note"));
  const write = (withNote: boolean) =>
    supabase
      .from("seo_actions")
      .update(withNote && note ? { status: next, decision_note: note } : { status: next })
      .eq("id", id)
      .eq("status", "pending_approval")
      .select("id");
  let { data, error } = await write(true);
  // Before 0074 there's no decision_note column (42703): decide without it.
  if (error?.code === "42703") ({ data, error } = await write(false));

  if (error) redirect(backTo(filter, error.message));
  if (!data || data.length === 0) {
    redirect(backTo(filter, "That draft is no longer waiting for approval."));
  }

  revalidatePath("/seo-approvals");
  redirect(backTo(filter));
}

export async function approveDraft(formData: FormData) {
  await decide(formData, "approved");
}

export async function rejectDraft(formData: FormData) {
  await decide(formData, "rejected");
}

const RPC_MESSAGES: Record<string, string> = {
  not_found: "That draft no longer exists.",
  not_rollbackable: "That change can't be rolled back from here (it isn't live, or was applied by hand).",
  not_pending_manual: "That change isn't waiting for you to apply it.",
  not_allowed: READ_ONLY_MESSAGE,
};

/**
 * Both of these go through SECURITY DEFINER functions (0055), not a direct
 * UPDATE: the tenant has no UPDATE right on a published or manual_required row
 * (0042 + 0054), and the functions check ownership themselves. They return a
 * status string instead of raising, so 'ok' is the only success.
 */
async function callRpc(formData: FormData, fn: "request_seo_rollback" | "confirm_seo_manual_apply") {
  const id = String(formData.get("id") ?? "");
  const filter = String(formData.get("filter") ?? "pending_approval");
  if (!id) redirect(backTo(filter, "Missing draft id."));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  await requireCanAct(filter);

  const { data, error } = await supabase.rpc(fn, { p_action_id: id });
  if (error) redirect(backTo(filter, error.message));
  if (data !== "ok") redirect(backTo(filter, RPC_MESSAGES[String(data)] ?? "Could not do that."));

  revalidatePath("/seo-approvals");
  redirect(backTo(filter));
}

/** Ask for a published change to be undone. The backend does the undo. */
export async function requestRollback(formData: FormData) {
  await callRpc(formData, "request_seo_rollback");
}

/** "I applied this by hand." A claim, not proof: the next crawl confirms it. */
export async function confirmManualApply(formData: FormData) {
  await callRpc(formData, "confirm_seo_manual_apply");
}

/**
 * Edit a waiting draft before approving it (0074). The row is read under the
 * tenant's own RLS (so it must be theirs and still waiting), the new text goes
 * through the same checks as the model's output (lib/seo-draft-edit.ts), and
 * only then is it written, by lib/services/seo-draft-edits.ts. The engine's
 * first version is kept in original_value. The draft stays waiting: editing
 * is not approving.
 */
export async function editDraft(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const filter = String(formData.get("filter") ?? "pending_approval");
  if (!id) redirect(backTo(filter, "Missing draft id."));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  await requireCanAct(filter);
  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login");

  const { data: row } = await supabase
    .from("seo_actions")
    .select("id, action_type, target_field, location_id, proposed_value, previous_value, diff, original_value")
    .eq("id", id)
    .eq("status", "pending_approval")
    .maybeSingle();
  if (!row) redirect(backTo(filter, "That draft is no longer waiting for approval."));

  const pv = (row.proposed_value ?? {}) as Record<string, unknown>;
  const original = row.original_value ?? row.proposed_value;
  let saved: Awaited<ReturnType<typeof saveDraftEdit>>;

  if (row.action_type === "content_publish") {
    const { data: loc } = await supabase.from("seo_locations").select("city").eq("id", row.location_id).maybeSingle();
    const { data: details } = await supabase
      .from("seo_location_details")
      .select("service_areas, landmarks, services, year_founded, licensed, insured, bonded, certifications, family_owned, locally_owned, free_estimates, guarantee, awards")
      .eq("location_id", row.location_id)
      .maybeSingle();
    const r = editArticle(
      { title: String(formData.get("title") ?? ""), meta: String(formData.get("meta") ?? ""), body: String(formData.get("body") ?? "") },
      { keyword: String(pv.keyword ?? ""), city: (loc?.city as string | null) ?? null, details: (details as LocationDetails | null) ?? null },
    );
    if (!r.ok) redirect(backTo(filter, `Not saved: ${r.reason}.`));
    saved = await saveDraftEdit(id, clientId, user.id, {
      proposed_value: { ...pv, title: r.title, meta_description: r.meta_description, body_html: r.body_html, blocks: r.blocks, word_count: r.word_count },
      original_value: original,
    });
  } else if (row.action_type === "review_reply") {
    // Module 4 part 3: held to the reply rules (seo-draft/reviews.ts).
    const ctx = await replyContext(supabase, row.location_id, id);
    const r = validateReviewReply(String(formData.get("value") ?? ""), ctx);
    if (!r.ok) redirect(backTo(filter, `Not saved: ${r.reason.replace(/^reply /, "it ")}.`));
    const diff = (row.diff ?? {}) as Record<string, unknown>;
    saved = await saveDraftEdit(id, clientId, user.id, {
      proposed_value: { ...pv, value: r.text },
      diff: { ...diff, after: r.text },
      original_value: original,
    });
  } else if (row.action_type === "gbp_field_update" && row.target_field === "gbp_description") {
    // Module 4: held to the drafting rules (seo-draft/gbp.ts), claims backed
    // by the location's own vouched details, the same as the model's draft.
    const previous = ((row.previous_value as { value?: string | null } | null)?.value ?? null) as string | null;
    const [{ data: loc }, { data: details }] = await Promise.all([
      supabase.from("seo_locations").select("name").eq("id", row.location_id).maybeSingle(),
      supabase
        .from("seo_location_details")
        .select("service_areas, landmarks, services, year_founded, licensed, insured, bonded, certifications, family_owned, locally_owned, free_estimates, guarantee, awards")
        .eq("location_id", row.location_id)
        .maybeSingle(),
    ]);
    const r = validateGbpDescription(String(formData.get("value") ?? ""), previous, (details as LocationDetails | null) ?? null, (loc?.name as string | null) ?? null);
    if (!r.ok) redirect(backTo(filter, `Not saved: ${r.reason.replace(/^description /, "it ")}.`));
    const diff = (row.diff ?? {}) as Record<string, unknown>;
    saved = await saveDraftEdit(id, clientId, user.id, {
      proposed_value: { ...pv, value: r.text },
      diff: { ...diff, after: r.text },
      original_value: original,
    });
  } else {
    const previous = ((row.previous_value as { value?: string | null } | null)?.value ?? null) as string | null;
    const r = editPageFix(String(row.target_field ?? ""), String(formData.get("value") ?? ""), previous);
    if (!r.ok) redirect(backTo(filter, `Not saved: ${r.reason}.`));
    const diff = (row.diff ?? {}) as Record<string, unknown>;
    saved = await saveDraftEdit(id, clientId, user.id, {
      proposed_value: { ...pv, value: r.text },
      diff: { ...diff, after: r.text },
      original_value: original,
    });
  }

  if (saved === "gone") redirect(backTo(filter, "That draft is no longer waiting for approval."));
  if (typeof saved === "object") redirect(backTo(filter, `Not saved: ${saved.error}`));
  revalidatePath("/seo-approvals");
  redirect(backTo(filter));
}

type Db = Awaited<ReturnType<typeof createClient>>;

/** What a reply is checked against: the store's name and the openings of its
 * recent replies, so no two open the same way (excluding this one). */
async function replyContext(supabase: Db, locationId: string, actionId: string): Promise<{ businessName: string | null; avoidOpenings: string[] }> {
  const [{ data: loc }, { data: replies }, { data: drafts }] = await Promise.all([
    supabase.from("seo_locations").select("name").eq("id", locationId).maybeSingle(),
    supabase
      .from("seo_gbp_reviews")
      .select("reply_comment")
      .eq("location_id", locationId)
      .not("reply_comment", "is", null)
      .order("reply_updated_at", { ascending: false, nullsFirst: false })
      .limit(30),
    supabase
      .from("seo_actions")
      .select("id, proposed_value")
      .eq("location_id", locationId)
      .eq("action_type", "review_reply")
      .in("status", ["pending_approval", "approved", "publishing", "published"])
      .neq("id", actionId),
  ]);
  return {
    businessName: (loc?.name as string | null) ?? null,
    avoidOpenings: [
      ...((replies ?? []) as { reply_comment: string }[]).map((r) => r.reply_comment),
      ...((drafts ?? []) as { proposed_value: { value?: string } | null }[]).map((d) => d.proposed_value?.value ?? "").filter(Boolean),
    ],
  };
}

/**
 * An escalated review (1-2 stars, no draft, 0090): a person writes the reply.
 * The text goes through the same checks as a drafted one; writing it is the
 * approval. Or the person declines to reply.
 */
async function answerReview(formData: FormData, decline: boolean) {
  const id = String(formData.get("id") ?? "");
  const filter = String(formData.get("filter") ?? "pending_approval");
  if (!id) redirect(backTo(filter, "Missing review id."));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  await requireCanAct(filter);
  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login");

  const { data: row } = await supabase
    .from("seo_actions")
    .select("id, location_id, proposed_value, diff")
    .eq("id", id)
    .eq("action_type", "review_reply")
    .eq("status", "escalated")
    .maybeSingle();
  if (!row) redirect(backTo(filter, "That review is no longer waiting for a reply."));

  let saved: Awaited<ReturnType<typeof answerEscalatedReview>>;
  if (decline) {
    saved = await answerEscalatedReview(id, clientId, user.id, { decline: true, note: cleanNote(formData.get("note")) });
  } else {
    const r = validateReviewReply(String(formData.get("value") ?? ""), await replyContext(supabase, row.location_id, id));
    if (!r.ok) redirect(backTo(filter, `Not saved: ${r.reason.replace(/^reply /, "it ")}.`));
    const pv = (row.proposed_value ?? {}) as Record<string, unknown>;
    const diff = (row.diff ?? {}) as Record<string, unknown>;
    saved = await answerEscalatedReview(id, clientId, user.id, {
      reply: r.text,
      proposed_value: { ...pv, value: r.text },
      diff: { ...diff, after: r.text },
    });
  }
  if (saved === "gone") redirect(backTo(filter, "That review is no longer waiting for a reply."));
  if (typeof saved === "object") redirect(backTo(filter, `Not saved: ${saved.error}`));
  revalidatePath("/seo-approvals");
  redirect(backTo(filter));
}

export async function replyToEscalatedReview(formData: FormData) {
  await answerReview(formData, false);
}

export async function declineEscalatedReview(formData: FormData) {
  await answerReview(formData, true);
}
