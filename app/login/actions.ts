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
    // A teammate an admin deactivated on /team is banned in Supabase Auth
    // (0082; 0086 deletes instead, but older removals are still bans).
    // Supabase's own "User is banned" reads like a moderation action.
    const banned = error.code === "user_banned" || /banned/i.test(error.message);
    const message = banned
      ? "This account no longer has access to its workspace. Ask an admin on your team to restore your access."
      : error.message || "Sign-in failed. Check your credentials.";
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
