// customer-account.order-status.block.render — points for this order.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { OrderBlock, useLoyalty } from "./shared.jsx";

export default function extension() {
  render(<OrderStatus />, document.body);
}

function OrderStatus() {
  const orderGid = shopify.order?.value?.id ?? null;
  const state = useLoyalty(orderGid);
  // No estimate here: by the time a buyer opens order status the order is recorded,
  // and an unrecorded one (not paid yet) earns nothing yet.
  return <OrderBlock state={state} subtotalCents={0} />;
}
