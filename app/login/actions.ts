"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const message = error.message || "Sign-in failed. Check your credentials.";
    redirect(`/login?error=${encodeURIComponent(message)}`);
  }

  redirect("/conversations");
}

export async function signout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
