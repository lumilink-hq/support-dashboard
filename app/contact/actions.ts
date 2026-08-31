"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Public contact form. Writes to contact_submissions (0038) — LumiLink's own
 * inbox, not a per-tenant table. No email pipeline exists yet
 * (docs/BUILD-PLAN-2026-08.md §E), so this is where a submission lives until
 * someone reads it in Supabase Studio.
 */
export async function submitContact(formData: FormData) {
  const fail = (message: string) =>
    redirect(`/contact?error=${encodeURIComponent(message)}`);

  // Honeypot. Real visitors never see this field (page.tsx hides it) or have
  // a reason to fill it. A bot that fills every input trips it; we succeed
  // silently rather than telling the bot what gave it away.
  if (String(formData.get("company_website") ?? "").trim() !== "") {
    redirect("/contact?sent=1");
  }

  const audience = String(formData.get("audience") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();

  if (audience !== "new" && audience !== "existing") {
    fail("Choose which one best describes you.");
  }
  if (!email) fail("Enter your email address.");
  if (!message) fail("Tell us what's going on.");

  const supabase = await createClient();
  const { error } = await supabase.from("contact_submissions").insert({
    audience,
    name: name || null,
    email,
    message,
    source_path: "/contact",
  });

  if (error) {
    console.error("[contact] insert failed:", error);
    fail("Something went wrong on our end. Try again, or email us directly.");
  }

  redirect("/contact?sent=1");
}
