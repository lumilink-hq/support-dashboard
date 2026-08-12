"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/route-access";
import { landingPathAfterAuth } from "@/lib/post-auth";

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  // Where to land after signing in. /plans sends people here so they return to
  // the plan they picked instead of the conversations list. Sanitised: an
  // unchecked value here is an open redirect (see safeNextPath).
  const next = safeNextPath(formData.get("next") as string | null);

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const message = error.message || "Sign-in failed. Check your credentials.";
    // Carry `next` through the failure so a typo'd password doesn't lose it.
    const qs = new URLSearchParams({ error: message });
    if (next !== "/conversations") qs.set("next", next);
    redirect(`/login?${qs}`);
  }

  // Setup before inbox: a client with blocking onboarding steps outstanding is
  // not live, and an empty conversations list does not tell them why. Only
  // overrides the DEFAULT destination — see lib/post-auth.ts.
  redirect(await landingPathAfterAuth(next));
}

export async function signout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
