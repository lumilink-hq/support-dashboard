import { peekSession } from "@/lib/loyalty-embedded/session-token";

// LL Loyalty embedded admin shell (0225, Phase 2 P4): the App URL of an
// embedded LL Loyalty app (shopify.app.<store>.toml / the public app).
//
// A whole HTML document from a route handler, not a page: App Bridge wants
// its meta tag and script first in <head>, which the root layout can't give,
// and the frame-ancestors header has to name the shop. Nothing here is
// trusted: the API key is public, the shop only shapes the frame header, and
// every action goes through /api/loyalty/embedded with a verified token.

const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,100}$/;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const shopParam = (url.searchParams.get("shop") ?? "").toLowerCase();
  const shop = SHOP.test(shopParam) ? shopParam : null;
  // The API key: from the id_token Shopify appends on first load, else ?app=.
  const peek = peekSession(url.searchParams.get("id_token") ?? "");
  const clientId = peek?.clientId ?? url.searchParams.get("app") ?? "";
  // Local harness only: no App Bridge outside Shopify admin.
  const harness = process.env.NODE_ENV !== "production" && url.searchParams.get("harness") === "1";

  const head = [
    CLIENT_ID.test(clientId) && !harness ? `<meta name="shopify-api-key" content="${esc(clientId)}" />` : "",
    harness ? "" : `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`,
    `<script src="https://cdn.shopify.com/shopifycloud/polaris-1.js"></script>`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
${head}
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LL Loyalty</title>
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, sans-serif; }
  #ll-app[aria-busy="true"] { opacity: .6; }
  .ll-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
  .ll-row { display: grid; gap: 12px; grid-template-columns: 1.2fr 1fr 1fr 2fr; align-items: end; }
  @media (max-width: 640px) { .ll-row { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div id="ll-app" data-shop="${esc(shop ?? "")}" data-harness="${harness ? "1" : ""}"></div>
<script src="/embedded/app.js"></script>
</body>
</html>`;

  const ancestors = shop ? `https://${shop} https://admin.shopify.com` : "https://admin.shopify.com";
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `frame-ancestors ${ancestors};`,
    },
  });
}
