import { formatDateTime, formatMoney, humanize, timeAgo } from "@/lib/format";
import type { OrderRow } from "@/lib/types";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="text-right text-gray-900">{children}</span>
    </div>
  );
}

export function OrderPanel({
  order,
  orderNumber,
}: {
  order: OrderRow | null;
  orderNumber: string | null;
}) {
  return (
    <aside className="w-full shrink-0 rounded-lg border border-gray-200 bg-white p-4 lg:w-80">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Order context</h2>
        {orderNumber ? (
          <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600">
            #{orderNumber}
          </span>
        ) : null}
      </div>

      {!orderNumber ? (
        <p className="mt-3 text-sm text-gray-400">
          No order number on this conversation yet.
        </p>
      ) : !order ? (
        <p className="mt-3 text-sm text-gray-400">
          Order #{orderNumber} isn&apos;t cached yet. It populates after the agent
          looks it up.
        </p>
      ) : (
        <div className="mt-3 divide-y divide-gray-100">
          <div className="pb-2">
            <Row label="Status">
              <span className="capitalize">{humanize(order.store_status)}</span>
              {order.is_abnormal ? (
                <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                  abnormal
                </span>
              ) : null}
            </Row>
            <Row label="Placed">
              {formatDateTime(order.order_placed_at)}
            </Row>
            <Row label="Total">
              {formatMoney(order.order_total, order.currency)}
            </Row>
            <Row label="Platform">
              <span className="capitalize">{humanize(order.store_platform)}</span>
            </Row>
          </div>

          <div className="py-2">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">
              Items
            </p>
            <ul className="space-y-1">
              {order.line_items.length === 0 ? (
                <li className="text-sm text-gray-400">—</li>
              ) : (
                order.line_items.map((li, i) => (
                  <li key={i} className="flex justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate text-gray-700">
                      {li.quantity ? `${li.quantity}× ` : ""}
                      {li.name || li.sku || "Item"}
                    </span>
                    {li.total ? (
                      <span className="shrink-0 text-gray-500">
                        {formatMoney(li.total, order.currency)}
                      </span>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
          </div>

          <div className="pt-2">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">
              Shipping
            </p>
            {order.tracking_number ? (
              <>
                <Row label="Carrier">{humanize(order.carrier)}</Row>
                <Row label="Tracking">
                  <span className="font-mono text-xs">{order.tracking_number}</span>
                </Row>
                <Row label="Status">{humanize(order.shipping_status)}</Row>
                {order.estimated_delivery ? (
                  <Row label="Est. delivery">
                    {formatDateTime(order.estimated_delivery)}
                  </Row>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-gray-400">No shipping info yet.</p>
            )}
          </div>

          <p className="pt-2 text-xs text-gray-400">
            Snapshot fetched {timeAgo(order.fetched_at)}
          </p>
        </div>
      )}
    </aside>
  );
}
