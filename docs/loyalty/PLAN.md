# LL Loyalty — Build Plan

**Source of truth for the loyalty build.** Read this first in any session, on either machine.
Update the module checklist and the session log as work lands. Committed on the `loyalty` branch.

- **Goal:** replace Joy Loyalty ($129/mo, Advanced plan) on tsunami.store with LL Loyalty, built on
  LumiLink's existing infrastructure. Add games next. Publish on the Shopify App Store later.
- **Approved:** 2026-10-12, Phase 1. Scope brief: `LumiLink-Loyalty-Scope-Brief.docx` (Draft 4,
  2026-10-09), one level above this repo.
- **Cost rule:** no more than $30/mo added running cost. Target is $0 new bills; the cost is build hours.

---

## 1. Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the code lives | This repo. Shopify app in `shopify-app/`, backend in `supabase/`, pages in `app/` | LumiLink runs it and would sell it; Tsunami is tenant #1. Git syncs both machines. |
| Shopify app type | CLI-created app (Dev Dashboard), custom distribution to Tsunami for now | Theme app blocks, Shopify Functions and app proxy need a CLI app; admin-created custom apps can't do them |
| App owner account | **TBD:** LumiLink Partner/Dev Dashboard account recommended | Phase 2 is a LumiLink product |
| Backend | Supabase edge functions + Postgres; pg_cron for scheduled jobs | Same pattern as voice/SEO (`0023_scheduled_product_sync.sql`). No new Railway service. |
| Shopify token | Issued by OAuth on install, stored in Supabase Vault | Same storage pattern as `seo-publish`. Do **not** reuse the SEO custom-app token. |
| Settings-driven | All rules, tiers, rewards and copy read from config tables, nothing Tsunami-specific in code | Games and Phase 2 reuse it |
| Admin UI | Staff-only. Never client-facing in the LumiLink portal | Phase 2 merchants get an embedded admin inside Shopify instead |
| Pricing | Out of scope for now | Boss asked to focus on cost |

## 2. Architecture

```
Shopify (Tsunami)                         LumiLink
─────────────────                         ────────
orders/paid, refunds/create,   ──HMAC──▶  edge fn loyalty-webhooks ──▶ ledger tables (Postgres)
customers/create webhooks                                              │
                                                                       ├──▶ edge fn loyalty-klaviyo (events + profile props)
Wave Rewards theme block  ──app proxy──▶  balance / redeem / referral   │
                                          (Next.js route or edge fn)   └──▶ Shopify Admin API: discount codes
Shopify Functions (Gold free shipping,                                  
members-only prices) read customer tier metafield                       pg_cron ──▶ edge fn loyalty-jobs
                                                                          (expiry, demotion, warnings, birthdays)
Staff admin page ◀── app/(dashboard)/loyalty (staff-only route)
```

- Webhooks authenticate with Shopify's HMAC, not `x-voice-tool-secret`. Still deploy with
  `--no-verify-jwt` (see CLAUDE.md).
- Tier lives on a customer metafield too, so Shopify Functions and the theme can read it without calling us.

## 3. What Joy does today (rules to match)

Read from Joy's admin on 2026-10-09. Live settings win over `TSU Loyalty Program Configuration.xlsx`.

| Area | Live setting |
|---|---|
| Enrollment | Auto-enroll on Shopify account creation. 3,574 members (tier counts total 4,593; check whether guests are counted) |
| Earn: orders | 3 pts per $1, granted when order is **Paid**. Tier multiplier: Bronze 1.0, Silver 1.1, Gold 1.2 |
| Earn: actions | Sign up 100, Instagram follow 100, newsletter 75, birthday 225, member anniversary 225 |
| Milestones | 1st order 100; 10th, 20th, 30th order 300 each. All milestones awarded if several hit at once |
| Referrals | Referrer 300 pts, friend $10 coupon. Friend can be referred once. Checks kept: similar email, paid orders only (browser and IP checks dropped for lean scope). Orders tagged `Joy Referral` |
| Redeem | 750 pts = $5 off (only active reward). Discount prefix `WAVE-` |
| Tiers | By amount spent since 2026-06-05: Bronze $0, Silver $500, Gold $1,200. No entry rewards configured |
| Tier perks | Silver: early access (text perk), 1.1x. Gold: members-only discounts on select products, 1.2x, free shipping on orders $75+ |
| Demotion | Down one tier after 6 months with no order; warning 7 days before. Scheduled tier reset is OFF |
| Expiry | Points expire after 1 year of inactivity |
| Order tags | `Joy assisted` on loyalty-assisted orders |
| Joy emails | All OFF. Klaviyo sends everything |
| Storefront | Floating widget OFF. `/pages/wave-rewards` (Joy loyalty page V1) + "Redeem in cart" V1 block |
| Not used | AI features, paid membership, B2B tier, surveys, Instagram comment/mention rewards, free gift and free shipping rewards, checkout blocks, Shopify Flow automations, POS |

**Known page bugs to fix in our version:** Wave Rewards page shows Silver "Spend 200 points" and
Gold "Spend 500 points" (real: $500 / $1,200 spent); anniversary line carries Instagram Story copy.

## 4. Klaviyo compatibility contract

Tsunami's flows and segments read Joy's names. Emit the **exact same** names or re-point the flows.

| Kind | Name | Used by |
|---|---|---|
| Profile property | `Joy Vip tier` (Bronze/Silver/Gold) | Tier segments Bronze VSKL8f, Silver QWq9sQ, Gold VmMXUE; Tier At Risk segment TenXzZ |
| Profile property | `Joy member status`, `Joy Loyalty Points`, `Joy Referral URL` | Email copy |
| Profile property | `Birthday`, `dateOfBirth` (MM/DD/YYYY strings) | Birthday Capture flow |
| Event | `Joy: Points Eligible Reward` | Reward Ready flow |
| Event | `Joy: Tier Downgrade` | Tier Downgrade flow |
| Event | `Joy: 7 Days Pre Birthday`, `Joy: Birthday` | Birthday flow (`Joy: Birthday` had 0 events as of 2026-10-06) |
| Event | Tier achieved event: **name TBD**, pull from Klaviyo metrics | Tier Achieved flow |
| Event | Milestone event: **name TBD** | 10th/20th/30th order milestone flows |

Before cutover: list every `Joy:` metric in Klaviyo and confirm each one has an emitter here.

## 5. Phase 1: replace Joy (66-90 hrs)

| # | Module | Hrs | Status |
|---|---|---|---|
| 1 | Points ledger, tiers, rules engine (config tables, append-only ledger, RLS) | 12-16 | ☐ |
| 2 | Shopify order, refund, customer sync + historical backfill | 8-10 | ☐ |
| 3 | Earning rules, milestones, referrals, expiry, demotion (pg_cron jobs) | 12-16 | ☐ |
| 4 | Rewards and perks as Shopify discounts ($5, $10 referral, Gold free shipping, members-only prices) | 8-10 | ☐ |
| 5 | Wave Rewards page as a theme app block, reusing the current layout | 6-10 | ☐ |
| 6 | Klaviyo events + profile properties (section 4) | 4-6 | ☐ |
| 7 | Staff admin: member lookup, point adjustments | 4-6 | ☐ |
| 8 | Joy data migration, 30-day parallel run, QA | 12-16 | ☐ |

**Cutover rule:** keep Joy on until the parallel run shows our balances and tiers match Joy's for
every member. Then switch Klaviyo flows, swap the page block, cancel Joy.

## 6. Phase 1b: games (32-47 hrs) — after Phase 1

Prize engine with odds, points spend and audit log (8-12); spin wheel and mystery box (8-12);
challenges and streaks (10-14); badges and progress bars (4-6); Klaviyo game events (2-3).
Design reference: Bud Club's rewards app (`dashboard.budclubshop.com/rewards-app/`, WordPress, logic only).
**Legal review of spin wheel / mystery box before launch** (chance + points spent can count as a lottery).
Double or nothing is out.

## 7. Phase 2: Shopify App Store (50-74 hrs) — later, not scheduled

Install + multi-store accounts + privacy webhooks; Shopify Billing; embedded merchant admin;
theme block packaging; listing and review prep. $19 one-time App Store registration. Shopify review
1-4 weeks. Revenue share 0% on first $1M lifetime, 15% after.

## 8. Setup checklist

| Item | Owner | Status |
|---|---|---|
| Decide which account owns the app (LumiLink recommended) | J | ☐ |
| Free development store for testing | J | ☐ |
| `shopify app init` into `shopify-app/` (browser login) | J + Claude | ☐ |
| Joy member export (members, balances, tiers); check Joy Settings → Developers for an API key for points history | J | ☐ |
| Keep the Joy export **out of git** (customer PII) | J | ☐ |
| Klaviyo key with events:write and profiles:write | J | ☐ |
| Docker Desktop running for `npx supabase start` | J | ☐ |
| Shopify CLI updated (4.8.0 installed on the Tsunami machine) | J | ☐ |

## 9. Open questions

- Tier achieved and milestone event names in Klaviyo (section 4).
- Do Joy's tier counts (4,593) include guest customers? Decides who we import.
- Gold "members-only discounts (select products)": which products, what discount?
- Does Tsunami still need the "Redeem in cart" block, or is the rewards page enough?
- Instagram follow (100 pts): honor-system click, same as Joy?

## 10. Risks

- **Points balances:** a bad import erases customer rewards. Reconcile per member before cutover.
- **Klaviyo names drift:** flows silently stop. Section 4 is the contract.
- **Double-awarding:** Shopify retries webhooks. Ledger writes must be idempotent on (order id, rule).
- **Refunds:** points must claw back on refund, including tier spend.

## 11. Session log

| Date | Machine | What happened |
|---|---|---|
| 2026-10-09 | Tsunami | Scoped the build, walked Joy's admin, wrote the scope brief (Drafts 1-4) |
| 2026-10-12 | Tsunami | Phase 1 approved. Created `loyalty` branch and this plan |
