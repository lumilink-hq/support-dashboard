# LL Loyalty: data protection

**Reviewed and agreed by J, 2026-10-13.** Covers PLAN §8b items L1-8 (retention), L2-3 (data loss
prevention) and L2-7 (incident response). L1-7 (the agreement with Tsunami) is a separate document.
Once agreed, flip the matching answers in the Shopify Dev Dashboard.

## What we hold

Per loyalty member: Shopify customer id, email, first and last name, birthday (if given), points
ledger, tier, order ids and amounts, reward codes, referral friends' emails. No phone, address or
payment data. Klaviyo receives tier, points, member status, referral URL and birthday under the
member's email.

## Retention (L1-8)

| Data | Kept | How it goes |
|---|---|---|
| Member and their ledger, orders, codes, referrals | While the store runs the program | `customers/redact` deletes the member and everything hanging off them (built, module 2) |
| Everything for a store | Until 48h after uninstall | `shop/redact` deletes the program, tokens and webhook receipts (built) |
| Joy export snapshots (`loyalty_joy_rows`) | Until read; never past 45 days | `scripts/joy-import.ts --purge` (CUTOVER.md); summaries without PII stay |
| Joy export files | Off the repo; deleted at Joy cancellation | By hand |
| Webhook receipts (ids, outcomes, no payloads) | 90 days | *To build: a monthly purge job* |
| Access log (`loyalty_access_log`, no PII, member ids only) | 2 years | *To build with the receipt purge* |
| Supabase backups | Supabase's schedule (7 days on Pro) | Automatic |

`customers/data_request`: listed in `/loyalty` with the customer id; staff reply to the store
within 30 days with what's held (member page shows all of it).

## Data loss prevention (L2-3)

- **Backups:** Supabase daily backups (encrypted). Point-in-time recovery is a paid add-on;
  decide before go-live whether daily is enough (worst case: a day of points, rebuildable from
  Shopify orders for order points, not for actions or redemptions).
- **Restore:** Supabase Dashboard → Database → Backups → restore to a new project first, compare,
  then switch. Never restore over production without a copy.
- **Ledger is append-only** (database trigger): a mistake is corrected with a new entry, so
  history can't be lost by an edit. `loyalty_verify_balances` checks cached balances against it.
- **Access:** production database access is J only. Staff admin is limited to `platform_staff`
  and logs every member view and change.
- **Secrets:** Shopify tokens, app secrets and the Klaviyo key are in Supabase Vault, never in
  code or tables.

## Security incident response (L2-7)

1. **Detect:** unexpected access-log entries, webhook/HMAC failures in bulk, Supabase or Shopify
   security alerts, a report from Tsunami.
2. **Contain (same day):** rotate the affected secret (Shopify app secret / token, Klaviyo key,
   `voice_tool_secret`, Supabase service key); remove staff access (`platform_staff`); pause the
   program (`is_active = false`) if data is still exposed.
3. **Assess:** what data, which members, what window. The access log and webhook receipts are the
   record.
4. **Notify:** Tsunami within 72 hours of confirming personal data was exposed (they notify
   customers as the merchant). For the Phase 2 public app, also Shopify per the Partner terms.
5. **Fix and review:** root cause, fix, a short written review within two weeks, and update this
   document.

## Staff accounts (L2-5)

Production Supabase Auth: minimum 12 characters with character requirements, and MFA for anyone
in `platform_staff`. (Local `config.toml` is 6 characters, no rules; production is set in the
Supabase Dashboard, not by migration.)
