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

  // Phone number. Read on this page since forever but never writable, while
  // provision-feature's own error told people to "add one in Settings" — an
  // instruction the UI could not carry out. It is the single most common reason
  // a paid client sits on "Setting up your plan".
  //
  // Stored E.164 because that is what Twilio and ElevenLabs both expect. We
  // normalise the friendly forms people actually type: "(213) 463-6649",
  // "213-463-6649", "1 213 463 6649".
  const phoneRaw = String(formData.get("phone_number") ?? "").trim();
  let phoneNumber: string | null = null;
  if (phoneRaw) {
    const digits = phoneRaw.replace(/\D/g, "");
    if (phoneRaw.startsWith("+") && digits.length >= 8) {
      phoneNumber = `+${digits}`;
    } else if (digits.length === 10) {
      phoneNumber = `+1${digits}`; // bare US number
    } else if (digits.length === 11 && digits.startsWith("1")) {
      phoneNumber = `+${digits}`; // US with country code
    } else {
      fail(
        "Enter the phone number in international format, for example +12134636649.",
      );
    }
  }

  const payload = {
    name: String(formData.get("name") ?? "").trim(),
    phone_number: phoneNumber,
    support_email: supportEmails[0] ?? null,
    store_platform: storePlatform || null, // enum: empty -> null
    store_base_url: String(formData.get("store_base_url") ?? "").trim() || null,
    brand_tone_config: {
      voice: String(formData.get("voice") ?? "").trim(),
      sign_off: String(formData.get("sign_off") ?? "").trim(),
      use_emoji: formData.get("use_emoji") === "on",
      // Email-only guidance (consumed by the email agent via get_client_config).
      custom_instructions: String(
        formData.get("custom_instructions") ?? "",
      ).trim(),
      // Phone-only guidance (consumed by voice-personalization's prompt builder).
      voice_instructions: String(
        formData.get("voice_instructions") ?? "",
      ).trim(),
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

  // Saving a number is usually someone unblocking their own stuck setup, so
  // nudge provisioning rather than making them wait for the next billing event.
  //
  // A task that parked at 'needs_human' is deliberately never auto-retried, so
  // the cause being fixed does not restart it. Without this, the client fills in
  // the field the error asked for and nothing happens.
  //
  // Best-effort throughout: the settings save has already succeeded and must not
  // be reported as failed because a background nudge did not land.
  if (phoneNumber) {
    try {
      await supabase
        .from("provisioning_tasks")
        .update({ status: "queued", last_error: null })
        .eq("client_id", profile.client_id)
        .eq("status", "needs_human");

      const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (base) {
        // Not awaited: provisioning can buy a number and call ElevenLabs, which
        // outlasts a form submission. The queue is idempotent and drains on its
        // own schedule anyway.
        void fetch(`${base}/functions/v1/provision-feature`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }).catch(() => {});
      }
    } catch {
      // Ignore: the number is saved, and the next drain picks the task up.
    }
  }

  revalidatePath("/settings");
  redirect("/settings?saved=1");
}
