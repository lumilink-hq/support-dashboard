import { NextResponse } from "next/server";
import { z } from "zod";
import { ADMIN_ONLY_BILLING_MESSAGE, getMembership } from "@/lib/roles";
import { addAddonToClient, BillingError, removeAddonFromClient } from "@/lib/services/billing";
import { isStripeConfigured } from "@/lib/stripe";

const bodySchema = z.object({ addonKey: z.string() });

export async function POST(request: Request) {
  return mutate(request, addAddonToClient);
}

export async function DELETE(request: Request) {
  return mutate(request, removeAddonFromClient);
}

async function mutate(
  request: Request,
  action: (input: { clientId: string; addonKey: string }) => Promise<void>,
) {
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

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    await action({ clientId, addonKey: parsed.data.addonKey });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof BillingError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    console.error("add-on mutation failed:", String(e));
    return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
  }
}
