// POST /api/billing/seo-checkout — module 12's missing piece: the actual
// entry point that calls createSeoCheckoutSessionForClient (lib/services/
// billing.ts), which existed since module 12 but had nothing wired to it.
// Mirrors app/api/billing/checkout/route.ts (the voice tier picker's route)
// almost exactly — the difference is `locationCount` (a number the client
// chooses) alongside `plan` (lib/seo-pricing.ts's SEO_PLANS).
import { NextResponse } from "next/server";
import { z } from "zod";
import { ADMIN_ONLY_BILLING_MESSAGE, getMembership } from "@/lib/roles";
import { BillingError, createSeoCheckoutSessionForClient } from "@/lib/services/billing";
import { isStripeConfigured } from "@/lib/stripe";
import { availableSeoPlans, isSeoCheckoutConfigured, seoCheckoutLocationError } from "@/lib/seo-pricing";
import { createClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  plan: z.enum(["website", "local", "bundle"]),
  locationCount: z.number().int().min(0).max(1000),
});

export async function POST(request: Request) {
  const me = await getMembership();
  if (!me) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  // Billing is admin-only (0082 roles). This route charges with the service
  // role, so there is no database policy behind it: this check is the gate.
  if (me.role !== "admin") {
    return NextResponse.json({ error: ADMIN_ONLY_BILLING_MESSAGE }, { status: 403 });
  }
  const clientId = me.clientId;

  if (!isStripeConfigured() || !isSeoCheckoutConfigured()) {
    return NextResponse.json({ error: "SEO billing isn't set up yet — check back soon." }, { status: 501 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Pick a plan and a valid number of locations." }, { status: 400 });
  }
  if (!availableSeoPlans().some((p) => p.key === parsed.data.plan)) {
    return NextResponse.json({ error: "That plan isn't available yet." }, { status: 400 });
  }

  // Never sell fewer locations than are already active (0092 caps them at the
  // paid count afterwards). The caller's own session, so RLS scopes the count.
  const supabase = await createClient();
  const { count: activeLocations, error: countErr } = await supabase
    .from("seo_locations")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .eq("is_active", true);
  if (countErr) {
    console.error("seo checkout location count failed:", countErr.message);
    return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
  }
  const locationError = seoCheckoutLocationError(parsed.data.plan, parsed.data.locationCount, activeLocations ?? 0);
  if (locationError) {
    return NextResponse.json({ error: locationError }, { status: 400 });
  }

  // Same fallback chain as app/signup/actions.ts and the voice checkout route.
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    request.headers.get("origin") ??
    `https://${request.headers.get("host") ?? "localhost:3000"}`;

  try {
    const url = await createSeoCheckoutSessionForClient({
      clientId,
      plan: parsed.data.plan,
      locationCount: parsed.data.locationCount,
      // Straight back to onboarding, not /welcome (that page is voice/addon
      // copy) — "you just paid, now let's finish your locations" is the
      // right next step whether or not they've started that wizard yet.
      successUrl: `${origin}/onboarding?checkout=success`,
      cancelUrl: `${origin}/billing?checkout=canceled`,
    });
    return NextResponse.json({ url });
  } catch (e) {
    if (e instanceof BillingError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    console.error("seo checkout session creation failed:", String(e));
    return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
  }
}
