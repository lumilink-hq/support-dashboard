"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { securityPath } from "../access";

// Program editor (0221). Each action is one staff RPC under the signed-in
// user's own session; the RPC checks staff + MFA, validates (its messages are
// written for staff) and writes the access log. Nothing here uses the service role.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(programId: string, extra = ""): string {
  return `/loyalty/program?program=${programId}${extra}`;
}

function fail(path: string, message: string): never {
  if (message === "mfa_required") redirect(securityPath(path));
  redirect(`${path}&error=${encodeURIComponent(message)}`);
}

function message(error: { message: string }): string {
  if (error.message === "not_staff") return "Only LumiLink staff can do that.";
  if (error.message === "mfa_required") return "mfa_required";
  if (error.message.includes("invalid input syntax")) return "Check the numbers: one of them isn't a number.";
  return error.message;
}

function programFrom(formData: FormData): string {
  const programId = String(formData.get("program_id") ?? "");
  if (!UUID.test(programId)) redirect("/loyalty");
  return programId;
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/** "12.50" -> "1250"; "" -> ""; anything else -> "x" so the RPC refuses it. */
function cents(value: string): string {
  if (value === "") return "";
  const n = Number(value.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? String(Math.round(n * 100)) : "x";
}

function done(programId: string, anchor: string, note: string): never {
  revalidatePath("/loyalty/program");
  redirect(page(programId, `&saved=${encodeURIComponent(note)}#${anchor}`));
}

export async function saveSettings(formData: FormData) {
  const programId = programFrom(formData);
  const back = page(programId);
  const supabase = await createClient();
  const { error } = await supabase.rpc("loyalty_staff_program_save", {
    p_program: programId,
    p_settings: {
      points_per_dollar: str(formData, "points_per_dollar"),
      expire_months: str(formData, "expire_months"),
      demote_months: str(formData, "demote_months"),
      demotion_warning_days: str(formData, "demotion_warning_days"),
      balance_reminder_days: str(formData, "balance_reminder_days"),
      near_tier_percent: str(formData, "near_tier_percent"),
      gross_margin_pct: str(formData, "gross_margin_pct"),
    },
  });
  if (error) fail(back, message(error));
  done(programId, "settings", "Program settings saved.");
}

export async function saveTiers(formData: FormData) {
  const programId = programFrom(formData);
  const back = page(programId);
  const keys = formData.getAll("tier_key").map(String);
  const tiers = keys.map((key) => ({
    key,
    min_spend_cents: cents(str(formData, `min_spend_${key}`)),
    earn_multiplier: str(formData, `multiplier_${key}`),
    perks: str(formData, `perks_${key}`)
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean),
  }));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("loyalty_staff_tiers_save", { p_program: programId, p_tiers: tiers });
  if (error) fail(back, message(error));
  const promoted = Number((data as { promoted?: number } | null)?.promoted ?? 0);
  done(
    programId,
    "tiers",
    promoted ? `Tiers saved. ${promoted} member${promoted === 1 ? "" : "s"} moved up a tier (no emails sent).` : "Tiers saved.",
  );
}

export async function saveReward(formData: FormData) {
  const programId = programFrom(formData);
  const back = page(programId);
  const key = str(formData, "reward_key");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("loyalty_staff_reward_save", {
    p_program: programId,
    p_reward: {
      key,
      name: str(formData, "name"),
      points_cost: str(formData, "points_cost"),
      value_cents: cents(str(formData, "value")),
      min_order_cents: cents(str(formData, "min_order")),
      max_units: str(formData, "max_units"),
      is_active: formData.get("is_active") === "on",
    },
  });
  if (error) fail(back, message(error));
  const saved = String((data as { key?: string } | null)?.key ?? key);
  done(programId, `r-${saved}`, key ? "Reward saved." : "Reward added.");
}

export async function saveEarnRule(formData: FormData) {
  const programId = programFrom(formData);
  const back = page(programId);
  const key = str(formData, "rule_key");
  const points = Number(str(formData, "points"));
  if (!Number.isInteger(points)) fail(back, "Points must be a whole number.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("loyalty_staff_earn_rule_save", {
    p_program: programId,
    p_key: key,
    p_points: points,
    p_active: formData.get("is_active") === "on",
  });
  if (error) fail(back, message(error));
  done(programId, `e-${key}`, "Earning rule saved.");
}
