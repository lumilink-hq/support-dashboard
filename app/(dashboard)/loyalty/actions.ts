"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { securityPath } from "./access";

// LL Loyalty staff admin (0206). Every action is one staff RPC under the
// signed-in user's own session: the RPC refuses anyone not in platform_staff,
// does the change, and writes the access log. Nothing here uses the service
// role.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function memberPath(memberId: string) {
  return `/loyalty/members/${memberId}`;
}

function done(memberId: string, notice: string): never {
  revalidatePath(memberPath(memberId));
  redirect(`${memberPath(memberId)}?saved=${encodeURIComponent(notice)}`);
}

function fail(memberId: string, message: string): never {
  // 0210: a session without its MFA code goes to the code step, then back here.
  if (message === "mfa_required") redirect(securityPath(memberPath(memberId)));
  redirect(`${memberPath(memberId)}?error=${encodeURIComponent(message)}`);
}

function readMember(formData: FormData): string {
  const id = String(formData.get("member_id") ?? "");
  if (!UUID.test(id)) redirect("/loyalty");
  return id;
}

/** Postgres messages are written for staff already; trim the prefix noise. */
function message(error: { message: string }): string {
  if (error.message.startsWith("insufficient_points")) return "That would take the balance below zero.";
  if (error.message === "not_staff") return "Only LumiLink staff can do that.";
  if (error.message === "mfa_required") return "mfa_required";
  return error.message;
}

export async function adjustPoints(formData: FormData) {
  const memberId = readMember(formData);
  const points = Number(formData.get("points"));
  const note = String(formData.get("note") ?? "").trim();
  const requestKey = String(formData.get("request_key") ?? "");
  if (!Number.isInteger(points) || points === 0) fail(memberId, "Enter a whole number of points, + to add or - to take away.");
  if (note.length < 3) fail(memberId, "Add a note saying why.");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("loyalty_staff_adjust", {
    p_member: memberId,
    p_points: points,
    p_note: note,
    p_request_key: requestKey,
  });
  if (error) fail(memberId, message(error));
  const r = data as { points_balance: number; duplicate: boolean };
  done(memberId, r.duplicate
    ? "Already saved (that form was submitted twice)."
    : `${points > 0 ? "Added" : "Took"} ${Math.abs(points).toLocaleString("en-US")} points. Balance ${r.points_balance.toLocaleString("en-US")}.`);
}

export async function setTier(formData: FormData) {
  const memberId = readMember(formData);
  const tier = String(formData.get("tier") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!/^[a-z0-9_]+$/.test(tier)) fail(memberId, "Pick a tier.");
  if (note.length < 3) fail(memberId, "Add a note saying why.");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("loyalty_staff_set_tier", { p_member: memberId, p_tier_key: tier, p_note: note });
  if (error) fail(memberId, message(error));
  done(memberId, data ? "Tier changed." : "They're already on that tier.");
}

export async function setBirthday(formData: FormData) {
  const memberId = readMember(formData);
  const clear = formData.get("clear") === "on";
  const birthday = String(formData.get("birthday") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!clear && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) fail(memberId, "Pick a date, or tick Clear.");
  if (note.length < 3) fail(memberId, "Add a note saying why.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("loyalty_staff_set_birthday", {
    p_member: memberId,
    p_birthday: clear ? null : birthday,
    p_note: note,
  });
  if (error) fail(memberId, message(error));
  done(memberId, clear ? "Birthday cleared. They can set it again on the rewards page." : "Birthday saved.");
}
