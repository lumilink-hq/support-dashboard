# Joy review: what it does, how it performs, what to take

Walked Joy's admin on tsunami.store (read-only) on 2026-10-16, plus the live storefront's scripts.
Purpose: decide what LL Loyalty still needs to beat Joy, not just replace it.

## 1. How Joy performs today (Joy Analytics, last 30 days)

| Metric | Value | Note |
|---|---|---|
| Revenue by Joy ("assisted": a Joy coupon was used) | **$150** (-67% vs prior 30 days) | Of $31,009 total store sales |
| Loyalty revenue share | **0.5%** | |
| Referred revenue | **$0** | All time: 8 friend coupons used, 1 referrer reward paid |
| Redemption rate | **0.93%** (-63%) | |
| AOV lift | **1x**: members $90.12, non-members $92.43 | Members don't spend more per order |
| Retention | 17.35% (38 of 219 came back) | No non-member comparison, so not a lift |
| Active members | 1.2K (+11%) | 4,456 enrolled (Klaviyo export, 2026-10-14) |

**Why it's weak (our read):** the reward ladder is too far away. 3 points per $1 and the only
reward is $5 for 750 points, so a member needs **$250 of spend for the first $5**, about three
orders at a $90 AOV. Average balance is ~124 points (554,343 points / 4,456 members), so almost
nobody is close to a reward, and there is nothing to redeem except that one $5 code. Joy's "assisted"
revenue also only counts orders where a coupon was used, so it can't show real lift either way.

**What this means for LL:** the bar to "perform better than Joy" is low on revenue, but Joy is
ahead on how much of the store the program touches (see section 2). LL's holdout (module 9) is the
first honest measure of lift Tsunami has had; Joy has never measured it.

## 2. What Joy runs on the storefront today

Confirmed on tsunami.store's live page: `Avada-Joy_FloatingButton`, `Avada-Joy-modal`,
`joy-points-calculator`, `joy-redeem-inline`.

| Surface | Joy | LL Loyalty today |
|---|---|---|
| Floating launcher + panel on every page (balance, ways to earn, rewards, referral, orders) | Enabled, but **Tsunami keeps it hidden** (no room on the layout, J 2026-10-16) | ✅ app embed, off by default (`ll-loyalty-10`) |
| Rewards page | ✅ | ✅ (redesigned, stronger) |
| **Points calculator on product pages** ("earn 270 points") | ✅ live | ❌ |
| Redeem in cart | ✅ live (V1 block) | ◐ built (cart snippet), not installed in Tinker |
| Thank-you / order status / account page | Account page block | ✅ built (`wave-rewards-ui`), blocks not placed yet |
| **Referral claim popup** (friend opens a referral link, sees the offer, claims the coupon) | ✅ available | ❌ friend form lives on the rewards page only |
| Social share buttons for referral link (WhatsApp, X, Facebook, Messenger, email) | Available, all **off** | ❌ copy link only |
| Product referral (share a specific product) | Available | ❌ |

## 3. Program features

| Feature | Joy (Tsunami's setup) | LL |
|---|---|---|
| Earn per $ | 3 / $1, tier multipliers | ✅ same |
| Signup, birthday, anniversary, newsletter, Instagram follow | ✅ active | ✅ same |
| Order milestones | ✅ | ✅ |
| Survey, streak bonus, Instagram comment/reply/mention | Inactive / draft | Streak ✅ (module 13) |
| Catalog of more earn actions: reviews, SMS sign-up, receipt upload, forms, Google reviews, visit site, TikTok/YouTube/X/Pinterest/Facebook/Discord follow | Available, unused | ❌ (only reviews / SMS worth having) |
| Redeem: fixed $ off | ✅ $5 / 750 | ✅ same |
| Redeem: % off, **free product**, free shipping, buy X get Y, gift card | Available; free product ("Test Kit", 1,500) and free shipping (750) set up but **inactive** | ❌ only $ off (free shipping is a Gold perk, not a redemption) |
| Members-only time-limited deals | Available | ❌ (Gold perk planned, no products chosen) |
| Paid membership (subscription tier) | Available, not set up | ❌ |
| Pending points (points unlock after N days, protects against refunds) | Available | ❌ (we claw back on refund instead) |
| Gift a reward to a friend | Available, email off | ❌ |
| Bonus campaigns, badges, challenges, holdout ROI, near-tier nudges | ❌ | ✅ (Phase 1b) |
| Shopify Flow triggers/actions | ✅ | ❌ (Klaviyo events instead) |

## 4. Admin and operations

| | Joy | LL |
|---|---|---|
| Who runs it | Merchant self-serve, embedded in Shopify admin | LumiLink staff in the LumiLink portal; config by SQL |
| Home | Activity feed (assisted orders with coupon + links), setup checklist, KPIs | Members search |
| Analytics | Revenue, revenue share, return on reward, referred revenue, members, retention, redemption, AOV lift; AI Q&A; ShopifyQL | `/loyalty/insights`: treatment vs holdout, ROI, tiers, liability (not seen live yet) |
| Change rules | Toggle / edit any program in the UI, AI "describe the program" | SQL, except campaigns + challenges (console) |
| Emails | Built-in templates, **all off** at Tsunami (Klaviyo does it) | Klaviyo events + properties |

## 5. What to take (proposed, in order)

1. **Fix the reward ladder before go-live** (config, not code). A cheaper first reward (e.g. $3 at
   300 points, so it lands on the first or second order) and a product reward (the free "Test Kit"
   Joy has set up but switched off). Needs: Tsunami's margin call. This is the change most likely to
   move redemption off 0.93%.
2. ☑ *Released in `ll-loyalty-10`, off by default.* **Floating launcher on every page** (theme app embed): balance, next reward with progress,
   ways to earn, referral link, redeem. Not a parity gap after all: Tsunami hides Joy's widget
   because there is no room for it. Kept for Phase 2 stores; for Tsunami, a header icon or account
   menu link that opens the same panel would fit the layout better.
3. ☑ *Released in `ll-loyalty-10`, not placed yet.* **Points on product pages**: a small app block, "Earn 270 points (324 as Gold)". Cheap, and
   it's what Joy shows shoppers today, so removing it at cutover is a visible step back.
4. **Install the cart snippet and place the checkout / account blocks** (already built). Joy's
   redeem-in-cart is live; ours must be in before Joy is turned off.
5. **Referral landing popup + share buttons**: when a friend opens a referral link, show the $10
   offer and the email field right there. Referred revenue is $0 today; this is the cheapest fix.
6. **More redemption types**: free product and free shipping redemptions (Shopify discounts we
   already know how to create), then % off. More ways to spend points means more redemptions.
7. **Merchant-facing admin later**: activity feed and self-serve rule editing belong with
   Phase 2's merchant access (see PLAN §7), not before.

**Not worth copying:** the long list of social follow/share earn actions (honor-system clicks that
buy no revenue), sustainability donations, B2B partner tiers, Joy's own email templates (Klaviyo
owns email), AI chat in the admin.

**Open for Tsunami / J:** reward ladder and margin (item 1); whether a paid membership tier is
wanted; whether to switch on pending points instead of relying on refund claw-back.
