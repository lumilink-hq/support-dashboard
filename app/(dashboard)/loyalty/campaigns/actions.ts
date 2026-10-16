"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { securityPath } from "../access";

// Campaign console (0215). Each action is one staff RPC under the signed-in
// user's own session; the RPC checks staff + MFA, validates, and writes the
// access log. Nothing here uses the service role.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function page(programId: string, extra = ""): string {
  return `/loyalty/campaigns?program=${programId}${extra}`;
}

function fail(path: string, message: string): never {
  if (message === "mfa_required") redirect(securityPath(path));
  redirect(`${path}&error=${encodeURIComponent(message)}`);
}

function message(error: { message: string }): string {
  if (error.message === "not_staff") return "Only LumiLink staff can do that.";
  if (error.message === "mfa_required") return "mfa_required";
  if (error.message.includes("loyalty_campaigns_program_id_key_key")) return "A campaign with that name already starts that day. Change the name.";
  if (error.message.includes("check constraint")) return "Check the bonus: a multiplier between 1.1 and 10, or flat points above 0.";
  return error.message;
}

export async function saveCampaign(formData: FormData) {
  const programId = String(formData.get("program_id") ?? "");
  if (!UUID.test(programId)) redirect("/loyalty");
  const campaignId = String(formData.get("campaign_id") ?? "");
  const back = page(programId, campaignId ? `&edit=${campaignId}` : "&new=1");

  const kind = String(formData.get("kind") ?? "");
  const scope = String(formData.get("scope") ?? "none");
  const scopeValue = String(formData.get("scope_value") ?? "").trim();
  const minDollars = String(formData.get("min_scope") ?? "").trim();
  const starts = String(formData.get("starts_local") ?? "");
  const ends = String(formData.get("ends_local") ?? "");
  if (kind !== "multiplier" && kind !== "flat") fail(back, "Pick a bonus type.");
  if (!LOCAL.test(starts) || !LOCAL.test(ends)) fail(back, "Pick a start and an end.");
  if (scope !== "none" && !scopeValue) fail(back, scope === "tag" ? "Enter the product tag." : "Enter the collection ID.");
  const minCents = minDollars ? Math.round(Number(minDollars) * 100) : 1;
  if (!Number.isFinite(minCents) || minCents < 1) fail(back, "The minimum spend must be a dollar amount.");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("loyalty_staff_campaign_save", {
    p_program: programId,
    p_campaign: campaignId && UUID.test(campaignId) ? campaignId : null,
    p_fields: {
      name: String(formData.get("name") ?? "").trim(),
      kind,
      multiplier: kind === "multiplier" ? String(formData.get("multiplier") ?? "") : "",
      flat_points: kind === "flat" ? String(formData.get("flat_points") ?? "") : "",
      min_scope_cents: String(minCents),
      starts_local: starts,
      ends_local: ends,
      collection_gid: scope === "collection" ? scopeValue : "",
      product_tag: scope === "tag" ? scopeValue : "",
      announce: formData.get("announce") === "on",
    },
  });
  if (error) fail(back, message(error));
  revalidatePath("/loyalty/campaigns");
  redirect(page(programId, `&saved=${encodeURIComponent(campaignId ? "Campaign saved." : "Campaign created.")}#c-${data}`));
}

// Challenges (0216): same shape, their own RPCs.
export async function saveChallenge(formData: FormData) {
  const programId = String(formData.get("program_id") ?? "");
  if (!UUID.test(programId)) redirect("/loyalty");
  const challengeId = String(formData.get("challenge_id") ?? "");
  const back = page(programId, challengeId ? `&editch=${challengeId}` : "&newch=1");

  const kind = String(formData.get("kind") ?? "");
  const starts = String(formData.get("starts_local") ?? "");
  const ends = String(formData.get("ends_local") ?? "");
  const scope = String(formData.get("scope") ?? "tag");
  const scopeValue = String(formData.get("scope_value") ?? "").trim();
  if (!["order_count", "spend", "new_categories", "tagged_product"].includes(kind)) fail(back, "Pick a challenge type.");
  if (!LOCAL.test(starts) || !LOCAL.test(ends)) fail(back, "Pick a start and an end.");
  // Spend targets are entered in dollars, stored in cents.
  const rawTarget = Number(formData.get("target"));
  const target = kind === "spend" ? Math.round(rawTarget * 100) : rawTarget;
  if (!Number.isFinite(target) || target <= 0 || (kind !== "spend" && !Number.isInteger(target))) fail(back, "Enter a target above zero.");
  if (kind === "tagged_product" && !scopeValue) fail(back, scope === "collection" ? "Enter the collection ID." : "Enter the product tag.");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("loyalty_staff_challenge_save", {
    p_program: programId,
    p_challenge: challengeId && UUID.test(challengeId) ? challengeId : null,
    p_fields: {
      name: String(formData.get("name") ?? "").trim(),
      description: String(formData.get("description") ?? "").trim(),
      kind,
      target: String(target),
      points: String(formData.get("points") ?? ""),
      starts_local: starts,
      ends_local: ends,
      collection_gid: kind === "tagged_product" && scope === "collection" ? scopeValue : "",
      product_tag: kind === "tagged_product" && scope === "tag" ? scopeValue : "",
      announce: formData.get("announce") === "on",
    },
  });
  if (error) {
    fail(back, error.message.includes("loyalty_challenges_program_id_key_key")
      ? "A challenge with that name already starts that day. Change the name."
      : message(error));
  }
  revalidatePath("/loyalty/campaigns");
  redirect(page(programId, `&saved=${encodeURIComponent(challengeId ? "Challenge saved." : "Challenge created.")}#ch-${data}`));
}

export async function setChallengeActive(formData: FormData) {
  const programId = String(formData.get("program_id") ?? "");
  const challengeId = String(formData.get("challenge_id") ?? "");
  if (!UUID.test(programId) || !UUID.test(challengeId)) redirect("/loyalty");
  const active = formData.get("active") === "1";
  const supabase = await createClient();
  const { error } = await supabase.rpc("loyalty_staff_challenge_set_active", { p_challenge: challengeId, p_active: active });
  if (error) fail(page(programId), message(error));
  revalidatePath("/loyalty/campaigns");
  redirect(page(programId, `&saved=${encodeURIComponent(active ? "Challenge resumed." : "Challenge paused.")}#ch-${challengeId}`));
}

export async function setCampaignActive(formData: FormData) {
  const programId = String(formData.get("program_id") ?? "");
  const campaignId = String(formData.get("campaign_id") ?? "");
  if (!UUID.test(programId) || !UUID.test(campaignId)) redirect("/loyalty");
  const active = formData.get("active") === "1";
  const supabase = await createClient();
  const { error } = await supabase.rpc("loyalty_staff_campaign_set_active", { p_campaign: campaignId, p_active: active });
  if (error) fail(page(programId), message(error));
  revalidatePath("/loyalty/campaigns");
  redirect(page(programId, `&saved=${encodeURIComponent(active ? "Campaign resumed." : "Campaign paused.")}#c-${campaignId}`));
}
