"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

async function setStatus(
  id: string,
  status: "pending" | "resolved" | "dismissed",
) {
  const supabase = await createClient();
  // RLS scopes this update to the caller's tenant; no client_id needed.
  await supabase
    .from("review_queue")
    .update({
      status,
      resolved_at: status === "pending" ? null : new Date().toISOString(),
    })
    .eq("id", id);
  revalidatePath("/review-queue");
}

export async function resolveItem(formData: FormData) {
  await setStatus(String(formData.get("id") ?? ""), "resolved");
}

export async function dismissItem(formData: FormData) {
  await setStatus(String(formData.get("id") ?? ""), "dismissed");
}

export async function reopenItem(formData: FormData) {
  await setStatus(String(formData.get("id") ?? ""), "pending");
}
