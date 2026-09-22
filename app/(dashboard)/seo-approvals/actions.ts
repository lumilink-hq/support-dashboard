"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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

  const { data, error } = await supabase
    .from("seo_actions")
    .update({ status: next })
    .eq("id", id)
    .eq("status", "pending_approval")
    .select("id");

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
