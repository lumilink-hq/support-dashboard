// Pure helpers for loyalty-shopify (0203): the Admin GraphQL documents and
// the builders for their inputs. No network, no Deno APIs, so
// scripts/test-loyalty-shopify.ts tests them with tsx. Every document was
// validated against Admin API 2026-10 with the Shopify AI Toolkit.

export const METAFIELD_NAMESPACE = "ll_loyalty"; // merchant-owned, never $app (plan §1)

export const customerGid = (id: number | string) => `gid://shopify/Customer/${id}`;

/** The tag a member's tier is carried by; segments match on it. */
export const tierTag = (tierName: string) => `LL Tier ${tierName}`;

/** ShopifyQL segment: members of any of these tiers (perks apply "this tier and above"). */
export function tierSegmentQuery(tierNames: string[]): string {
  return tierNames.map((n) => `customer_tags CONTAINS '${tierTag(n).replace(/'/g, "\\'")}'`).join(" OR ");
}

export const SEGMENT_CREATE = `mutation LoyaltySegmentCreate($name: String!, $query: String!) {
  segmentCreate(name: $name, query: $query) {
    segment { id }
    userErrors { field message }
  }
}`;

export const SEGMENT_UPDATE = `mutation LoyaltySegmentUpdate($id: ID!, $query: String!) {
  segmentUpdate(id: $id, query: $query) {
    segment { id }
    userErrors { field message }
  }
}`;

export const FREE_SHIPPING_CREATE = `mutation LoyaltyFreeShippingCreate($input: DiscountAutomaticFreeShippingInput!) {
  discountAutomaticFreeShippingCreate(freeShippingAutomaticDiscount: $input) {
    automaticDiscountNode { id }
    userErrors { field message code }
  }
}`;

export const AUTOMATIC_BASIC_CREATE = `mutation LoyaltyAutomaticBasicCreate($input: DiscountAutomaticBasicInput!) {
  discountAutomaticBasicCreate(automaticBasicDiscount: $input) {
    automaticDiscountNode { id }
    userErrors { field message code }
  }
}`;

export const AUTOMATIC_DELETE = `mutation LoyaltyAutomaticDelete($id: ID!) {
  discountAutomaticDelete(id: $id) {
    deletedAutomaticDiscountId
    userErrors { field message code }
  }
}`;

export const CODE_BASIC_CREATE = `mutation LoyaltyCodeCreate($input: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $input) {
    codeDiscountNode { id }
    userErrors { field message code }
  }
}`;

// Title too: an existing code is only adopted as ours if the title matches
// (Joy's WAVE- codes live in the same store; a random collision must not
// hand a member someone else's code).
export const CODE_LOOKUP = `query LoyaltyCodeLookup($code: String!) {
  codeDiscountNodeByCode(code: $code) {
    id
    codeDiscount { ... on DiscountCodeBasic { title } }
  }
}`;

export const METAFIELDS_SET = `mutation LoyaltyMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id }
    userErrors { field message code }
  }
}`;

export const METAFIELD_DEFINITION_CREATE = `mutation LoyaltyMetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id }
    userErrors { field message code }
  }
}`;

/**
 * The metafields the theme reads (storefront read access). Customer: tier and
 * points (0203), tier spend and holdout group (0212, the cart line). Shop: the
 * program rules as JSON (0212), so the theme never hard-codes them.
 */
export const METAFIELD_DEFINITIONS = [
  { key: "tier", name: "Loyalty tier", type: "single_line_text_field", ownerType: "CUSTOMER", description: "LL Loyalty tier name (Bronze, Silver, Gold)." },
  { key: "points", name: "Loyalty points", type: "number_integer", ownerType: "CUSTOMER", description: "LL Loyalty points balance." },
  { key: "tier_spend_cents", name: "Loyalty tier spend", type: "number_integer", ownerType: "CUSTOMER", description: "LL Loyalty spend counted toward the tier, in cents." },
  { key: "group", name: "Loyalty group", type: "single_line_text_field", ownerType: "CUSTOMER", description: "LL Loyalty measurement group: treatment or holdout." },
  { key: "program", name: "Loyalty program", type: "json", ownerType: "SHOP", description: "LL Loyalty rules for the theme: tiers, rewards, points per dollar." },
].map((d) => ({
  namespace: METAFIELD_NAMESPACE,
  key: d.key,
  name: d.name,
  description: d.description,
  type: d.type,
  ownerType: d.ownerType,
  access: { storefront: "PUBLIC_READ" },
}));

export const SHOP_ID = `query LoyaltyShopId { shop { id } }`;

/** metafieldsSet input for the shop's program rules. */
export const programMetafield = (shopGid: string, value: unknown) =>
  ({ ownerId: shopGid, namespace: METAFIELD_NAMESPACE, key: "program", type: "json", value: JSON.stringify(value) });

/**
 * One request that moves several members' tier tags: tagsAdd for the current
 * tier, tagsRemove for every other tier tag. Aliased so N members cost one
 * round trip.
 */
export function tierTagsMutation(members: { customerId: number; tierName: string }[], allTierNames: string[]): { query: string; variables: Record<string, unknown> } {
  const defs: string[] = [];
  const body: string[] = [];
  const variables: Record<string, unknown> = {};
  members.forEach((m, i) => {
    defs.push(`$id${i}: ID!`, `$add${i}: [String!]!`, `$rm${i}: [String!]!`);
    body.push(
      `a${i}: tagsAdd(id: $id${i}, tags: $add${i}) { userErrors { field message } }`,
      `r${i}: tagsRemove(id: $id${i}, tags: $rm${i}) { userErrors { field message } }`,
    );
    variables[`id${i}`] = customerGid(m.customerId);
    variables[`add${i}`] = [tierTag(m.tierName)];
    variables[`rm${i}`] = allTierNames.filter((n) => n !== m.tierName).map(tierTag);
  });
  return { query: `mutation LoyaltyTierTags(${defs.join(", ")}) {\n  ${body.join("\n  ")}\n}`, variables };
}

export const orderGid = (id: number | string) => `gid://shopify/Order/${id}`;

/** One request that tags several orders (aliased tagsAdd). */
export function orderTagsMutation(orders: { orderId: number; tags: string[] }[]): { query: string; variables: Record<string, unknown> } {
  const defs: string[] = [];
  const body: string[] = [];
  const variables: Record<string, unknown> = {};
  orders.forEach((o, i) => {
    defs.push(`$id${i}: ID!`, `$tags${i}: [String!]!`);
    body.push(`o${i}: tagsAdd(id: $id${i}, tags: $tags${i}) { userErrors { field message } }`);
    variables[`id${i}`] = orderGid(o.orderId);
    variables[`tags${i}`] = o.tags;
  });
  return { query: `mutation LoyaltyOrderTags(${defs.join(", ")}) {\n  ${body.join("\n  ")}\n}`, variables };
}

/** metafieldsSet inputs for members' tier, points, tier spend and group (4 each; max 25 per call: 6 members). */
export function memberMetafields(members: { customerId: number; tierName: string; points: number; tierSpendCents: number; group: string }[]) {
  return members.flatMap((m) => {
    const ownerId = customerGid(m.customerId);
    return [
      { ownerId, namespace: METAFIELD_NAMESPACE, key: "tier", type: "single_line_text_field", value: m.tierName },
      { ownerId, namespace: METAFIELD_NAMESPACE, key: "points", type: "number_integer", value: String(Math.trunc(m.points)) },
      { ownerId, namespace: METAFIELD_NAMESPACE, key: "tier_spend_cents", type: "number_integer", value: String(Math.trunc(m.tierSpendCents)) },
      { ownerId, namespace: METAFIELD_NAMESPACE, key: "group", type: "single_line_text_field", value: m.group },
    ];
  });
}

const money = (cents: number) => (cents / 100).toFixed(2);

export type Combines = { orderDiscounts?: boolean; productDiscounts?: boolean; shippingDiscounts?: boolean };

export type CodeRow = {
  code: string;
  title: string;
  value_cents: number;
  min_order_cents: number;
  customer_id: number | null; // null = anyone (the referred friend has no account yet)
  ends_at: string | null;
  combines: Combines;
};

/** A single-use amount-off code: a points redemption or the referred friend's coupon. */
export function codeDiscountInput(c: CodeRow, startsAt: string) {
  return {
    title: c.title,
    code: c.code,
    startsAt,
    endsAt: c.ends_at,
    context: c.customer_id ? { customers: { add: [customerGid(c.customer_id)] } } : { all: "ALL" },
    customerGets: { value: { discountAmount: { amount: money(c.value_cents), appliesOnEachItem: false } }, items: { all: true } },
    minimumRequirement: c.min_order_cents > 0 ? { subtotal: { greaterThanOrEqualToSubtotal: money(c.min_order_cents) } } : null,
    usageLimit: 1,
    appliesOncePerCustomer: true,
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true, ...c.combines },
  };
}

export type PerkRow = {
  key: string;
  title: string;
  kind: "free_shipping" | "percent_off_products";
  min_subtotal_cents: number;
  percent: number | null;
  collection_gids: string[];
  product_gids: string[];
  combines: Combines;
};

/** An automatic tier perk, limited to the tier segment(s). */
export function perkDiscountInput(p: PerkRow, segmentIds: string[], startsAt: string) {
  const context = { customerSegments: { add: segmentIds } };
  const minimumRequirement = p.min_subtotal_cents > 0 ? { subtotal: { greaterThanOrEqualToSubtotal: money(p.min_subtotal_cents) } } : null;
  if (p.kind === "free_shipping") {
    return {
      title: p.title,
      startsAt,
      context,
      minimumRequirement,
      destination: { all: true },
      combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: false, ...p.combines },
    };
  }
  if (!p.percent || p.percent <= 0 || p.percent > 100) throw new Error(`perk ${p.key}: percent must be 1-100`);
  if (p.collection_gids.length === 0 && p.product_gids.length === 0) throw new Error(`perk ${p.key}: needs products or collections`);
  return {
    title: p.title,
    startsAt,
    context,
    minimumRequirement,
    customerGets: {
      value: { percentage: p.percent / 100 },
      items: p.collection_gids.length > 0 ? { collections: { add: p.collection_gids } } : { products: { productsToAdd: p.product_gids } },
    },
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true, ...p.combines },
  };
}

/** Shopify's userErrors, flattened. Empty string = none. */
export function userErrorText(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) return "";
  return errors.map((e) => {
    const x = e as { field?: string[] | null; message?: string; code?: string };
    return [x.field?.join("."), x.message, x.code ? `(${x.code})` : ""].filter(Boolean).join(" ");
  }).join("; ");
}

/** A create that failed only because this code already exists (an earlier attempt landed). */
export function isCodeTaken(errors: unknown): boolean {
  return Array.isArray(errors) && errors.length > 0 &&
    errors.every((e) => /already|taken|unique/i.test(String((e as { message?: string }).message ?? "")) || (e as { code?: string }).code === "TAKEN");
}
