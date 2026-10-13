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
| Storefront | Wave Rewards is a theme app block filled from the app proxy (`/apps/loyalty` → `loyalty-proxy`). Copy lives in the extension's locale file. Birthday can be set once by the shopper (staff change it after) | Program rules come from config, so the page can't drift from the rules (Joy's page showed "Spend 200 points" for Silver). Set-once birthday closes the 225-point edit loophole |
| Block JS size | Shopify caps app block JS at 10 KB. `npm run build:blocks` (in `ll-loyalty/`) minifies `src/*.js`; the referred-friend form is a lazy-loaded second file. Main file is 9.9 KB: **new storefront features go in a lazy chunk** | Theme check fails the deploy over 10 KB |
| Tier perks | **Automatic Shopify discounts limited to customer segments**, one segment per tier matching a customer tag (`LL Tier Gold`). No Shopify Function | 2026-10 automatic discounts take `context.customerSegments`. Segments filter on tags reliably; filtering on our metafield wasn't confirmed in the docs. Saves building and deploying a Function extension |
| Reward codes | No expiry; each code works once (`usageLimit 1`, once per customer; points codes locked to the member), decided 2026-10-13. Points are debited first, then a single-use code (`WAVE-` + 8 chars, that customer only) is created in Shopify by `loyalty-shopify`. 5 failures = points returned | A double click or retry can't spend twice, and a Shopify outage never loses points |
| Custom → public switch (Phase 2) | `shopify app config link` creates the public app and `shopify.app.public.toml`; same extensions, deploy with `--config public`. Backend keys tokens by shop + app. Tsunami installs the public app, token swapped, theme block re-added, custom app uninstalled. Est. 2-4 hrs | Shopify doesn't allow changing distribution on an existing app |
| Shopify token | Issued by OAuth on install, stored in Supabase Vault | Same storage pattern as `seo-publish`. Do **not** reuse the SEO custom-app token. |
| Settings-driven | All rules, tiers, rewards and copy read from config tables, nothing Tsunami-specific in code | Games and Phase 2 reuse it |
| Admin UI | Staff-only. Never client-facing in the LumiLink portal. `/loyalty`, not in the sidebar. Staff = `platform_staff` (added by SQL only, `scripts/add-platform-staff.sql`), not a workspace role: Tsunami's own admin can't open it. Enforced inside SECURITY DEFINER RPCs under the user's own session (no service role), pages 404 for everyone else | Phase 2 merchants get an embedded admin inside Shopify instead. Workspace roles are per client, so they can't mean "LumiLink staff" |
| Pricing | Out of scope for now | Boss asked to focus on cost |
| Joy import | Each import **sets** members to Joy's balance and tier (one ledger entry for the gap, both numbers in the note). Day 0 = opening balances; cutover = final true-up. A snapshot applies once; an older one than the last applied is refused. Compare is read-only | Joy redemptions/claims during the parallel run never reach our ledger, so balances drift by design; only a set-to-Joy at cutover lands exact. Adding Joy's balance would double count orders both systems saw |
| Migration numbers | Blocks per workstream: main/SEO 00xx, **loyalty 0200-0207**, outbound 03xx. Push with `supabase db push --include-all` (pending lower numbers are applied). No renumbering. `db pull` / `migration list` mismatches are expected while branches are apart; never `migration repair` | Production already has outbound 0300/0301 (2026-10-13). Checked: production's 0090/0091/0300/0301 touch only `seo_*` / `outbound_*` and apply cleanly on top of loyalty (tested in a rollback). Outbound's own header documents the same rule |

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

**Built (module 6):** names live in `loyalty_programs.klaviyo_names` (defaults above; unknown = null = not sent). Events: `reward_eligible` (balance crosses a reward cost), `tier_up` (spend/staff), `tier_down` (inactivity/refund), `milestone`, `pre_birthday`, `birthday`, `demotion_warning` (no Joy name known, so off). Each event also carries `points_balance`, `tier`, `referral_url`. **Sending is off until `klaviyo_enabled_at` is set at cutover**; events queued before it are skipped. Backfill (and the module 8 import, which must set `loyalty.quiet`) queue no events.

**Check before cutover:** open one recent event of each `Joy:` metric in Klaviyo and compare its properties with ours. Flow emails that use `{{ event.… }}` need the same property names, which Joy's docs don't list. Also confirm the values Joy uses for `Joy member status` (we send `member`).

## 5. Phase 1: replace Joy (66-90 hrs)

| # | Module | Hrs | Status |
|---|---|---|---|
| 1 | Points ledger, tiers, rules engine (config tables, append-only ledger, RLS) | 12-16 | ☑ 2026-10-13 (`0200_loyalty_core.sql`, `test_loyalty_core.sql`, `setup-loyalty-program.sql`). Not pushed to production |
| 2 | Shopify order, refund, customer sync + historical backfill | 8-10 | ◐ code + tests done 2026-10-13 (`0201_loyalty_shopify_sync.sql`, edge fns `loyalty-webhooks` / `loyalty-oauth` / `loyalty-backfill`, `provision-loyalty-shopify-app.sql`). Not deployed; not yet tested against a real store |
| 3 | Earning rules, milestones, referrals, expiry, demotion (pg_cron jobs) | 12-16 | ☑ 2026-10-13 (`0202_loyalty_earning_jobs.sql`, `test_loyalty_earning_jobs.sql`; webhook parsing extended). Referral discount codes and the Instagram-follow claim endpoint come with modules 4 and 5 (SQL side ready: `loyalty_referrals.discount_code`, `loyalty_award_action`) |
| 4 | Rewards and perks as Shopify discounts ($5, $10 referral, Gold free shipping, members-only prices) | 8-10 | ◐ code + tests done 2026-10-13 (`0203_loyalty_rewards_shopify.sql`, edge fn `loyalty-shopify`, shared `_loyalty/shopify.ts`). All GraphQL + inputs validated against 2026-10. Members-only prices waits on §9 (which products, what %). Not tested against a real store |
| 5 | Wave Rewards page as a theme app block, reusing the current layout | 6-10 | ◐ code + tests done 2026-10-13 (`0204_loyalty_storefront.sql`, edge fn `loyalty-proxy`, theme extension `ll-loyalty/extensions/wave-rewards`, JS source `ll-loyalty/src/`). Both known page bugs fixed. Rendered and clicked through in a local harness with a mocked proxy; not yet on a real store. Order tags (§3) added |
| 6 | Klaviyo events + profile properties (section 4) | 4-6 | ◐ code + tests done 2026-10-13 (`0205_loyalty_klaviyo.sql`, edge fn `loyalty-klaviyo`). End-to-end run against a mock Klaviyo passed (names, formats, skips, 429 retry, no re-sends). Waits on: the two unknown event names, a Klaviyo key, and cutover to turn it on |
| 7 | Staff admin: member lookup, point adjustments | 4-6 | ☑ 2026-10-13 (`0206_loyalty_staff_admin.sql`, `/loyalty` + `/loyalty/members/[id]`, `scripts/add-platform-staff.sql`). Run locally against local Supabase as a test staff user: search, member page, adjust (+ overdraw refused), tier change, access log, and 404 once staff access was removed. Not deployed |
| 8 | Joy data migration, 30-day parallel run, QA | 12-16 | ◐ tooling done 2026-10-13 (`0207_loyalty_joy_migration.sql`, `scripts/joy-import.ts`, runbook [CUTOVER.md](CUTOVER.md), draft [DATA-PROTECTION.md](DATA-PROTECTION.md)). Import + compare run end to end on the local stack with a synthetic export. The migration itself, parallel run and QA happen on the live store (CUTOVER.md B-D) |

**Cutover rule:** keep Joy on until the parallel run shows our balances and tiers match Joy's for
every member (or every difference is explained: Joy-side redemptions and claims are expected). Then
true-up import, switch Klaviyo flows, swap the page block, cancel Joy. Step by step: [CUTOVER.md](CUTOVER.md).

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
| Deploy `loyalty-webhooks`, `loyalty-oauth`, `loyalty-backfill`, `loyalty-shopify`, `loyalty-proxy`, `loyalty-klaviyo` (`--no-verify-jwt`) **before** `shopify app deploy` (the toml now subscribes webhooks to them). Runbook: `scripts/provision-loyalty-shopify-app.sql` | J + Claude | ☐ |
| `shopify app deploy` the config, then install on the dev store | J + Claude | ☐ |
| Decide: the toml points webhooks at **production** Supabase, so a dev-store install writes to production (conflicts with L2-2). Options: a second dev app config (`shopify.app.dev.toml`) pointing at a tunnel to local functions, or accept prod with a throwaway program row | J | ☐ |
| Joy member export (members, balances, tiers, birthdays, join dates); check Joy Settings → Developers for an API key for points history. Run `scripts/joy-import.ts` on it **without** `--apply` first: it reports the column mapping and problem rows | J | ☐ |
| Keep the Joy export **out of git** (customer PII) | J | ☐ |
| Klaviyo private key with events:write and profiles:write (into Vault, runbook step 7) | J | ☐ |
| Docker Desktop running for `npx supabase start` | J | ☑ 2026-10-13 |
| Add J to `platform_staff` in production after 0206 is pushed (`scripts/add-platform-staff.sql`) | J | ☐ |
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
| L1-8 | Retention periods | **No** | Redact webhooks built (module 2), data requests listed in `/loyalty` (module 7), retention table in `DATA-PROTECTION.md` (draft). Still to build: a monthly purge of webhook receipts (90 days) and access log (2 years) | ◐ |
| L1-9 | Encrypt at rest and in transit | Yes | Supabase encryption + HTTPS | ☑ |
| L2-1 | Encrypt backups | Yes | Supabase backups are encrypted | ☑ |
| L2-2 | Separate test and production | Yes | Dev store + local Supabase vs Tsunami + production project | ☑ |
| L2-3 | Data loss prevention strategy | Yes (thin) | `docs/loyalty/DATA-PROTECTION.md` (draft 2026-10-13): backups, restore steps, append-only ledger, access | ☑ reviewed 2026-10-13 |
| L2-4 | Limit staff access | Yes | Staff-only admin route, RLS, only J has DB access | ☑ |
| L2-5 | Strong staff passwords | **No** | Production Supabase Auth: minimum 12 characters + character requirements (local `config.toml` is 6, no rules). Consider MFA for staff | ☐ |
| L2-6 | Access log for protected data | **No** → can flip to Yes once 0206 is in production | `loyalty_access_log` (append-only): every search, member view and change, written inside the staff RPCs so no caller can skip it. No export feature exists | ☑ built 2026-10-13 |
| L2-7 | Security incident response policy | **No** | `DATA-PROTECTION.md` (draft): detect, contain, notify Tsunami within 72h (and Shopify for Phase 2), fix, review | ☑ reviewed 2026-10-13 |

**Do before real Tsunami data flows (before installing on tsunami.store):** L1-7, L1-8, L2-3, L2-5, L2-6, L2-7.
Then update the Dev Dashboard answers.

## 9. Open questions

- Tier achieved and milestone event names in Klaviyo (section 4). Until set, those events aren't sent.
- Tier At Risk segment (TenXzZ): what does it filter on? If it's a Joy event, we need its name for `event_demotion_warning`; we already queue a warning 7 days before demotion.
- Which tier downgrades should email: we send inactivity and refund drops, not staff changes.
- Do Joy's tier counts (4,593) include guest customers? Decides who we import.
- Gold "members-only discounts (select products)": **no products have it yet** (confirmed 2026-10-13), so no `percent_off_products` perk is created. But Gold's perks text (setup script, shown on the Wave Rewards page) still promises "Members-only discounts on select products", as Joy's page does. **Decided 2026-10-13: dropped** from Gold's perks text until products are chosen (setup script).
- Does Tsunami still need the "Redeem in cart" block, or is the rewards page enough?
- Instagram follow (100 pts): honor-system click, same as Joy?
- Enrollment rule (module 2): a customer joins when their Shopify customer `state` is `enabled` (has an account), or anyone if `enroll_guests` is on. Check on the dev store that Shopify's **new customer accounts** (code login) set `state` to `enabled`; if not, the rule needs another signal.
- ~~Tsunami's store time zone~~ Confirmed 2026-10-13: Pacific (PDT/PST) = `America/Los_Angeles`, already what `setup-loyalty-program.sql` sets (the IANA name follows daylight saving).
- A member demoted for inactivity goes straight back to their spend tier on their next order (tier spend isn't reset by demotion). Confirm that's Joy's behaviour.
- Order tag names: our orders are tagged `Loyalty assisted` (a points code was used) and `Loyalty referral` (a referral coupon). Joy used `Joy assisted` / `Joy Referral`. Different names keep the two apart during the parallel run; switch to Joy's (`loyalty_programs.assisted_order_tag` / `referral_order_tag`) at cutover if reports depend on them.
- Referral form abuse: anyone with a member's link can request $10 codes for new emails (one per email, ≤ 10 per referrer per day, `referrals_per_day`). Joy had the same exposure; tighten if it shows up.
- Order points are on the subtotal after discounts, before shipping and tax. Confirm that matches Joy (spot-check a few orders in the parallel run).

## 10. Risks

- **Points balances:** a bad import erases customer rewards. Reconcile per member before cutover.
- **Klaviyo names drift:** flows silently stop. Section 4 is the contract.
- **Double-awarding:** Shopify retries webhooks. Ledger writes must be idempotent on (order id, rule).
- **Refunds:** points must claw back on refund, including tier spend.
- **Shared `WAVE-` prefix with Joy's live codes:** a random collision with a Joy code is now refused (the existing code is only adopted if its title is ours) rather than handed to a member.
- **Joy import (module 8) must run quiet** (`set_config('loyalty.quiet', 'on', true)`), or every imported tier and reward threshold queues a Klaviyo event.
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
| 2026-10-13 | LumiLink | Module 5: migration 0204 (storefront state/writes, set-once birthday, claimable actions, referral form with daily cap, order tags), edge fn `loyalty-proxy` (app proxy signature + timestamp), Wave Rewards theme app block (theme check clean, JS 9.9 KB + lazy friend form). `write_orders`, `write_app_proxy` and `[app_proxy]` added to the toml. Harness test caught and fixed missing point values in the earn copy. Codes: no expiry, single use (confirmed) |
| 2026-10-13 | LumiLink | Module 6: migration 0205 (Klaviyo names as config with Joy defaults, events from tier changes / milestones / reward thresholds, quiet mode for backfill, profile properties by hash, off until `klaviyo_enabled_at`) and edge fn `loyalty-klaviyo` (revision 2026-07-15). Served locally against a mock Klaviyo: correct names and MM/DD/YYYY birthdays, skips for pre-enable / unnamed / no-email, 429 retried, nothing re-sent on the next run |
| 2026-10-13 | LumiLink | Module 7: migration 0206 (platform_staff, append-only access log, staff-checked SECURITY DEFINER RPCs for search / member detail / adjust / tier / birthday / data requests) and the `/loyalty` pages. Data-request webhooks now record the customer id. Verified in the browser against local Supabase (test staff user, then removed) and all test data cleaned up. Local dev preview config `support-dashboard-local` lives in `Lumilink/.claude/launch.json` (outside the repo) |
| 2026-10-13 | LumiLink | Module 8 tooling: migration 0207 (Joy snapshots; import sets balances/tiers with the gap recorded, carries join/activity dates and birthdays, quiet; read-only compare; purge), `scripts/joy-import.ts` (alias-mapped CSV, dry run by default, explicit `LOYALTY_*` env to apply), CUTOVER.md runbook with QA script, DATA-PROTECTION.md draft. Design changed mid-module from import-once to set-to-Joy true-up after tracing the parallel run. Module 4 fix: code lookup checks the title before adopting an existing code |
| 2026-10-13 | LumiLink | Time zone confirmed (Pacific). Gold members-only discount: no products yet. Production migration history checked (read-only): it has main's 0090/0091 and another branch's 0300/0301; loyalty 0200-0207 are NOT in production. Don't run the `migration repair` commands `db pull` suggests. Pushing loyalty needs `--include-all` (or renumbering above 0301), after checking 0300/0301 don't touch what loyalty depends on |
| 2026-10-13 | LumiLink | Fetched production's migration SQL (read-only, scratch copy): 0300/0301 are the outbound branch (`outbound_*` only; it plans to reuse loyalty's staff concept). No overlap with loyalty; applied all four on top of loyalty locally in a rollback, loyalty tests still 8/8. Decision: keep numbers, push with `--include-all` from main |
| 2026-10-13 | LumiLink | `loyalty` merged into main (bb11036) and pushed. J pushed migrations 0200-0207 to production with `db push --include-all` (dry run first showed exactly those 8). The push needed outbound's 0300/0301 present locally: used untracked copies fetched from production's history, deleted after. Long-term fix: merge the outbound branch into main |
| 2026-10-13 | LumiLink | Production setup: edge functions deployed (all `verify_jwt` false, probed), Vault URLs added, lumilinkhq@gmail.com added as platform staff, Tsunami program created (setup script), Shopify app deployed. Not installed on tsunami.store yet: waiting on the A1 data-protection items |
| 2026-10-13 | LumiLink | `/loyalty` shows Wave Rewards (0 members) for staff. DATA-PROTECTION.md reviewed and agreed (L2-3, L2-7). Dev-store rehearsal added to CUTOVER.md (custom distribution allows dev-store installs) |
| 2026-10-13 | LumiLink | Dev-store install failed: `invalid_link_organization` (the dev store is in a different org than the app; app org is Lumilink 240443031). Our side worked (store registered, OAuth reached Shopify). Fix: new dev store in the Lumilink org, redact the old dev program |
