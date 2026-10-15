# Cart drawer loyalty line (for Tsunami's theme)

`ll-cart-loyalty.liquid` goes into Tsunami's Tinker theme as `snippets/ll-cart-loyalty.liquid`. It isn't
deployed with the app, because the drawer is rendered from `snippets/header-actions.liquid` and has no
app-block slot (plan §9). J owns the theme, so J installs it.

## Install

1. Copy the file into the theme's `snippets/` folder (work on a duplicate theme first).
2. In `snippets/cart-rewards-bar.liquid`, where the loyalty prompt is hidden today, render it:
   `{% render 'll-cart-loyalty', cart: cart %}`
3. Point the refresh hook at Tinker's drawer refresh, so applying a code redraws the drawer without a
   reload. Anywhere after the theme's scripts:
   `<script>window.llCartRefresh = function (cart) { /* Tinker's cart refresh, e.g. its cart:update event */ };</script>`
   Without it, the page reloads after a code is applied (works, just less smooth).
4. Style `.ll-cart-loyalty`, `.ll-cart-loyalty__line`, `.ll-cart-loyalty__redeem` and
   `.ll-cart-loyalty__status` to match the bar.

## What it shows

| Who | Line |
|---|---|
| Signed out | "Sign in to earn N points on this order" (at the entry tier rate) |
| Every member (Joy parity) | "This order earns N points"; a redeem button when the cart can take a reward and no `WAVE-` code is on it yet |
| Treatment members, once nudges are live | "$X more to reach Silver" / "This order reaches Silver"; points still needed for the next reward after this order |

"Nudges are live" means `loyalty_programs.treatment_since` is set (0212). Until then the treatment and
holdout groups see the same thing, which keeps the A/A check honest (plan §6).

## Data

All from metafields the app keeps current, so the line follows the cart total on every drawer render with
no extra request:

- `shop.metafields.ll_loyalty.program` (json): name, points per dollar, code prefix, tiers, points
  rewards, `nudges_live`
- `customer.metafields.ll_loyalty`: `tier`, `points`, `tier_spend_cents`, `group`

The redeem button confirms first (second tap), then reuses an unused code of the same value if the member
has one, otherwise spends points through `/apps/loyalty/redeem`, then adds the code to the cart's codes
with `/cart/update.js`. A `WAVE-` code can't be combined with another order discount; if Shopify refuses
it, the member is told the code is saved on their rewards page.

Checked with LiquidJS against nine cart/customer cases (2026-10-15). Not yet run in Tinker itself.
