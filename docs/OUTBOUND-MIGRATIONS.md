# Outbound branch migrations

What the `outbound` branch adds to the database, so other branches (loyalty, main) can check for conflicts. Written 2026-10-13.

## Status

| Migration | Committed | On production | What it is |
|---|---|---|---|
| `0300_outbound_schema.sql` | yes (`1d9c5a0`) | **yes** | Four tables, a view, five helper functions and triggers |
| `0301_outbound_source.sql` | yes (`ba8ee58`) | **yes** | Paging columns on `outbound_profiles`, `outbound_insert_leads()` |
| `0302_outbound_enrich.sql` | yes (`b741ec0`) | no | `claimed_until` column, `outbound_claim_leads()`, `outbound_record_email()` |
| `0303_outbound_verify.sql` | yes (`b9f741e`) | no | `outbound_record_verification()` |
| `0304_outbound_schedule.sql` | yes (`feeedb5`) | no | `request_outbound_job()` and 3 cron jobs: `outbound-source-daily`, `outbound-enrich-due`, `outbound-verify-due` |
| `0305_outbound_snapshots.sql` | yes (`2408674`) | no | `outbound_snapshots` table (pre-call SEO snapshot per lead) |
| `0306_outbound_instantly.sql` | not yet | no | `outbound_claim_pushable()`, `outbound_pushed_today()`, `outbound_in_instantly()`, `outbound_suppress_lead()`, an `instantly` branch in `request_outbound_job()` (replaces 0304's body, an outbound object), cron job `outbound-instantly-due` |

**Production already has 0300 and 0301** (checked with `supabase migration list` on 2026-10-13). They were pushed from this folder while it was on the `outbound` branch. That's why pushing loyalty's 02xx migrations now fails: production's latest version is 0301, and the CLI refuses to apply a lower number after a higher one unless told to.

## What the migrations touch

**Everything is new and named for outbound.** Objects start with `outbound_`, except 0304's dispatch function `request_outbound_job` and its cron jobs (`outbound-…`), which follow the existing `request_*` naming. None of the migrations alters, drops or replaces anything that existed before them.

| Kind | Objects |
|---|---|
| Tables | `outbound_profiles`, `outbound_leads`, `outbound_events`, `outbound_suppressions` |
| View | `outbound_funnel` (security_invoker) |
| Functions | `outbound_normalize_domain`, `outbound_is_suppressed`, `outbound_leads_set_domain`, `outbound_leads_log_stage`, `outbound_suppressions_normalize`, `outbound_insert_leads`, `outbound_claim_leads`, `outbound_record_email`, `outbound_record_verification` |
| Triggers | `trg_outbound_profiles_updated_at`, `trg_outbound_leads_set_domain`, `trg_outbound_leads_updated_at`, `trg_outbound_leads_log_stage`, `trg_outbound_suppressions_normalize`, all on outbound tables only |
| Indexes | `uq_outbound_leads_email`, `uq_outbound_leads_domain`, `uq_outbound_leads_instantly`, `idx_outbound_leads_profile_stage`, `idx_outbound_leads_stage_claim`, `idx_outbound_events_lead`, `idx_outbound_events_profile`, `uq_outbound_suppressions_email`, `uq_outbound_suppressions_domain` |
| Columns added later | 0301: `outbound_profiles.source_cursor_key`, `source_offset_token`, `source_total_count`, `source_exhausted_at`, `last_sourced_at`. 0302: `outbound_leads.claimed_until` |
| Access | RLS on, **no policies**, and every grant to `anon` and `authenticated` revoked on all of the above. Service role only. 0307 adopts loyalty's staff model: staff reach the tables only through SECURITY DEFINER RPCs guarded by `outbound_require_staff()`, never through policies. |

**Existing objects these depend on**, read only and never changed:
- `set_updated_at()`, from 0001, used by two triggers.
- `seo_locations.website_url`, from 0042. `outbound_is_suppressed()` reads it so current clients' domains are never emailed.

The functions also call `check_and_reserve_vendor_budget('dataforseo')` from 0048. That call is in function code, not in a migration.

## Conflict checklist for another branch

A loyalty migration conflicts with these only if it does one of the following:

1. **Creates anything named `outbound_…`** (table, function, trigger, index or view), a function named `request_outbound_job`, or a cron job named `outbound-…`.
2. **Drops or renames `set_updated_at()`** or `seo_locations.website_url`, or changes `set_updated_at()` in a way that breaks it.
3. **Adds a global event trigger or default privileges** that would grant `anon` or `authenticated` access to new tables. The outbound tables revoke those grants explicitly, but a later blanket `grant … on all tables in schema public` would re-open them.
4. **Puts a staff or role concept on tables outbound expects to own.** The staff concept will eventually add policies to the outbound tables. That should happen in an outbound migration (0304+) once loyalty's model is committed, not in a loyalty migration.

None of the outbound migrations creates a staff, role or loyalty object, so the other direction is clean.

## Getting loyalty's migrations onto production

1. Check loyalty's 02xx files against the checklist above.
2. Preview what would run, from the loyalty checkout: `npx supabase db push --include-all --dry-run`. It should list only the 02xx files, plus 0302 and 0303 if this branch's files are present in that checkout.
3. Apply: `npx supabase db push --include-all`. This writes to production, so run it deliberately.
4. Confirm with `npx supabase migration list` that every local version has a matching remote one.

**Before step 3, check that production's 0301 is the final version.** The committed 0301 counts `v_received` after the input type check. An earlier draft counted it before, and errored on non-array input. If the push happened from that draft, production's `outbound_insert_leads` differs from the committed file. Compare `pg_get_functiondef('outbound_insert_leads(uuid,jsonb,text)'::regprocedure)` on production with the file, and re-run 0301 if they differ (it's idempotent).

**Avoiding this next time:** push migrations only from `main` after merging. Or have each branch keep to its own range and push in number order: loyalty 02xx before outbound 03xx.
