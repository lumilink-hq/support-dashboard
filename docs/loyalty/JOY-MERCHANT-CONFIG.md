# Joy: what a merchant can create and edit (reference for Phase 2)

Read-only walk of Joy's editors on tsunami.store, 2026-10-16. Nothing was saved. Use this as the
checklist for LL's merchant admin (PLAN §7). Companion to [JOY-REVIEW.md](JOY-REVIEW.md), which
covers performance and the storefront.

Legend: **LL now** = what LL Loyalty has today (✅ editable in the app, SQL = config table only,
❌ not built).

## 0. Findings that matter before cutover (not Phase 2)

| Joy behaviour | LL today | Action |
|---|---|---|
| Order points **round to the nearest** point ("Rounding method") | `floor()` in `loyalty_order_points` | Match Joy (round) or expect ≤1 point differences per order in the parallel run |
| "Points for discounts" is a **dynamic amount**: 750 points = $5, a member can spend any multiple (1,500 = $10) | One fixed $5 reward | Add a dynamic reward (or $10/$15 steps) before cutover, or members with 1,500+ lose an option they have today |
| Demotion **moves tier progress down** to the previous tier's threshold | Tier spend kept; member regains the tier on the next order | Answers PLAN §9 open question: match Joy (reset spend to previous threshold) |
| Spent points are **not refunded** when a reward order is cancelled ("Refund points": Off) | We refund only a failed code issue | Same outcome; nothing to do |
| Every member gets the Shopify tag **`joy_tag_member`** ("Sync joy_tag_member tag": On) | We tag tier only | Check Klaviyo segments / Flow for `joy_tag_member` before cutover |
| Tier counts: Bronze 4,838 · Silver 22 · Gold 3 (spend $0 / $500 / $1,200) | Same thresholds | Tiers are effectively unused; part of the reward-ladder conversation |
| Points expire after **1 year of inactivity** | Same (expiry job) | — |
| Rewards granted when the order is **Paid** (not Fulfilled) | Paid | — |

## 1. Program-level settings

| Setting | Joy options | LL now |
|---|---|---|
| Program on/off | Live mode toggle | SQL (`treatment_since`, program row) |
| Enrollment | Auto-enroll on account creation / customer opt-in ("Join program") / manual; exclude B2B customers | SQL (`enroll_guests`) |
| Store time zone | Picker | SQL |
| Date and time format | 4 date formats, 12/24 h | ❌ fixed |
| Point label | Custom singular/plural ("points", "waves"…), before/after the number, per language | ❌ fixed in locale |
| Default discount code prefix | Text (`WAVE-`) | SQL |
| After applying a discount | Stay on page / go to cart / open cart drawer | ❌ |
| After redeeming in the widget | Add coupon to cart automatically / customer applies later | ❌ (copy code) |
| After redeeming a free gift | Manual add / auto add / auto add + open drawer | ❌ (no free gifts) |
| Free shipping redirect | URL to continue shopping | ❌ |
| Points exchange rate | Points ↔ money, shown across the app | ❌ |
| Review approval | Product reviews / Google reviews: pending or auto-approved | ❌ (no review earning) |
| Order status for rewards | Paid / Fulfilled | SQL |
| Order + customer tags | On/off, tag name ("Joy assisted"), back-fill old orders | SQL (`assisted_order_tag`, `referral_order_tag`) |
| Pending points | Hold order points N days before spendable | ❌ |
| Limit customer earning | Max points per customer per period | ❌ |
| Self-revoke coupon | Customer can cancel an unused code and get points back | ❌ |
| Magic tags | Shopify tags that add/remove points | ❌ |
| Pre-login URLs | Custom sign-in / sign-up URLs | ✅ block uses `routes.*` only |
| Show free product coupon in cart | On/off, how many | ❌ |
| Points in order confirmation email | Liquid snippet for Shopify's notification | ❌ (we have thank-you page block) |
| Metafields in Shopify admin; sync Shopify metafields into Joy | Toggles | ✅ we always write `ll_loyalty` metafields |
| Auto-tag customers | Redeemer / member / engaged-member tags | ❌ (tier tag only) |
| Sign-in options in widget | Shop app, Multipass, Google, Facebook (Plus + legacy accounts) | ❌ (not relevant on Grow) |
| Brand, translations, email logo + social links, developer API keys | Pages exist | ❌ |
| AI assistants | "Describe the program you want" in every editor; Joy AI Q&A | ❌ (not planned) |

## 2. Earning programs (each one is a create/edit form)

Common fields on every earning program:
- Name, short description (with variables like `{{earning_point_raw}}`), detail description
- Start and end date
- Who: all loyalty members / specific VIP tiers / all customers
- Reward type: points or **store credit**
- Status: active / inactive / draft; delete

**Place an order** (the biggest form):
- Method: X points per $Y spent / X points per order / per Y items (rule engine) / once when spend reaches Y (rule engine)
- **Per-tier rates** (Bronze 3 per $1, Silver 33 per $10, Gold 36 per $10) instead of a multiplier
- Keep the rate unsimplified; points on tax; exclude tax types; rounding method
- Purchase location: all channels (exclude POS) / online only / online + draft orders / POS only
- Product eligibility (all / specific products / collections), exclusions

LL now: `points_per_dollar` + tier `earn_multiplier` (SQL). No per-channel, per-product or tax options
(we earn on subtotal after discounts). Bonus campaigns (module 12) cover product/collection boosts.

Earning catalog Joy offers: sign up, birthday, anniversary, newsletter, Instagram follow, place a
subscription, survey/form, streak bonus, write a review, SMS sign-up, submit receipt, Google review,
visit a page, custom program; social: Instagram comment/reply/mention/live, Facebook follow/share,
TikTok, YouTube, X follow/share, Pinterest, Discord. LL now: the first six + streak (module 13), SQL only.

## 3. Redeeming programs

Types: **discount amount** (fixed or dynamic), **discount %**, **buy X get Y**, **gift card**,
**free product**, **free shipping**, GoodAPI donation.

Fields on the discount form:
- Name, dates, description
- Redeem value: dynamic (N points per $X, customer picks how much) or fixed
- Limits: min points to redeem, max points per redemption, max discount as % of cart
- Who: all members / specific tiers
- Applies to: all products / collections / products; one-time vs subscription purchases
- Minimum order: none / amount / quantity
- Coupon validity: never / after N days / until a date
- Combines with: order / product / shipping discounts
- Purchase location: online / POS / both
- Who can use the code: everyone / only the redeemer / customer segments
- Per-customer limit, total store limit, uses per code, one use per customer
- Advanced customer conditions
- Refund points if the order is cancelled
- Code prefix (default or custom)
- Redeem at checkout (Plus only)

LL now: `loyalty_rewards` (`amount_off_order`, `free_shipping` kinds) with points cost, value,
minimum order; SQL only. Codes are single-use and redeemer-only.

## 4. Referrals

Name; multi-region (currency) rewards; referrer reward (points) and friend reward ($10 coupon), each
with the redeem-form options above; sharing: manual link or automated referral emails; who can be
referred (once per customer / guests only / never-ordered customers); restrict the program to
customer tags; landing URL for referral links; social share buttons (X, WhatsApp, Threads, Facebook,
email, Messenger, Line); order tag "Joy Referral"; note attributes; customer tagging.

LL now: referral rule + friend reward in SQL, one per email, daily cap, landing on the rewards page.

## 5. Milestones and point expiry

- Milestones: name, type (number of orders, and others), start/end dates, status; progression mode:
  give only the highest reached or all of them when several are reached at once.
- Point expiry: on/off; by inactivity (period), on a fixed calendar date, or per earning date (Ultimate plan).

LL now: order-count milestones and inactivity expiry, SQL only.

## 6. VIP tiers

Program level: level-up rule (amount spent / points / orders), start date, sync past orders once,
code prefix, auto-tag customers by tier with a tag prefix, let staff edit tier points, re-give entry
reward after a downgrade.

Per tier: name, **exclusive tier (manual or Shopify Flow only)**, threshold, entry reward, perks list.
Perk types: discount amount, discount %, free shipping, free product, bonus points, store credit,
custom reward (text), **exclusive products/collections**.

Tier control: scheduled tier reset (clears everyone's progress on a schedule); inactivity demotion
(down one tier or to the lowest; after N months without an order; warning email N days before).
Notifications tab for tier emails. Member counts per tier on the overview.

LL now: tiers by spend with multiplier and perks (`free_shipping`, `percent_off_products`), demotion
and warning; SQL only. No manual-only tier, entry reward, scheduled reset or exclusive products.

## 7. Membership extras

Member-exclusive time-limited deals; paid subscription membership (monthly fee unlocks a tier);
B2B partner tier. LL now: ❌.

## 8. On-site content editors

Loyalty widget (all-in-one), referral claim popup, loyalty page, account page block, product page
(points calculator, product referral), cart drawer (redeem in cart V1/V2), checkout. LL now: rewards
page block with settings, launcher embed, product points block, cart snippet, checkout/account UI
extension; copy via the locale file.

## 9. Members (customer admin)

List with All / Members / Guests / Left filters, search, sort, columns; per member: points, tier,
tier spend, birthday, last updated. Add customer, import, activity log, notifications log, loyalty
pass (wallet card). LL now: staff search, member page, adjust points, change tier, set birthday,
access log (`/loyalty`, staff only).

## 10. Notifications

Built-in emails per area (reward program: sign-up, points earned, redeemed, birthday, milestone,
pending points, gift to a friend; referral; VIP tier; points expiry; coupon reminder), each on/off
with an editor, plus Shopify Flow triggers. All off at Tsunami (Klaviyo sends). LL now: Klaviyo
events and profile properties only, by design.

## Suggested Phase 2 order for LL's merchant admin

1. Rewards (create/edit amount, %, free product, free shipping; dynamic amount; limits; tier gating)
2. Earning rules (toggle, points, dates, tier gating) and order rate with per-tier rates
3. Tiers (thresholds, perks incl. exclusive collections, demotion settings)
4. Referral settings (rewards, eligibility, landing URL, share buttons)
5. Program settings (enrollment, labels, prefixes, order status, tags, expiry)
6. Members list with filters and bulk import/export
