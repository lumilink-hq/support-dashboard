"use server";

// =============================================================================
// Onboarding wizard server actions.
//
// Every write here goes through the caller's own Supabase session, so RLS
// applies and a client can only ever modify their own tenant. No service-role
// client is imported into this file on purpose: a wizard that could write as
// service_role is a wizard one bug away from writing to somebody else's row.
// =============================================================================

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentClientId } from "@/lib/entitlements";
import { normalizeSiteUrl } from "@/lib/url";
import {
  type StepKey,
  WEEKDAYS,
  withStepDone,
} from "@/lib/onboarding";

async function loadSettings(): Promise<{
  clientId: string;
  settings: Record<string, unknown>;
}> {
  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login?next=%2Fonboarding");

  const supabase = await createClient();
  const { data } = await supabase
    .from("clients")
    .select("settings")
    .eq("id", clientId)
    .maybeSingle();

  return {
    clientId,
    settings: (data?.settings ?? {}) as Record<string, unknown>,
  };
}

/** Mark a step complete (or skipped) and move on. */
async function completeStep(
  clientId: string,
  settings: Record<string, unknown>,
  step: StepKey,
  opts: { skipped?: boolean } = {},
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("clients")
    .update({ settings: withStepDone(settings, step, opts) })
    .eq("id", clientId);
  if (error) throw new Error(error.message);
  revalidatePath("/onboarding");
}

// ---------------------------------------------------------------------------
// Step 1 — business basics
// ---------------------------------------------------------------------------

export async function saveBasics(formData: FormData) {
  const { clientId, settings } = await loadSettings();

  const timezone = String(formData.get("timezone") ?? "").trim();
  const serviceArea = String(formData.get("service_area") ?? "").trim();
  const areaCode = String(formData.get("area_code") ?? "").replace(/\D/g, "").slice(0, 3);

  // Weekly hours as { mon: ["08:00-17:00"], sat: [] }. An empty array means
  // closed that day — the shape the availability engine already reads.
  const hours: Record<string, string[]> = {};
  for (const day of WEEKDAYS) {
    const open = String(formData.get(`${day.key}_open`) ?? "").trim();
    const close = String(formData.get(`${day.key}_close`) ?? "").trim();
    const closed = formData.get(`${day.key}_closed`) === "on";
    hours[day.key] = closed || !open || !close ? [] : [`${open}-${close}`];
  }

  const scheduling = (settings.scheduling ?? {}) as Record<string, unknown>;
  const next = {
    ...settings,
    scheduling: {
      ...scheduling,
      ...(timezone ? { timezone } : {}),
      ...(serviceArea ? { service_area: serviceArea } : {}),
      ...(areaCode ? { area_code: areaCode } : {}),
      hours,
    },
  };

  const supabase = await createClient();
  const { error } = await supabase
    .from("clients")
    .update({ settings: withStepDone(next, "basics") })
    .eq("id", clientId);
  if (error) throw new Error(error.message);

  revalidatePath("/onboarding");
  redirect("/onboarding?step=website");
}

// ---------------------------------------------------------------------------
// Step 2 — website
// ---------------------------------------------------------------------------

/**
 * Creates a kb_documents row at status='pending'. The kb-ingest worker fetches,
 * chunks and embeds it, then flips it to 'ready'.
 *
 * NOTHING IS INGESTED SYNCHRONOUSLY. Fetching a site takes seconds and can
 * fail; making the client wait on it means a spinner that sometimes ends in an
 * error they cannot act on. The row is the promise, and the step shows its
 * status afterwards.
 */
export async function saveWebsite(formData: FormData) {
  const { clientId, settings } = await loadSettings();
  const supabase = await createClient();

  const raw = String(formData.get("website_url") ?? "");
  const url = normalizeSiteUrl(raw);

  if (url) {
    // Store the site URL on the client too — it is useful well beyond the KB.
    const next = { ...settings, website_url: url };

    // onConflict matches the unique index on (client_id, source_uri): re-running
    // the wizard re-queues the same document instead of creating a second copy
    // of the whole site, which would duplicate every chunk and make retrieval
    // return the same passage twice.
    const { error: docErr } = await supabase.from("kb_documents").upsert(
      {
        client_id: clientId,
        title: new URL(url).hostname,
        source_type: "url",
        source_uri: url,
        status: "pending",
        last_error: null,
      },
      { onConflict: "client_id,source_uri" },
    );
    if (docErr) throw new Error(docErr.message);

    const { error } = await supabase
      .from("clients")
      .update({ settings: withStepDone(next, "website") })
      .eq("id", clientId);
    if (error) throw new Error(error.message);
  } else {
    // No site is a legitimate answer, especially for trades.
    await completeStep(clientId, settings, "website", { skipped: true });
  }

  redirect("/onboarding");
}

// ---------------------------------------------------------------------------
// Step 3 — services (service clients only)
// ---------------------------------------------------------------------------

export async function addService(formData: FormData) {
  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login?next=%2Fonboarding");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/onboarding?step=services");

  const priceType = formData.get("price_type") === "quote" ? "quote" : "fixed";
  const num = (v: FormDataEntryValue | null) => {
    const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const supabase = await createClient();
  const { error } = await supabase.from("services").insert({
    client_id: clientId,
    name,
    price_type: priceType,
    // A fixed-price service carries a price; a quote-only one carries the
    // call-out fee instead. Storing both would let the agent quote a total for
    // a job that was explicitly marked "we don't quote totals on the phone".
    price: priceType === "fixed" ? num(formData.get("price")) : null,
    callout_fee: priceType === "quote" ? num(formData.get("callout_fee")) : null,
    default_duration_min: Number(formData.get("duration") ?? 60) || 60,
    emergency_eligible: formData.get("emergency") === "on",
  });
  if (error) throw new Error(error.message);

  revalidatePath("/onboarding");
  redirect("/onboarding?step=services");
}

export async function removeService(formData: FormData) {
  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login?next=%2Fonboarding");

  const id = String(formData.get("service_id") ?? "");
  if (id) {
    const supabase = await createClient();
    // client_id in the filter as well as RLS. Belt and braces on a delete.
    await supabase.from("services").delete().eq("id", id).eq("client_id", clientId);
  }

  revalidatePath("/onboarding");
  redirect("/onboarding?step=services");
}

export async function finishServices() {
  const { clientId, settings } = await loadSettings();
  const supabase = await createClient();

  // Refuse to mark this done with an empty list. It is the one step whose
  // absence makes the agent unable to answer the most common question on the
  // line, and a client who clicks past it will not come back on their own.
  const { count } = await supabase
    .from("services")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId);

  if (!count) redirect("/onboarding?step=services&error=empty");

  await completeStep(clientId, settings, "services");
  redirect("/onboarding");
}

// ---------------------------------------------------------------------------
// Step 4 — store (ecommerce). Deferred: nowhere safe to put a key yet.
// ---------------------------------------------------------------------------

export async function deferStore(formData: FormData) {
  const { clientId, settings } = await loadSettings();

  const platform = String(formData.get("store_platform") ?? "").trim();
  const storeUrl = String(formData.get("store_base_url") ?? "").trim();

  // Records WHAT they have, never a credential. `store_credentials_ref` holds a
  // vault:// pointer and Vault is not implemented, so the keys are collected by
  // a human out of band. Writing a raw key into that column would put a
  // plaintext secret in a table the client's own dashboard can read.
  //
  // store_platform is deliberately NOT set on the client row here either:
  // provisionVoice refuses to provision a client with store_platform set and no
  // credentials ref, so writing it now would park them at needs_human.
  const next = {
    ...settings,
    store_intent: {
      platform: platform || null,
      base_url: storeUrl || null,
      noted_at: new Date().toISOString(),
    },
  };

  const supabase = await createClient();
  const { error } = await supabase
    .from("clients")
    .update({ settings: withStepDone(next, "store", { skipped: true }) })
    .eq("id", clientId);
  if (error) throw new Error(error.message);

  revalidatePath("/onboarding");
  redirect("/onboarding");
}

// ---------------------------------------------------------------------------
// Step 5 — number. Informational; operator buys it on Twilio.
// ---------------------------------------------------------------------------

export async function acknowledgeNumber() {
  const { clientId, settings } = await loadSettings();
  await completeStep(clientId, settings, "number");
  redirect("/onboarding");
}

// ---------------------------------------------------------------------------
// Step 6 — behaviour
// ---------------------------------------------------------------------------

/**
 * Structured answers go straight to their homes in settings. Free text does
 * NOT — it becomes a client_intake_request for a human to read.
 *
 * The rejected design wrote their words into settings.voice_instructions, which
 * voice-personalization injects verbatim into the system prompt. That is a text
 * box wired directly to what the agent promises real customers. A client would
 * reasonably write "always tell people we can come out same day" and their
 * agent would promise it, in their name, at 2am.
 */
export async function saveBehaviour(formData: FormData) {
  const { clientId, settings } = await loadSettings();
  const supabase = await createClient();

  const greeting = String(formData.get("greeting") ?? "").trim();
  const escalation = formData.get("escalation_mode") === "email" ? "email" : "callback";
  const neverSay = String(formData.get("never_say") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();

  const next = {
    ...settings,
    escalation_mode: escalation,
    ...(greeting ? { voice_greeting: greeting.slice(0, 300) } : {}),
  };

  const { error } = await supabase
    .from("clients")
    .update({ settings: withStepDone(next, "behaviour") })
    .eq("id", clientId);
  if (error) throw new Error(error.message);

  // Free text → the operator queue. RLS forces status='new' on insert, so this
  // cannot be submitted pre-approved.
  const requests: { client_id: string; topic: string; body: string }[] = [];
  if (neverSay) requests.push({ client_id: clientId, topic: "never_say", body: neverSay });
  if (notes) requests.push({ client_id: clientId, topic: "other", body: notes });

  if (requests.length) {
    const { error: reqErr } = await supabase.from("client_intake_requests").insert(requests);
    if (reqErr) throw new Error(reqErr.message);
  }

  redirect("/onboarding");
}

/** Standing channel after onboarding — the same queue, from the dashboard. */
export async function submitIntakeRequest(formData: FormData) {
  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login?next=%2Fonboarding");

  const body = String(formData.get("body") ?? "").trim();
  const topic = String(formData.get("topic") ?? "other").trim();
  if (!body) redirect("/onboarding?step=behaviour");

  const allowed = ["greeting", "tone", "never_say", "faq", "escalation", "hours", "other"];
  const supabase = await createClient();
  const { error } = await supabase.from("client_intake_requests").insert({
    client_id: clientId,
    topic: allowed.includes(topic) ? topic : "other",
    body,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/onboarding");
  redirect("/onboarding?step=behaviour&sent=1");
}
