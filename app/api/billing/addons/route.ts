import { NextResponse } from "next/server";
import { z } from "zod";
import { requireClientId } from "@/lib/entitlements";
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
