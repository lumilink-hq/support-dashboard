// Pure helpers for loyalty-backfill: the Admin GraphQL queries and the
// mapping from their nodes to the JSON that loyalty_sync_customers /
// loyalty_record_orders (0201) take. No network, no Deno APIs, so
// scripts/test-loyalty-backfill.ts tests them with tsx.

import { moneyToCents } from "../loyalty-webhooks/lib.ts";

export const API_VERSION = "2026-10";

const CUSTOMER_FIELDS = `legacyResourceId firstName lastName state createdAt defaultEmailAddress { emailAddress }`;

export const CUSTOMERS_QUERY = `query LoyaltyCustomers($cursor: String) {
  customers(first: 250, after: $cursor, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes { ${CUSTOMER_FIELDS} }
  }
}`;

// subtotalPriceSet: after discounts, before shipping/tax (the webhook's
// subtotal_price). currentSubtotalPriceSet: the same after refunds/returns.
export const ORDERS_QUERY = `query LoyaltyOrders($cursor: String, $q: String!) {
  orders(first: 100, after: $cursor, sortKey: PROCESSED_AT, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId name processedAt
      subtotalPriceSet { shopMoney { amount } }
      currentSubtotalPriceSet { shopMoney { amount } }
      customer { ${CUSTOMER_FIELDS} }
    }
  }
}`;

/** Orders that were paid (including since-refunded ones), processed before the live cut-off. */
export function ordersSearch(before: string): string {
  const iso = new Date(before).toISOString();
  return `processed_at:<'${iso}' AND (financial_status:paid OR financial_status:partially_refunded OR financial_status:refunded)`;
}

type Page<T> = { nodes: T[]; hasNext: boolean; cursor: string | null };

type CustomerNode = {
  legacyResourceId?: string;
  firstName?: string | null;
  lastName?: string | null;
  state?: string | null;
  createdAt?: string | null;
  defaultEmailAddress?: { emailAddress?: string | null } | null;
};

export type CustomerJson = { id: number; email: string | null; first_name: string | null; last_name: string | null; state: string | null; created_at: string | null };

export function customerJson(c: CustomerNode | null | undefined): CustomerJson | null {
  const id = Number(c?.legacyResourceId);
  if (!c || !Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    email: c.defaultEmailAddress?.emailAddress ?? null,
    first_name: c.firstName ?? null,
    last_name: c.lastName ?? null,
    state: c.state ? c.state.toLowerCase() : null, // ENABLED -> 'enabled', as the REST webhooks send it
    created_at: c.createdAt ?? null,
  };
}

function page<T>(conn: unknown): Page<T> {
  const c = conn as { nodes?: T[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } | null;
  return { nodes: c?.nodes ?? [], hasNext: Boolean(c?.pageInfo?.hasNextPage), cursor: c?.pageInfo?.endCursor ?? null };
}

export function parseCustomersPage(data: unknown): Page<CustomerJson> {
  const p = page<CustomerNode>((data as { customers?: unknown } | null)?.customers);
  return { ...p, nodes: p.nodes.map(customerJson).filter((c): c is CustomerJson => c !== null) };
}

type OrderNode = {
  legacyResourceId?: string;
  name?: string;
  processedAt?: string;
  subtotalPriceSet?: { shopMoney?: { amount?: string } };
  currentSubtotalPriceSet?: { shopMoney?: { amount?: string } };
  customer?: CustomerNode | null;
};

export type OrderJson = {
  id: number;
  name: string | null;
  processed_at: string | null;
  eligible_cents: number;
  net_eligible_cents: number;
  customer: CustomerJson | null;
};

export function parseOrdersPage(data: unknown): Page<OrderJson> {
  const p = page<OrderNode>((data as { orders?: unknown } | null)?.orders);
  const nodes: OrderJson[] = [];
  for (const o of p.nodes) {
    const id = Number(o.legacyResourceId);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const customer = customerJson(o.customer);
    if (!customer) continue; // guest checkout: never a member
    const eligible = Math.max(moneyToCents(o.subtotalPriceSet?.shopMoney?.amount) ?? 0, 0);
    const net = Math.min(Math.max(moneyToCents(o.currentSubtotalPriceSet?.shopMoney?.amount) ?? eligible, 0), eligible);
    nodes.push({ id, name: o.name ?? null, processed_at: o.processedAt ?? null, eligible_cents: eligible, net_eligible_cents: net, customer });
  }
  return { ...p, nodes };
}

/**
 * How long to wait before the next query so we never hit THROTTLED: if fewer
 * points are left than the last query cost (twice over), wait for the bucket
 * to refill that much at its restore rate.
 */
export function throttleWaitMs(extensions: unknown): number {
  const cost = (extensions as { cost?: { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } } | null)?.cost;
  const need = 2 * (cost?.requestedQueryCost ?? 0);
  const have = cost?.throttleStatus?.currentlyAvailable ?? need;
  const rate = cost?.throttleStatus?.restoreRate ?? 50;
  if (have >= need || rate <= 0) return 0;
  return Math.ceil(((need - have) / rate) * 1000);
}

/** True when a GraphQL error list is only Shopify's throttle. */
export function isThrottled(errors: unknown): boolean {
  return Array.isArray(errors) && errors.length > 0 &&
    errors.every((e) => (e as { extensions?: { code?: string } })?.extensions?.code === "THROTTLED");
}
