"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentClientId } from "@/lib/entitlements";
import { getSeoAccess } from "@/lib/seo-access";
import { cleanDomain, cleanQuery, MAX_COMPETITORS_PER_LOCATION, QUERY_MAX, QUERY_MIN } from "@/lib/seo-portal";
import { createClient } from "@/lib/supabase/server";
// The weekly AI-visibility job only ever checks this many active queries; more
// would be accepted here and silently never checked, so the form stops at the cap.
import { MAX_QUERIES_PER_CLIENT } from "@/supabase/functions/seo-ai-visibility/lib";

function backTo(location: string, error?: string) {
  const qs = new URLSearchParams();
  if (location) qs.set("location", location);
  if (error) qs.set("error", error);
  const s = qs.toString();
  return `/seo${s ? `?${s}` : ""}#ai`;
}

/**
 * Add (or turn back on) a priority AI question. The tenant policy on
 * seo_ai_queries (0053) already confines this to the caller's own client, so
 * this only checks the session, the input and the cap.
 *
 * The question is stored and later sent to the AI-visibility vendor as a search
 * term. It is never placed in a prompt to our own model (rule 5).
 */
export async function addAiQuery(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const query = cleanQuery(String(formData.get("query") ?? ""));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(backTo(location, "Local SEO isn't active on your plan."));
  if (query.length < QUERY_MIN || query.length > QUERY_MAX) {
    redirect(backTo(location, `A question must be between ${QUERY_MIN} and ${QUERY_MAX} characters.`));
  }

  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login");

  const supabase = await createClient();
  const { count, error: countErr } = await supabase
    .from("seo_ai_queries")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true);
  if (countErr) redirect(backTo(location, countErr.message));

  // Re-adding one that is already on is a no-op, not a cap error.
  const { data: existing } = await supabase
    .from("seo_ai_queries")
    .select("id, is_active")
    .eq("client_id", clientId)
    .eq("query", query)
    .maybeSingle();
  if (existing?.is_active) redirect(backTo(location));
  if ((count ?? 0) >= MAX_QUERIES_PER_CLIENT) {
    redirect(backTo(location, `You can track up to ${MAX_QUERIES_PER_CLIENT} questions. Stop tracking one to add another.`));
  }

  const { error } = existing
    ? await supabase.from("seo_ai_queries").update({ is_active: true }).eq("id", existing.id)
    : await supabase.from("seo_ai_queries").insert({ client_id: clientId, query });
  if (error) redirect(backTo(location, error.message));

  revalidatePath("/seo");
  redirect(backTo(location));
}

/** Stop tracking a question. Kept (inactive) rather than deleted so its past checks stay in the history. */
export async function removeAiQuery(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(backTo(location, "Missing question id."));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(backTo(location, "Local SEO isn't active on your plan."));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS turns "not yours" into a zero-row update, so the count is the proof.
  const { data, error } = await supabase.from("seo_ai_queries").update({ is_active: false }).eq("id", id).select("id");
  if (error) redirect(backTo(location, error.message));
  if (!data || data.length === 0) redirect(backTo(location, "That question no longer exists."));

  revalidatePath("/seo");
  redirect(backTo(location));
}

/**
 * Track a competitor's domain for one location. The tenant policy on
 * seo_competitors (0042) confines the row to the caller's client, but not the
 * location_id it points at, so the location is looked up under RLS first.
 * Removing one turns it off rather than deleting it, so its ranking history stays.
 */
export async function addCompetitor(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const domain = cleanDomain(String(formData.get("domain") ?? ""));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(competitorBack(location, "Local SEO isn't active on your plan."));
  if (!domain) redirect(competitorBack(location, "That doesn't look like a website address, e.g. rival.com."));

  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login");
  const supabase = await createClient();

  const { data: loc } = await supabase.from("seo_locations").select("id").eq("id", location).maybeSingle();
  if (!loc) redirect(competitorBack(location, "That location no longer exists."));

  const { data: existing } = await supabase
    .from("seo_competitors")
    .select("id, is_active")
    .eq("location_id", location)
    .eq("domain", domain)
    .maybeSingle();
  if (existing?.is_active) redirect(competitorBack(location));

  const { count } = await supabase
    .from("seo_competitors")
    .select("id", { count: "exact", head: true })
    .eq("location_id", location)
    .eq("is_active", true);
  if ((count ?? 0) >= MAX_COMPETITORS_PER_LOCATION) {
    redirect(competitorBack(location, `You can track up to ${MAX_COMPETITORS_PER_LOCATION} competitors per location.`));
  }

  const { error } = existing
    ? await supabase.from("seo_competitors").update({ is_active: true }).eq("id", existing.id)
    : await supabase.from("seo_competitors").insert({ client_id: clientId, location_id: location, domain });
  if (error) redirect(competitorBack(location, error.message));

  revalidatePath("/seo");
  redirect(competitorBack(location));
}

export async function removeCompetitor(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(competitorBack(location, "Missing competitor id."));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(competitorBack(location, "Local SEO isn't active on your plan."));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase.from("seo_competitors").update({ is_active: false }).eq("id", id).select("id");
  if (error) redirect(competitorBack(location, error.message));
  if (!data || data.length === 0) redirect(competitorBack(location, "That competitor no longer exists."));

  revalidatePath("/seo");
  redirect(competitorBack(location));
}

function competitorBack(location: string, error?: string) {
  const qs = new URLSearchParams();
  if (location) qs.set("location", location);
  if (error) qs.set("error", error);
  const s = qs.toString();
  return `/seo${s ? `?${s}` : ""}#competitors`;
}
