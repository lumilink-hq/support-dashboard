// purchase.thank-you.block.render — points for the order just placed.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { OrderBlock, useLoyalty } from "./shared.jsx";

export default function extension() {
  render(<ThankYou />, document.body);
}

function ThankYou() {
  const orderGid = shopify.orderConfirmation?.value?.order?.id ?? null;
  const state = useLoyalty(orderGid, { retryUntilRecorded: true });
  // Estimate only: subtotal after line discounts, no shipping or tax (how orders earn, plan §9).
  const amount = Number(shopify.cost?.subtotalAmount?.value?.amount ?? 0);
  return <OrderBlock state={state} subtotalCents={Math.round(amount * 100)} />;
}
