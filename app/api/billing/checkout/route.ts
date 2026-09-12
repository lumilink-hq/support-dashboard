import { NextResponse } from "next/server";
import { z } from "zod";
import { requireClientId } from "@/lib/entitlements";
import { BillingError, createCheckoutSessionForClient } from "@/lib/services/billing";
import { isStripeConfigured } from "@/lib/stripe";

const bodySchema = z.object({ tier: z.enum(["starter", "growth", "scale"]) });

export async function POST(request: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Billing isn't set up yet — check back soon." }, { status: 501 });
  }

  const clientId = await requireClientId();
  if (!clientId) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Same fallback chain as app/signup/actions.ts: explicit site URL, else the
  // request's own origin, else the Host header.
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    request.headers.get("origin") ??
    `https://${request.headers.get("host") ?? "localhost:3000"}`;

  try {
    const url = await createCheckoutSessionForClient({
      clientId,
      tier: parsed.data.tier,
      successUrl: `${origin}/welcome?checkout=success`,
      cancelUrl: `${origin}/plans?checkout=canceled`,
    });
    return NextResponse.json({ url });
  } catch (e) {
    if (e instanceof BillingError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    console.error("checkout session creation failed:", String(e));
    return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
  }
}
