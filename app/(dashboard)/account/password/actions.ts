"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_LANDING, landingPathAfterAuth } from "@/lib/post-auth";

function fail(message: string): never {
  redirect(`/account/password?error=${encodeURIComponent(message)}`);
}

// Invited teammates land here from the invite email (via /auth/confirm) with a
// session but no password. Anyone signed in can also use it to change theirs.
export async function setPassword(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < 8) fail("Use at least 8 characters.");
  if (password !== confirm) fail("The two passwords don't match.");

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) fail(error.message);

  redirect(await landingPathAfterAuth(DEFAULT_LANDING));
}
