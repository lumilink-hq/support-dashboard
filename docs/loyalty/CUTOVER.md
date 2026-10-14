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
| A3 | Deploy edge functions, all `--no-verify-jwt`: `loyalty-webhooks`, `loyalty-oauth`, `loyalty-backfill`, `loyalty-shopify`, `loyalty-proxy`, `loyalty-klaviyo`. Check `supabase functions list` shows `verify_jwt` false || ☑ 2026-10-13 |
| A4 | Vault secrets: `loyalty_backfill_url`, `loyalty_shopify_url`, `loyalty_klaviyo_url` (provision runbook steps 4, 5, 7) || ☑ 2026-10-13 |
| A5 | `setup-loyalty-program.sql` for Tsunami (confirm time zone first), then provision runbook steps 1-2 || ☑ 2026-10-13 |
| A6 | `add-platform-staff.sql` for J; open `/loyalty` and see the program || ☑ 2026-10-13 |
| A7 | From `ll-loyalty/`: `npm run build:blocks && shopify app deploy` || ☑ 2026-10-13 |
| A8 | Klaviyo key in Vault, `rewards_page_url` set, **`klaviyo_enabled_at` left empty** | ☐ |

## A′. Dev-store rehearsal (before tsunami.store)

Custom distribution allows installs on development stores **in the app's own organization**
(LL Loyalty is in **Lumilink, 240443031**). That org's dev store is **LL Dev store,
`ll-dev-store-meumbtld.myshopify.com`**: use that domain below. A dev store from another org
fails the install with `invalid_link_organization`. Check with
`shopify store list --organization-id 240443031`.
Run the whole flow there first. It
uses the **production** backend with its own program row (data is keyed by shop domain, so it
never mixes with Tsunami's) and is deleted at the end.

1. **Program:** `setup-loyalty-program.sql` with `v_client` = LumiLink's own workspace (not
   Tsunami's), `v_client_name` = its name, `v_shop` = the dev store's `*.myshopify.com`.
2. **Register:** provision step 2 for the dev store, reusing the app's existing Vault secret
   (same app, same client id and secret).
3. **Install** by opening
   `https://xqsxjxrzpxhosedkmufg.supabase.co/functions/v1/loyalty-oauth?shop=<dev>.myshopify.com`
   and approving. **Don't use `shopify app dev`:** `automatically_update_urls_on_dev` would
   repoint the App URL at a tunnel.
4. **Backfill:** `select start_loyalty_backfill(id) from loyalty_programs where shop_domain = '<dev>.myshopify.com';`
5. **Theme:** add the Wave Rewards block to a page on the dev store's theme.
6. **QA:** run the Q1-Q10 table in section C (test orders with Shopify's Bogus gateway). Q11
   (Klaviyo) needs a Klaviyo key on the dev program; use a test Klaviyo account or skip it.
7. **Import:** make a small CSV for the dev members and run `scripts/joy-import.ts` import then
   compare, to rehearse day 0 and the daily check.
8. **Clean up:** uninstall the app from the dev store, then
   `select loyalty_redact_shop('<dev>.myshopify.com');` deletes the dev program, its members,
   tokens and receipts (the access log keeps its id-only rows).

## B. Day 0: install, backfill, opening balances

Do B1-B4 in one sitting so the Joy export is as close to install time as possible.

1. **Install** the app on tsunami.store (provision step 3). This sets `live_since`; webhooks start.
2. **Backfill**: `select start_loyalty_backfill(id) from loyalty_programs where shop_domain = '…';`
   Watch `select * from loyalty_backfills;` until `done`. It records order counts and tier spend
   with 0 points and emails nobody.
3. **Export Joy's balances from Klaviyo** (Joy's API needs the Ultimate plan and its in-app export
   wasn't available; Joy syncs `Joy Loyalty Points` / `Joy Vip tier` / `Birthday` onto every
   member's Klaviyo profile):
   ```
   npx tsx --env-file=.env.local scripts/klaviyo-joy-export.ts <path outside the repo>.csv
   ```
   It reads the three "Wave Rewards: Bronze / Silver / Gold VIP Members" segments and refuses to
   write inside the repo. Use the time it finishes as `--taken-at`. (Checked 2026-10-14: 4,456
   members, Bronze 4,432 / Silver 21 / Gold 3, 554,343 points, 0 problems.) The file has no join
   or activity dates: join dates come from Shopify (backfill), and the import starts the expiry
   and demotion clocks at the export (0208), so nobody loses points or a tier on day one.
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

1. Run `scripts/klaviyo-joy-export.ts` again, then `joy-import.ts --kind compare --apply`. Read the
   summary and the top differences. (Klaviyo lags Joy by minutes, so a few very recent changes show
   as timing differences.)
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
| Q1 | Create an account (new customer accounts: sign in with the emailed code) | Member in `/loyalty`, +100 signup, Bronze. A guest checkout also creates a member (every customer is one) |
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
2. Wait a few minutes after turning off Joy's earning (Klaviyo catches up), then the final
   Klaviyo export → **import** (not compare), `--taken-at` = when the export finished. This is the true-up:
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
8. **Cancel Joy** ($129/mo) after the week. Purge all Joy snapshots. Delete export files. Remove
   `KLAVIYO_API_KEY` / `JOY_READ_ONLY_KEY` from `.env.local` if nothing else needs them.

## Rollback

Until step D8, Joy is still installed with its data intact:
- Put Joy's blocks back on the page, re-enable Joy's earning.
- `update loyalty_programs set klaviyo_enabled_at = null …` stops our Klaviyo sends immediately.
- Points earned in our system after cutover are in our ledger; settle them with staff adjustments
  in Joy before switching back.
