// Where a just-authenticated user should land.
//
// WHY THIS EXISTS (2026-08-12). Nothing sent anyone to /onboarding. Sign-in
// redirected to `next` (default /conversations), email confirmation did the
// same, and buying a plan handed off to Stripe — so a brand-new customer's
// first screen was an EMPTY CONVERSATIONS LIST. The wizard was built, resumable,
// with blocking steps and a "here's why you're not live yet" panel, and the only
// way to reach it was to type the URL. Nothing linked to it.
//
// That is worse than not having onboarding: the client sits on a dashboard that
// shows nothing, their agent never goes live because `basics` and `services` are
// unfinished, and nobody is told why.
//
// SCOPED DELIBERATELY. This runs at the moment of authentication only — not as a
// layout gate. A gate that bounces every request to /onboarding until it is
// complete means a client who wants to look at settings, or read a transcript
// from a call that already happened, cannot. They get sent to the wizard on
// sign-in, and after that the dashboard is theirs.
//
// AN EXPLICIT DESTINATION ALWAYS WINS. Someone returning to checkout via
// /login?next=/plans asked for a specific page; sending them to the wizard
// instead loses the sale. Only the default destination is overridden.

import { createClient } from "@/lib/supabase/server";
import { getCurrentClientId } from "@/lib/entitlements";
import { blockingRemaining, readOnboarding, type BusinessType } from "@/lib/onboarding";

/** The default post-auth destination, i.e. "the user did not ask for anywhere". */
export const DEFAULT_LANDING = "/conversations";

/**
 * Resolve where to send someone who has just signed in or confirmed their email.
 *
 * @param requestedNext already sanitised by safeNextPath — this function does no
 *                      validation of its own and must never be given raw input.
 */
export async function landingPathAfterAuth(requestedNext: string): Promise<string> {
  // Respect anything the user explicitly asked for.
  if (requestedNext !== DEFAULT_LANDING) return requestedNext;

  try {
    const clientId = await getCurrentClientId();
    // No client row yet means the signup trigger hasn't run or the user isn't
    // linked to a tenant. The dashboard handles that case; don't invent a
    // second failure mode here.
    if (!clientId) return requestedNext;

    const supabase = await createClient();
    const { data } = await supabase
      .from("clients")
      .select("business_type, settings")
      .eq("id", clientId)
      .maybeSingle();

    const settings = (data?.settings ?? {}) as Record<string, unknown>;
    const businessType = (data?.business_type ?? null) as BusinessType | null;

    // BLOCKING steps only. A client who skipped the optional website step is
    // live and working; dragging them back to the wizard every sign-in would be
    // nagging, not onboarding.
    return blockingRemaining(readOnboarding(settings), businessType).length > 0
      ? "/onboarding"
      : requestedNext;
  } catch (e) {
    // Never let this stand between a user and their dashboard. Landing on
    // /conversations with setup incomplete is the old behaviour; failing to sign
    // in would be new and worse.
    console.error("[post-auth] landing check failed, using default:", e);
    return requestedNext;
  }
}
