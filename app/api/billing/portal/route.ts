import { NextResponse } from "next/server";
import { requireClientId } from "@/lib/entitlements";
import { BillingError, createBillingPortalSessionForClient } from "@/lib/services/billing";
import { isStripeConfigured } from "@/lib/stripe";

export async function POST(request: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Billing isn't set up yet — check back soon." }, { status: 501 });
  }

  const clientId = await requireClientId();
  if (!clientId) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  // Same fallback chain as app/signup/actions.ts.
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    request.headers.get("origin") ??
    `https://${request.headers.get("host") ?? "localhost:3000"}`;

  try {
    const url = await createBillingPortalSessionForClient({
      clientId,
      returnUrl: `${origin}/billing`,
    });
    return NextResponse.json({ url });
  } catch (e) {
    if (e instanceof BillingError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    console.error("billing portal session creation failed:", String(e));
    return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
  }
}
