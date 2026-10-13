# LL Loyalty: Joy migration, parallel run and cutover

Runbook for module 8. Read [PLAN.md](PLAN.md) first. Scripts referenced here:
`scripts/setup-loyalty-program.sql`, `scripts/provision-loyalty-shopify-app.sql`,
`scripts/joy-import.ts`, `scripts/add-platform-staff.sql`.

**Rule:** Joy stays on until the daily compare shows our balances and tiers match Joy's for every
member, or every difference is explained. Then switch.

---

## A. Before anything touches tsunami.store

| # | Step | Done |
|---|---|---|
| A1 | Data protection items that must land before real data (PLAN §8b): L1-7 agreement with Tsunami, L1-8 retention + privacy webhooks (built), L2-3/L2-7 `DATA-PROTECTION.md`, L2-5 strong staff passwords on production Supabase Auth, L2-6 access log (built) | ☐ |
| A2 | Merge `loyalty` into main, then from main `supabase db push --include-all` (production already has 0300/0301 from the outbound branch, so 0200-0207 are "lower"; checked 2026-10-13 that they don't overlap). Do **not** run the `migration repair` commands `db pull` suggests || ☑ 2026-10-13 |
| A3 | Deploy edge functions, all `--no-verify-jwt`: `loyalty-webhooks`, `loyalty-oauth`, `loyalty-backfill`, `loyalty-shopify`, `loyalty-proxy`, `loyalty-klaviyo`. Check `supabase functions list` shows `verify_jwt` false | ☐ |
| A4 | Vault secrets: `loyalty_backfill_url`, `loyalty_shopify_url`, `loyalty_klaviyo_url` (provision runbook steps 4, 5, 7) | ☐ |
| A5 | `setup-loyalty-program.sql` for Tsunami (confirm time zone first), then provision runbook steps 1-2 | ☐ |
| A6 | `add-platform-staff.sql` for J; open `/loyalty` and see the program | ☐ |
| A7 | From `ll-loyalty/`: `npm run build:blocks && shopify app deploy` | ☐ |
| A8 | Klaviyo key in Vault, `rewards_page_url` set, **`klaviyo_enabled_at` left empty** | ☐ |

## B. Day 0: install, backfill, opening balances

Do B1-B4 in one sitting so the Joy export is as close to install time as possible.

1. **Install** the app on tsunami.store (provision step 3). This sets `live_since`; webhooks start.
2. **Backfill**: `select start_loyalty_backfill(id) from loyalty_programs where shop_domain = '…';`
   Watch `select * from loyalty_backfills;` until `done`. It records order counts and tier spend
   with 0 points and emails nobody.
3. **Export from Joy** (members with balances, tiers, birthdays, join dates). Save it **outside the
   repo**. Note the exact time you downloaded it.
4. **Import**, dry run first:
   ```
   npx tsx scripts/joy-import.ts <export.csv> --program <id> --kind import --taken-at <download time>
   ```
   Check the column mapping, tier names (must match ours: Bronze/Silver/Gold), problem rows. Then
   rerun with `--apply` and `LOYALTY_SUPABASE_URL` / `LOYALTY_SERVICE_KEY` set to **production**.
   Expect `imported` ≈ members, few `unmatched`. Note the snapshot id.
5. **Spot-check 10 members** in `/loyalty` against Joy's admin: points, tier, birthday.
6. Purge the import snapshot: `npx tsx scripts/joy-import.ts --purge <snapshot>`.

## C. Parallel run (30 days)

Joy is still the customer-facing program. Ours runs silently: the Wave Rewards block is **not**
on the live page yet, Klaviyo is off.

**Daily** (or every few days):

1. Export from Joy, then `--kind compare --apply`. Read the summary and the top differences.
2. Sort each difference into one of these:
   - **Expected:** the member redeemed, claimed Instagram, set a birthday or got a staff
     adjustment *in Joy*. Our ledger never sees those, so they're fine, and the cutover true-up
     absorbs them. Check in Joy's admin for that member.
   - **Timing:** an order or refund in the minutes around the export. It disappears next day.
   - **A bug:** an order, refund, milestone or tier promotion we scored differently. Look at the
     member's history in `/loyalty` and fix it before cutover.
3. `select topic, outcome, error from loyalty_webhook_receipts where error is not null order by received_at desc;`
   should be empty.
4. `select status, count(*) from loyalty_discount_codes group by 1;` and
   `select key, last_error from loyalty_perks;` show no failures.
5. Purge each compare snapshot once read.

**Exit criteria:** five consecutive compares with zero bug-type differences, and every
`points_only` / `tier_only` row explained.

### QA on the real store (once, early in the parallel run)

Use a test customer account on tsunami.store and a hidden duplicate page (e.g.
`/pages/wave-rewards-ll`, not linked anywhere) with the Wave Rewards block on it.

| # | Do | Expect |
|---|---|---|
| Q1 | Create an account | Member in `/loyalty`, +100 signup, Bronze |
| Q2 | Place a $20 order (subtotal) | +60 points, 1st-order milestone +100, order tagged nothing (no code used) |
| Q3 | Refund half of it | −30 points, tier spend −$10 |
| Q4 | Set a birthday on the hidden page; try again | Saved once; second try refused |
| Q5 | Follow & earn (Instagram) | +100 once |
| Q6 | Staff: adjust +1,000 in `/loyalty` | Balance up; access log row |
| Q7 | Redeem $5 on the page | `WAVE-` code shown within a minute; works once at checkout, only for this customer; order tagged `Loyalty assisted` |
| Q8 | Open the referral link logged out, enter a new email | `WAVE-REF-` $10 code; using it on a paid order gives the referrer +300 and tags the order `Loyalty referral` |
| Q9 | Staff: set tier Gold; checkout a $75+ cart | Customer tag `LL Tier Gold`, free shipping offered |
| Q10 | Customer admin page in Shopify | `ll_loyalty.tier` / `ll_loyalty.points` metafields current |
| Q11 | Klaviyo test: set the event names to `LL: …` (provision step 7), set `klaviyo_enabled_at`, repeat Q2/Q7 | `LL:` events on the test profile, nothing under `Joy:` names. **Then clear `klaviyo_enabled_at` again** |

## D. Cutover day

1. **Turn off earning in Joy** (keep Joy installed so its data stays readable).
2. Final Joy export → **import** (not compare), `--taken-at` = download time. This is the true-up:
   every member is set to Joy's final balance and tier, and each gap lands in the ledger as an
   `import` entry with Joy's and our numbers in the note.
3. Compare against the same export: should be all `match`.
4. **Klaviyo:** restore Joy's names (`klaviyo_names` defaults), then
   `update loyalty_programs set klaviyo_enabled_at = now() where shop_domain = '…';`
   Fill in the tier-achieved and milestone event names if known (PLAN §9).
5. **Theme:** on `/pages/wave-rewards`, add the Wave Rewards block and remove Joy's blocks
   (hero, account, my reward, how it works, ways to earn, VIP tier, login). Remove Joy's
   "Redeem in cart" block if Tsunami agreed (PLAN §9).
6. Check a Klaviyo flow end to end (Reward Ready on a test profile).
7. Watch for a week: webhook errors, code failures, Klaviyo failures
   (`select status, count(*) from loyalty_events group by 1;`).
8. **Cancel Joy** ($129/mo) after the week. Purge all Joy snapshots. Delete export files.

## Rollback

Until step D8, Joy is still installed with its data intact:
- Put Joy's blocks back on the page, re-enable Joy's earning.
- `update loyalty_programs set klaviyo_enabled_at = null …` stops our Klaviyo sends immediately.
- Points earned in our system after cutover are in our ledger; settle them with staff adjustments
  in Joy before switching back.
