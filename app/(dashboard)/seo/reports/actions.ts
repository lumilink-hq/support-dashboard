"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentClientId } from "@/lib/entitlements";
import { getSeoAccess } from "@/lib/seo-access";
import { createClient } from "@/lib/supabase/server";

const REGENERATE_COOLDOWN_MS = 5 * 60 * 1000;

function back(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return `/seo/reports${qs ? `?${qs}` : ""}`;
}

/**
 * Prepare the report for the month just ended now, instead of waiting for the
 * 1st. It calls the same seo-report function the schedule does, with the
 * shared secret, for the CALLER'S OWN client only: the client id comes from the
 * session, never from the form.
 *
 * Safe to repeat: the function rebuilds the same month in place and won't email
 * a report that already went out. The cooldown just stops a double-click from
 * running the whole thing twice.
 */
export async function generateReportNow() {
  const access = await getSeoAccess();
  if (!access.allowed) redirect(back({ error: "Local SEO isn't active on your plan." }));

  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login");

  const secret = process.env.VOICE_TOOL_SECRET;
  const base = process.env.SEO_REPORT_URL || (process.env.NEXT_PUBLIC_SUPABASE_URL ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/seo-report` : "");
  if (!secret || !base) redirect(back({ error: "Report generation isn't configured on this server." }));

  const supabase = await createClient();
  const { data: recent } = await supabase
    .from("seo_reports")
    .select("updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recent?.updated_at && Date.now() - new Date(recent.updated_at as string).getTime() < REGENERATE_COOLDOWN_MS) {
    redirect(back({ notice: "A report was just prepared. Give it a few minutes before rebuilding." }));
  }

  let ok = false;
  let message = "";
  try {
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-voice-tool-secret": secret },
      body: JSON.stringify({ client_id: clientId }),
      signal: AbortSignal.timeout(110_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; period?: string };
    ok = res.ok && body.ok !== false;
    message = ok ? `Prepared the ${body.period ?? "latest"} report.` : body.error || `The report service answered ${res.status}.`;
  } catch {
    message = "The report service didn't respond in time. Try again in a minute.";
  }

  revalidatePath("/seo/reports");
  redirect(ok ? back({ notice: message }) : back({ error: message }));
}
