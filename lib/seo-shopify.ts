// The "Shopify store" card on /seo > Settings (0077). Pure, so
// scripts/test-seo-shopify.ts can test it with plain tsx.

export type ShopifyConnectInfo = { shop_domain: string; connected_at: string | null; last_error: string | null };
export type SiteConnection = { platform?: string | null; status: string; shop_domain: string; last_error: string | null; granted_scopes?: string[] | null };

/** The shopify-oauth function's start URL for a registered store. */
export function shopifyConnectUrl(supabaseUrl: string, shop: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/shopify-oauth?shop=${encodeURIComponent(shop)}`;
}

export type ShopifyCard =
  | { kind: "hidden" }
  | { kind: "not_registered"; text: string }
  | { kind: "connect"; shop: string; text: string; tone: "neutral" | "warn" }
  | { kind: "connected"; shop: string; text: string; tone: "ok" | "warn" };

/**
 * What the card says. A GitHub site (0075) has no Shopify card. A store that
 * isn't registered for Connect Shopify can't connect itself: LumiLink sets up
 * a small app per store first.
 */
export function shopifyCard(input: { info: ShopifyConnectInfo | null; conn: SiteConnection | null }): ShopifyCard {
  const { info, conn } = input;
  if (conn?.platform === "github") return { kind: "hidden" };
  if (!info) {
    return conn
      ? { kind: "not_registered", text: `This location publishes to ${conn.shop_domain}, but Connect Shopify isn't set up for it yet. Ask LumiLink to set it up.` }
      : { kind: "not_registered", text: "If your website runs on Shopify, LumiLink can publish approved fixes to it. Ask LumiLink to set up Connect Shopify for your store." };
  }
  if (!info.connected_at) {
    return info.last_error
      ? { kind: "connect", shop: info.shop_domain, tone: "warn", text: `The last attempt failed: ${info.last_error}. Try again; you need to be an owner or staff member who can install apps.` }
      : { kind: "connect", shop: info.shop_domain, tone: "neutral", text: `Approve LumiLink's app on ${info.shop_domain} once, in Shopify. You need to be the owner or a staff member who can install apps.` };
  }
  if (!conn) return { kind: "connected", shop: info.shop_domain, tone: "ok", text: `Connected to ${info.shop_domain}.` };
  if (conn.status === "healthy") return { kind: "connected", shop: info.shop_domain, tone: "ok", text: `Connected to ${info.shop_domain}. Approved fixes publish automatically.` };
  if (conn.status === "unchecked") return { kind: "connected", shop: info.shop_domain, tone: "ok", text: `Connected to ${info.shop_domain}. Checking the connection now.` };
  if (conn.status === "degraded") return { kind: "connected", shop: info.shop_domain, tone: "warn", text: `Connected to ${info.shop_domain}, but some permissions are missing, so some fixes become manual steps.` };
  return { kind: "connect", shop: info.shop_domain, tone: "warn", text: `The last check of ${info.shop_domain} failed${conn.last_error ? ` (${conn.last_error.slice(0, 160)})` : ""}. Reconnect to fix it.` };
}
