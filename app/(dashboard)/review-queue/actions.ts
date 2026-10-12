"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canAct, getMembership, READ_ONLY_MESSAGE } from "@/lib/roles";

// Keep the user on the tab they were working when an action redirects back.
function backTo(filter: string, error?: string) {
  const status = filter || "pending";
  const qs = error
    ? `?status=${encodeURIComponent(status)}&error=${encodeURIComponent(error)}`
    : `?status=${encodeURIComponent(status)}`;
  return `/review-queue${qs}`;
}

/**
 * Viewers are read-only (0083). The database refuses their writes as well;
 * this turns that into a message instead of a click that does nothing.
 */
async function requireCanAct(filter: string) {
  const me = await getMembership();
  if (!me) redirect("/login");
  if (!canAct(me.role)) redirect(backTo(filter, READ_ONLY_MESSAGE));
}

async function setStatus(formData: FormData, status: "pending" | "resolved" | "dismissed") {
  const id = String(formData.get("id") ?? "");
  const filter = String(formData.get("filter") ?? "pending");
  await requireCanAct(filter);

  const supabase = await createClient();
  // RLS scopes this update to the caller's tenant; no client_id needed.
  // .select() because RLS turns "not allowed" into zero rows, not an error.
  const { data, error } = await supabase
    .from("review_queue")
    .update({
      status,
      resolved_at: status === "pending" ? null : new Date().toISOString(),
    })
    .eq("id", id)
    .select("id");
  if (error) redirect(backTo(filter, error.message));
  if (!data || data.length === 0) redirect(backTo(filter, "That item couldn't be updated."));
  revalidatePath("/review-queue");
}

export async function resolveItem(formData: FormData) {
  await setStatus(formData, "resolved");
}

export async function dismissItem(formData: FormData) {
  await setStatus(formData, "dismissed");
}

export async function reopenItem(formData: FormData) {
  await setStatus(formData, "pending");
}

const OUTCOMES = ["attempted", "completed", "failed"] as const;
type Outcome = (typeof OUTCOMES)[number];

/**
 * Log a callback attempt against a ticket.
 *
 * Goes through the `record_callback_attempt` RPC rather than a direct update,
 * because the RPC also increments `callback_attempts`, stamps `last_attempt_at`,
 * resolves the ticket on 'completed', and writes the ticket_notes trail — all in
 * one transaction. Reimplementing that here would let the two drift apart.
 *
 * The RPC returns `{ok:false, error}` in the body rather than raising, so a
 * successful HTTP round-trip is NOT proof the work happened. Check both.
 */
export async function recordCallback(formData: FormData) {
  const ticketId = String(formData.get("id") ?? "");
  const filter = String(formData.get("filter") ?? "pending");
  const rawOutcome = String(formData.get("outcome") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  if (!ticketId) redirect(backTo(filter, "Missing ticket id."));
  if (!(OUTCOMES as readonly string[]).includes(rawOutcome)) {
    redirect(backTo(filter, "Unknown callback outcome."));
  }
  const outcome = rawOutcome as Outcome;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  await requireCanAct(filter);

  const { data, error } = await supabase.rpc("record_callback_attempt", {
    p_ticket_id: ticketId,
    p_outcome: outcome,
    p_note: note || null,
    // users.id IS the auth user id (see 0001), so no profile lookup needed.
    p_author_id: user.id,
  });

  if (error) {
    redirect(backTo(filter, error.message));
  }

  const result = data as { ok?: boolean; error?: string } | null;
  if (!result?.ok) {
    // 'unknown_ticket' is also what the tenant guard returns (0016) — it's
    // deliberately indistinguishable so it can't be used to probe other tenants.
    const reason =
      result?.error === "unknown_ticket"
        ? "That ticket no longer exists."
        : result?.error === "not_allowed"
          ? READ_ONLY_MESSAGE
          : (result?.error ?? "Could not record the callback.");
    redirect(backTo(filter, reason));
  }

  revalidatePath("/review-queue");
  redirect(backTo(filter));
}
