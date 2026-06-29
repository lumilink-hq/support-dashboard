"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

function fail(message: string): never {
  redirect(`/settings?error=${encodeURIComponent(message)}`);
}

export async function updateClientSettings(formData: FormData) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  // Server-side authorization: only admins may edit client config. RLS would let
  // any tenant member write, so we gate by role here as well.
  const { data: profile } = await supabase
    .from("users")
    .select("role, client_id")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile || profile.role !== "admin") {
    fail("Only admins can edit settings.");
  }

  // Current settings JSON, so we merge rather than clobber unrelated keys.
  const { data: existing } = await supabase
    .from("clients")
    .select("settings")
    .eq("id", profile.client_id)
    .maybeSingle();
  const currentSettings =
    (existing?.settings as Record<string, unknown> | null) ?? {};

  // Support emails: comma-separated -> array. First becomes the primary
  // support_email column (kept for the existing pipeline); full list lives in
  // settings.support_emails.
  const supportEmails = String(formData.get("support_emails") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Parse business hours JSON before touching anything else.
  const businessHoursRaw = String(formData.get("business_hours") ?? "").trim();
  let businessHours: unknown = {};
  if (businessHoursRaw) {
    try {
      businessHours = JSON.parse(businessHoursRaw);
    } catch {
      fail("Business hours must be valid JSON.");
    }
  }

  const staleRaw = String(formData.get("stale_after_hours") ?? "").trim();
  const staleHours = Number(staleRaw);
  if (staleRaw && (Number.isNaN(staleHours) || staleHours < 0)) {
    fail("Stale-after hours must be a non-negative number.");
  }

  const abnormalStatuses = String(formData.get("abnormal_statuses") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const storePlatform = String(formData.get("store_platform") ?? "").trim();

  const payload = {
    name: String(formData.get("name") ?? "").trim(),
    support_email: supportEmails[0] ?? null,
    store_platform: storePlatform || null, // enum: empty -> null
    store_base_url: String(formData.get("store_base_url") ?? "").trim() || null,
    brand_tone_config: {
      voice: String(formData.get("voice") ?? "").trim(),
      sign_off: String(formData.get("sign_off") ?? "").trim(),
      use_emoji: formData.get("use_emoji") === "on",
    },
    abnormal_status_rules: {
      abnormal_statuses: abnormalStatuses,
      stale_after_hours: staleRaw ? staleHours : 24,
    },
    business_hours: businessHours,
    settings: { ...currentSettings, support_emails: supportEmails },
  };

  const { error } = await supabase
    .from("clients")
    .update(payload)
    .eq("id", profile.client_id);

  if (error) {
    fail(error.message);
  }

  revalidatePath("/settings");
  redirect("/settings?saved=1");
}
