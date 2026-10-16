// What a Stripe subscription's current state means for the workspace's
// entitlement. Pure, so scripts/test-billing-activation.ts can cover every
// status without Stripe or a database; lib/services/billing.ts acts on it.
//
// WHY THE INVOICE MATTERS (2026-10-15, ACH launch). ACH Direct Debit is a
// delayed payment method: the first debit takes ~4 business days to clear,
// and Stripe's own guide warns a subscription "can become active while its
// first payment is still processing". Before this, every status except
// past_due granted access, so an ACH customer got the product the moment they
// entered bank details, and kept it if the debit then bounced. Now access
// starts only when the subscription's latest invoice is actually paid (cards
// settle instantly, so for them nothing changes). The webhook also listens for
// invoice.paid, which is what finally grants access once ACH clears.
//
// RENEWALS. While an ACH renewal is processing, the subscription stays active
// with an open latest invoice. "await_payment" changes nothing, so a client
// who already has access keeps it; the period end moves forward on
// invoice.paid. A failed renewal moves the subscription to past_due, which is
// "payment_failed" as before.

export type SubscriptionAction =
  /** Paid: grant or refresh access (apply_billing_event subscription_activated). */
  | "activate"
  /** Payment failed: mark past_due (apply_billing_event payment_failed). */
  | "payment_failed"
  /** Not paid yet (ACH still clearing, 3DS pending): change nothing. */
  | "await_payment"
  /** Nothing to do from this event (cancellation has its own handler). */
  | "ignore";

export type LatestInvoiceState = { status: string | null } | null;

export function subscriptionAction(
  status: string,
  latestInvoice: LatestInvoiceState,
): SubscriptionAction {
  switch (status) {
    case "past_due":
    case "unpaid":
      return "payment_failed";
    case "active":
    case "trialing":
      // A trial's first invoice is $0 and Stripe marks it paid straight away.
      return latestInvoice?.status === "paid" ? "activate" : "await_payment";
    case "incomplete":
    case "incomplete_expired":
      // The first payment never completed: nothing was ever granted.
      return "await_payment";
    default:
      // canceled (customer.subscription.deleted handles it), paused.
      return "ignore";
  }
}

/**
 * A hand-granted trial (source 'trial', e.g. PACKS) that is still running.
 * /billing offers such a workspace the normal checkout instead of the "you're
 * subscribed" panel. Their service keeps running while an ACH payment clears,
 * because the trial row stays active; once the first invoice is paid,
 * apply_billing_event attaches the subscription to that same row and
 * lib/services/billing.ts flips its source to 'checkout'. 'manual' grants (our
 * own workspace) are not offered checkout.
 */
export function isRunningTrial(row: { status: string; source: string } | null | undefined): boolean {
  return !!row && row.source === "trial" && (row.status === "active" || row.status === "past_due");
}

/**
 * The subscription id an invoice belongs to, across Stripe API versions
 * (2025-03-31 moved it to invoice.parent.subscription_details), or null for a
 * one-off invoice.
 */
export function subscriptionIdFromInvoice(invoice: {
  parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
  subscription?: string | { id: string } | null;
}): string | null {
  const ref = invoice.parent?.subscription_details?.subscription ?? invoice.subscription ?? null;
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}
