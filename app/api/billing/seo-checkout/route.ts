// POST /api/billing/seo-checkout — module 12's missing piece: the actual
// entry point that calls createSeoCheckoutSessionForClient (lib/services/
// billing.ts), which existed since module 12 but had nothing wired to it.
// Mirrors app/api/billing/checkout/route.ts (the voice tier picker's route)
// almost exactly — the one real difference is `locationCount` (a number the
// client chooses) in place of `tier` (a fixed enum).
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireClientId } from "@/lib/entitlements";
import { BillingError, createSeoCheckoutSessionForClient } from "@/lib/services/billing";
import { isStripeConfigured } from "@/lib/stripe";
import { isSeoCheckoutConfigured } from "@/lib/seo-pricing";

const bodySchema = z.object({ locationCount: z.number().int().min(1).max(1000) });

export async function POST(request: Request) {
  if (!isStripeConfigured() || !isSeoCheckoutConfigured()) {
    return NextResponse.json({ error: "SEO billing isn't set up yet — check back soon." }, { status: 501 });
  }

  const clientId = await requireClientId();
  if (!clientId) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid number of locations." }, { status: 400 });
  }

  // Same fallback chain as app/signup/actions.ts and the voice checkout route.
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    request.headers.get("origin") ??
    `https://${request.headers.get("host") ?? "localhost:3000"}`;

  try {
    const url = await createSeoCheckoutSessionForClient({
      clientId,
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
