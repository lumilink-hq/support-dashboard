import { NextResponse } from "next/server";
import { ADMIN_ONLY_BILLING_MESSAGE, getMembership } from "@/lib/roles";
import { BillingError, createBillingPortalSessionForClient } from "@/lib/services/billing";
import { isStripeConfigured } from "@/lib/stripe";

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

  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Billing isn't set up yet — check back soon." }, { status: 501 });
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
