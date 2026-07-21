"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

function fail(message: string): never {
  redirect(`/services?error=${encodeURIComponent(message)}`);
}

async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("users")
    .select("role, client_id")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile || profile.role !== "admin") {
    fail("Only admins can edit services.");
  }
  return { supabase, clientId: profile.client_id as string };
}

function parseMoney(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function fields(formData: FormData) {
  const price_type = String(formData.get("price_type") ?? "fixed") === "quote"
    ? "quote"
    : "fixed";
  const durationRaw = parseInt(String(formData.get("duration") ?? "60"), 10);
  return {
    name: String(formData.get("name") ?? "").trim(),
    category: String(formData.get("category") ?? "").trim() || null,
    price_type,
    price: price_type === "fixed" ? parseMoney(formData.get("price")) : null,
    callout_fee: price_type === "quote" ? parseMoney(formData.get("callout_fee")) : null,
    default_duration_min: Number.isFinite(durationRaw) && durationRaw >= 15 ? durationRaw : 60,
    emergency_eligible: formData.get("emergency") === "on",
  };
}

export async function createService(formData: FormData) {
  const { supabase, clientId } = await requireAdmin();
  const f = fields(formData);
  if (!f.name) fail("Service name is required.");

  const { error } = await supabase
    .from("services")
    .insert({ ...f, client_id: clientId, active: true });
  if (error) fail(error.message);

  revalidatePath("/services");
  redirect("/services?saved=1");
}

export async function updateService(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) fail("Missing service id.");
  const f = fields(formData);
  if (!f.name) fail("Service name is required.");

  const { error } = await supabase
    .from("services")
    .update({ ...f, active: formData.get("active") === "on" })
    .eq("id", id);
  if (error) fail(error.message);

  revalidatePath("/services");
  redirect("/services?saved=1");
}

export async function deleteService(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) fail("Missing service id.");

  const { error } = await supabase.from("services").delete().eq("id", id);
  if (error) fail(error.message);

  revalidatePath("/services");
  redirect("/services?saved=1");
}
