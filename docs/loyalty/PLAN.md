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
| Where the code lives | This repo. Shopify app in `ll-loyalty/` (extension-only CLI app), backend in `supabase/`, pages in `app/` | LumiLink runs it and would sell it; Tsunami is tenant #1. Git syncs both machines. |
| Shopify app type | CLI-created app (Dev Dashboard), custom distribution to Tsunami for now | Theme app blocks, Shopify Functions and app proxy need a CLI app; admin-created custom apps can't do them |
| App owner account | LumiLink's Shopify Partner account (created 2026-10-12) | Phase 2 is a LumiLink product |
| Backend | Supabase edge functions + Postgres; pg_cron for scheduled jobs | Same pattern as voice/SEO (`0023_scheduled_product_sync.sql`). No new Railway service. |
| Distribution | **Custom distribution** for this app (Tsunami only, no review). Shopify doesn't let an app change distribution later, so Phase 2 uses a **second, public app** with its own `shopify.app.public.toml` and the same extensions | Unblocks protected data now without App Store review |
| Shopify data fields | Tier, points and birthday go in a **merchant-owned metafield namespace (`ll_loyalty`)**, never the app-reserved `$app` namespace | `$app` fields belong to the app that wrote them, so the Phase 2 public app couldn't read the custom app's. A shared namespace makes the switch a token swap |
| Tier perks | **Automatic Shopify discounts limited to customer segments**, one segment per tier matching a customer tag (`LL Tier Gold`). No Shopify Function | 2026-10 automatic discounts take `context.customerSegments`. Segments filter on tags reliably; filtering on our metafield wasn't confirmed in the docs. Saves building and deploying a Function extension |
| Reward codes | Points are debited first, then a single-use code (`WAVE-` + 8 chars, that customer only) is created in Shopify by `loyalty-shopify`. 5 failures = points returned | A double click or retry can't spend twice, and a Shopify outage never loses points |
| Custom → public switch (Phase 2) | `shopify app config link` creates the public app and `shopify.app.public.toml`; same extensions, deploy with `--config public`. Backend keys tokens by shop + app. Tsunami installs the public app, token swapped, theme block re-added, custom app uninstalled. Est. 2-4 hrs | Shopify doesn't allow changing distribution on an existing app |
| Shopify token | Issued by OAuth on install, stored in Supabase Vault | Same storage pattern as `seo-publish`. Do **not** reuse the SEO custom-app token. |
| Settings-driven | All rules, tiers, rewards and copy read from config tables, nothing Tsunami-specific in code | Games and Phase 2 reuse it |
| Admin UI | Staff-only. Never client-facing in the LumiLink portal | Phase 2 merchants get an embedded admin inside Shopify instead |
| Pricing | Out of scope for now | Boss asked to focus on cost |
| Migration numbers | Loyalty migrations use the **0200 block** (`0200_`, `0201_`, …) on this branch. The `loyalty` branch never runs `supabase db push`. Before merging to main, renumber them to follow main's latest migration (only comments reference the numbers) | SEO work continues on main with 0090+ in parallel. Duplicate versions break the CLI, and `db push` rejects a migration numbered below one already in production |

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
| 1 | Points ledger, tiers, rules engine (config tables, append-only ledger, RLS) | 12-16 | ☑ 2026-10-13 (`0200_loyalty_core.sql`, `test_loyalty_core.sql`, `setup-loyalty-program.sql`). Not pushed to production |
| 2 | Shopify order, refund, customer sync + historical backfill | 8-10 | ◐ code + tests done 2026-10-13 (`0201_loyalty_shopify_sync.sql`, edge fns `loyalty-webhooks` / `loyalty-oauth` / `loyalty-backfill`, `provision-loyalty-shopify-app.sql`). Not deployed; not yet tested against a real store |
| 3 | Earning rules, milestones, referrals, expiry, demotion (pg_cron jobs) | 12-16 | ☑ 2026-10-13 (`0202_loyalty_earning_jobs.sql`, `test_loyalty_earning_jobs.sql`; webhook parsing extended). Referral discount codes and the Instagram-follow claim endpoint come with modules 4 and 5 (SQL side ready: `loyalty_referrals.discount_code`, `loyalty_award_action`) |
| 4 | Rewards and perks as Shopify discounts ($5, $10 referral, Gold free shipping, members-only prices) | 8-10 | ◐ code + tests done 2026-10-13 (`0203_loyalty_rewards_shopify.sql`, edge fn `loyalty-shopify`, shared `_loyalty/shopify.ts`). All GraphQL + inputs validated against 2026-10. Members-only prices waits on §9 (which products, what %). Not tested against a real store |
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
| Decide which account owns the app: LumiLink Partner account | J | ☑ 2026-10-12 |
| Free development store for testing | J | ☑ 2026-10-12 |
| `shopify app init` → `ll-loyalty/`; sample FAQ extensions and nested `.git` removed; scopes set | J + Claude | ☑ 2026-10-12 |
| Protected customer data: Name + Email selected, data protection answers saved (see 8b). First save returned "not approved": select a distribution method first | J | ◐ |
| Set distribution to **Custom** (Tsunami's store) in the Dev Dashboard | J | ☑ 2026-10-12 |
| Confirm protected customer data (name, email) shows as available after custom distribution | J | ☐ |
| Deploy `loyalty-webhooks`, `loyalty-oauth`, `loyalty-backfill`, `loyalty-shopify` (`--no-verify-jwt`) **before** `shopify app deploy` (the toml now subscribes webhooks to them). Runbook: `scripts/provision-loyalty-shopify-app.sql` | J + Claude | ☐ |
| `shopify app deploy` the config, then install on the dev store | J + Claude | ☐ |
| Decide: the toml points webhooks at **production** Supabase, so a dev-store install writes to production (conflicts with L2-2). Options: a second dev app config (`shopify.app.dev.toml`) pointing at a tunnel to local functions, or accept prod with a throwaway program row | J | ☐ |
| Joy member export (members, balances, tiers); check Joy Settings → Developers for an API key for points history | J | ☐ |
| Keep the Joy export **out of git** (customer PII) | J | ☐ |
| Klaviyo key with events:write and profiles:write | J | ☐ |
| Docker Desktop running for `npx supabase start` | J | ☑ 2026-10-13 |
| Shopify CLI 4.9.3 installed globally on the Tsunami machine (`npm i -g @shopify/cli --allow-scripts=esbuild`) | J | ☑ 2026-10-12 |
| `node_modules` links point at the repo's old path: `pnpm install --frozen-lockfile --force` (plain install is a no-op), then `npx next typegen` | J | ☑ LumiLink machine 2026-10-13; ☐ Tsunami machine |

## 8b. Data protection (Shopify protected customer data)

LL Loyalty uses name and email, so Shopify's **Level 1 and Level 2** requirements apply
(https://shopify.dev/docs/apps/launch/protected-customer-data). Custom-distribution apps and apps on
dev stores need no review; the App Store version (Phase 2) does. Answers were saved in the Dev
Dashboard on 2026-10-12. Flip each "No" there to "Yes" when its item lands.

| # | Requirement | Answer saved | What makes it true | Status |
|---|---|---|---|---|
| L1-1 | Minimum data | Yes | Name + email only; no phone or address | ☑ |
| L1-2 | Tell merchants what and why | Yes | Tsunami knows; Phase 2 needs a privacy policy page | ☑ (☐ for Phase 2) |
| L1-3 | Limit use to stated purpose | Yes | Loyalty only | ☑ |
| L1-4 | Respect consent | Yes | Never subscribe anyone; Klaviyo applies consent; newsletter points only on real opt-in | ☑ |
| L1-5 | Respect opt-out of data sharing | N/A | We don't sell data | ☑ |
| L1-6 | Automated decisions | N/A | Points and tiers aren't legally significant | ☑ |
| L1-7 | Privacy agreement with merchants | **No** | Write a short data processing agreement, LumiLink ↔ Tsunami; reuse as the Phase 2 terms | ☐ |
| L1-8 | Retention periods | **No** | Written retention rule + handle `customers/redact`, `customers/data_request`, `shop/redact` webhooks; delete member PII on redact and after uninstall | ☐ |
| L1-9 | Encrypt at rest and in transit | Yes | Supabase encryption + HTTPS | ☑ |
| L2-1 | Encrypt backups | Yes | Supabase backups are encrypted | ☑ |
| L2-2 | Separate test and production | Yes | Dev store + local Supabase vs Tsunami + production project | ☑ |
| L2-3 | Data loss prevention strategy | Yes (thin) | Write `docs/loyalty/DATA-PROTECTION.md`: Supabase daily backups, restore steps, who has access | ☐ |
| L2-4 | Limit staff access | Yes | Staff-only admin route, RLS, only J has DB access | ☑ |
| L2-5 | Strong staff passwords | **No** | Production Supabase Auth: minimum 12 characters + character requirements (local `config.toml` is 6, no rules). Consider MFA for staff | ☐ |
| L2-6 | Access log for protected data | **No** | `loyalty_access_log` table; staff admin writes a row on every member lookup and export (module 7) | ☐ |
| L2-7 | Security incident response policy | **No** | One page in `DATA-PROTECTION.md`: detect, contain, notify Tsunami (and Shopify for Phase 2), fix, review | ☐ |

**Do before real Tsunami data flows (before installing on tsunami.store):** L1-7, L1-8, L2-3, L2-5, L2-6, L2-7.
Then update the Dev Dashboard answers.

## 9. Open questions

- Tier achieved and milestone event names in Klaviyo (section 4).
- Do Joy's tier counts (4,593) include guest customers? Decides who we import.
- Gold "members-only discounts (select products)": which products, what discount?
- Does Tsunami still need the "Redeem in cart" block, or is the rewards page enough?
- Instagram follow (100 pts): honor-system click, same as Joy?
- Enrollment rule (module 2): a customer joins when their Shopify customer `state` is `enabled` (has an account), or anyone if `enroll_guests` is on. Check on the dev store that Shopify's **new customer accounts** (code login) set `state` to `enabled`; if not, the rule needs another signal.
- Tsunami's store time zone (birthdays and anniversaries pay on the local date). `setup-loyalty-program.sql` assumes America/Los_Angeles.
- Birthday abuse: a member who edits their birthday to today gets 225 points. Joy may limit edits; module 5 should allow setting it once (or lock it for N days).
- A member demoted for inactivity goes straight back to their spend tier on their next order (tier spend isn't reset by demotion). Confirm that's Joy's behaviour.
- Joy order tag `Joy assisted` on loyalty-assisted orders: do we still need it? Tagging orders needs the `write_orders` scope, which the app doesn't request.
- Reward code expiry and stacking: Joy's `WAVE-` $5 codes, do they expire, and do they combine with other discounts? Defaults: no expiry, combines with shipping discounts only (`loyalty_rewards.expires_after` / `combines`).
- Order points are on the subtotal after discounts, before shipping and tax. Confirm that matches Joy (spot-check a few orders in the parallel run).

## 10. Risks

- **Points balances:** a bad import erases customer rewards. Reconcile per member before cutover.
- **Klaviyo names drift:** flows silently stop. Section 4 is the contract.
- **Double-awarding:** Shopify retries webhooks. Ledger writes must be idempotent on (order id, rule).
- **Refunds:** points must claw back on refund, including tier spend.
- **Joy import (module 8) must set dates, not just balances:** `enrolled_at` (anniversaries), `last_activity_at` (expiry) and `last_order_at` (demotion) come from Joy/Shopify history. Leave them at import time and every expiry and demotion clock restarts at cutover. Import before the hourly `loyalty-jobs` cron can act on the program.

## 11. Session log

| Date | Machine | What happened |
|---|---|---|
| 2026-10-09 | Tsunami | Scoped the build, walked Joy's admin, wrote the scope brief (Drafts 1-4) |
| 2026-10-12 | Tsunami | Phase 1 approved. Created `loyalty` branch and this plan. LumiLink Partner account and dev store created. Scaffolded `ll-loyalty/`, set scopes, excluded it from root tsconfig |
| 2026-10-13 | LumiLink | Module 1 written: migration 0200 (first numbered 0090; renumbered so SEO work on main can keep 0090+) (programs, tiers, earn rules, rewards, members, append-only ledger + tier history, service-role only), Joy config setup script, SQL test. Local db had only 0001-0004 applied; `supabase migration up --local` brought it up to date. `test_loyalty_core.sql` passes. Full suite 39/41: `test_seo_competitor_gaps` and `test_seo_keyword_research` fail on pull-forward (unrelated to loyalty) |
| 2026-10-13 | LumiLink | Loyalty migrations moved to the 0200 block (SEO on main keeps 0090+). Module 2 written: migration 0201 (app/token registry, webhook receipts, per-order refund tracking, enrollment rule, privacy redact, backfill state + pg_cron), three edge functions, `shopify.app.toml` webhooks/App URL/redirect (validated with `shopify app config validate`), backfill GraphQL validated against 2026-10. SQL + unit tests pass. Fixed `node_modules` links on this machine |
| 2026-10-13 | LumiLink | Module 3: migration 0202 (live-only signup/newsletter/milestones so nothing Joy already paid is paid again, referrals with Joy's checks, events outbox for Klaviyo, hourly `run_loyalty_jobs`: expiry, one-tier demotion + 7-day warning, birthdays + pre-birthday, anniversaries, in the program's time zone). All loyalty SQL + unit tests pass |
| 2026-10-13 | LumiLink | Module 4: migration 0203 (reward codes debit-first with refund on failure, referral coupon trigger, codes marked used, tier perks as segment-limited automatic discounts, member tier tag + metafield sync, dispatcher that only fires with work) and edge fn `loyalty-shopify`. GraphQL documents and builder inputs validated against 2026-10; all four loyalty functions pass `deno check` (`DENO_NO_PACKAGE_JSON=1 npx deno@2.5.6 check …`). Gold free shipping moved from rewards to `loyalty_perks` in the setup script |
