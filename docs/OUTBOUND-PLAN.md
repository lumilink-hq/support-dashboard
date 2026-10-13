# Outbound engine build plan

Cold-email lead generation inside the LumiLink portal. Approved 2026-10-13, based on the scope brief
`Claude outputs/LumiLink-Outbound-Engine-Scope.docx` (Draft 5) and the research report
`../reports/Cold email infrastructure cost cutting.md`.

| | |
|---|---|
| **Branch** | `outbound`, cut from `main` on 2026-10-13 |
| **Migrations** | **0300 and up**, reserved for this work. Main is at 0091 and growing; loyalty uses 200 and up. When this branch merges after a lower-numbered migration has already reached prod, `supabase db push` refuses to apply out of order and needs `--include-all`. |
| **Effort** | 26–40 hours: 20–30 of build plus 6–10 of live testing |
| **Tools** | Instantly Growth $47/mo, InboxKit 10 Google mailboxes $30/mo, 5 Cloudflare .com domains about $52/yr, Reoon 10K checks $11.90 once, DataForSEO (existing account) |
| **Critical path** | Mailbox warm-up, 2–3 weeks from purchase. Phase 0 starts it, and the build happens while it runs. |

## Decisions

- **The staff access model is ON HOLD (2026-10-13).** The loyalty branch is building a staff concept that isn't committed yet. Once it lands, review it and adopt it here. Until then, every outbound table is **service-role only**: RLS on, no `authenticated` policies, so nothing is readable from the browser. The UI phase (Phase 3) waits on this decision; everything before it runs server-side and doesn't depend on it.
- **Global dedupe and suppression.** A business or email address is contacted by only one profile, ever. Unsubscribes, bounces and existing LumiLink clients go on the suppression list and are never pushed to Instantly.
- **Instantly Growth has no webhooks.** Replies are **polled** through the API. Finished leads are **deleted from Instantly** after their history is saved here, because uploaded contacts are a running total (1,000 on Growth).
- **Lead data comes from DataForSEO business listings**, not Google Maps scraping or the Places API (whose terms forbid storing the data).
- **Every function deploys with `--no-verify-jwt`**, authenticates with the shared-secret header, and gets a `config.toml` entry, like every other function.

## Data model (0300)

| Table | Holds | Key points |
|---|---|---|
| `outbound_profiles` | One per audience × product pair | name, `product` (`voice` / `seo`, from `lib/catalog.ts`), `audience` jsonb (categories, locations, filters such as has-website and minimum rating), offer, `instantly_campaign_id`, daily lead target, status `draft` / `active` / `paused`. Owner column is deferred to the access decision. |
| `outbound_leads` | One business | source + `source_ref` (DataForSEO id), name, category, address, phone, website, normalised domain, rating, review count, email, page the email came from, verification result, `stage`, Instantly lead id, last reply, reply snippet, snapshot link. Unique on `(source, source_ref)`, `lower(email)` and domain. |
| `outbound_events` | What happened to each lead, when | type + payload. Feeds the funnel and the audit trail. |
| `outbound_suppressions` | Never contact | email or domain, reason (`unsubscribed` / `bounced` / `client` / `manual`), source. Checked before every push. |

Stages: `sourced` → `email_found` / `no_email` → `verified` / `invalid` → `queued` → `sending` → `replied` → `positive` / `negative` → `called` → `booked` → `won` / `lost`, plus `suppressed`.

**Scheduling, still to decide when 0300 is written.** `job_attempts` (0048) is keyed by `(client_id, job_type)` and outbound jobs run per profile. Either key them by the owning workspace with `job_type = 'outbound-source:<profile_id>'`, or keep `next_run_at` on the profile. Both reuse `vendor_budgets` for DataForSEO's rate limit.

## Phases

### Phase 0: accounts and warm-up (week 1, no code; user and boss)
- [ ] Buy getlumilink.com, trylumilink.com, uselumilink.com, lumilinkhq.com and hellolumilink.com on Cloudflare. Recheck availability first; all five were unregistered on 2026-10-08.
- [ ] Point each domain's website at `https://www.lumilinkhub.com` with a redirect.
- [ ] InboxKit: 10 Google mailboxes, 2 per domain, real first and last names. InboxKit sets up SPF, DKIM and DMARC.
- [ ] Instantly Growth: connect all 10 mailboxes and turn warm-up on. **That day is the warm-up start date: record it here.**
- [ ] Instantly campaign settings: LumiLink postal address in the footer and the unsubscribe link on (CAN-SPAM).
- [ ] **Week-one test: confirm an Instantly API key can be created on Growth** and that `GET /api/v2/campaigns` works. If it can't, the plan changes to Hypergrowth ($97) before any Instantly code is written.
- [ ] Reoon: an account and the 10K credit pack ($11.90).
- [ ] Supabase secrets: `INSTANTLY_API_KEY`, `REOON_API_KEY`. DataForSEO is already set.

### Phase 1: lead pipeline, server-side only (about 7–10 hrs)
1. **`0300_outbound_schema.sql`**: the four tables, indexes, service-role-only RLS and SQL isolation tests. ✅ **Built and Docker-verified (2026-10-13). Not pushed to prod.**
   - Tables `outbound_profiles`, `outbound_leads`, `outbound_events`, `outbound_suppressions`, and a security-invoker `outbound_funnel` view.
   - Helpers `outbound_normalize_domain()` and `outbound_is_suppressed(email, website)`. The second also blocks any LumiLink client's `seo_locations` website domain.
   - Triggers derive `domain` from `website_url`, stamp `stage_changed_at`, and log every insert and stage change to `outbound_events`.
   - `scripts/test_outbound_schema.sql` passes against the local stack. It covers normalisation, the three dedupe rules, the profile checks, stage events, the funnel, email-, domain- and client-level suppression, and both browser roles being refused. Dropping `uq_outbound_leads_domain` makes it fail.
   - Applied twice locally to confirm it's idempotent; `check-migration-sql` is clean.
   - **Local note:** the local database was only at 0080, missing main's 0081–0091. 0300 was applied by hand because it doesn't depend on them.
2. **`outbound-source`**: DataForSEO `business_data/business_listings/search/live` per active profile, using `vendor_budgets`. Skips suppressed domains and businesses already on file. **Spend cap per run.** Test with a real $0.05 call on one profile. 🟡 **Built and locally verified (2026-10-13); no real DataForSEO call made yet.**
   - **`0301_outbound_source.sql`**
     - Adds a paging cursor to each profile: `source_cursor_key`, `source_offset_token`, `source_total_count`, `source_exhausted_at` and `last_sourced_at`.
     - Adds `outbound_insert_leads(profile, rows)`: one insert per page that skips duplicates on any of 0300's rules, plus suppressed and client domains. It returns received, inserted, duplicates, suppressed and invalid counts.
     - `scripts/test_outbound_source.sql` passes.
   - **`supabase/functions/outbound-source`** (`index.ts` and `lib.ts`)
     - **One Live call per due active profile.** It buys `pageLimit` = 4× the daily target, clamped to 100–1,000 listings, sorted by most reviews.
     - **Skips a profile when** it was sourced in the last 20 hours, its audience is exhausted, or it already has 5 days of unprocessed leads. `force` overrides these checks.
     - **`dry_run`** returns the request without spending anything.
     - **Paging** resumes from the stored token unless the audience changed. It stops when a page comes back short or without a token.
     - **Listings are skipped** if they have no id or name, are closed (permanently or temporarily), or have no website. The last check can be turned off with `require_website: false`.
   - **Tests**
     - `scripts/test-outbound-source.ts`: 44 unit tests pass.
     - The function was run on the local edge runtime with `functions serve`. Verified: a wrong secret gets 401; no active profiles does nothing; a draft profile without force is refused; a forced dry run returns the expected request; an unknown profile gets 404; an empty audience gets `bad_audience`; and a real call without DataForSEO credentials gets "Server not configured".
     - `npm run check` passes.
   - **Not verified:**
     - **A real DataForSEO call.** The parser's field names come from the docs (`cid`, `title`, `url`, `address_info.*`, `rating.value/votes_count`, `work_time.work_hours.current_status`). They have not been checked against a real response.
     - **Whether `rating.value` and `rating.votes_count` are accepted as filter fields.** The docs show `rating.value` in an example; the full filter list wasn't read.
     - **Whether `cannabis_store` is a real DataForSEO category id.**
3. **`outbound-enrich`**: fetch home, contact and about pages, using the `seo-crawl` fetch code and `render-service` for JavaScript-rendered sites. Extract emails from mailto links, page text and simple obfuscation. Prefer same-domain addresses and skip images and placeholder addresses.
4. **`outbound-verify`**: Reoon single-email check. `valid` → `verified`; `invalid` → `invalid` plus a suppression entry; catch-all and unknown are kept, flagged, and sent last.
5. Cron: source daily, enrich and verify every 15 minutes in batches. Migration `0301`.

### Phase 2: Instantly sync (about 4–8 hrs)
1. **`outbound-instantly` push**: verified, unsuppressed leads go into the profile's campaign, up to the daily target. Store the Instantly lead id; stage becomes `queued`.
2. **Reply polling** every 10 minutes: replies and unsubscribes. Unsubscribe or bounce adds a suppression entry. A reply moves the lead to `replied` with a snippet.
3. **Cleanup**: once a lead's sequence has finished, save its final state and delete it from Instantly. Alert when the contact count passes 800 of 1,000.
4. Cron: migration `0302`.

### Phase 3: portal UI (about 9–14 hrs; waits on the staff access model)
1. Access policies plus the route group and sidebar entry, following whatever the loyalty staff concept becomes.
2. **Profiles**: list, create and edit (audience builder, product, offer, campaign link), pause and resume.
3. **Reply inbox**: replies, mark positive or negative, a "call now" task with phone and website, and outcome tracking (`called` / `booked` / `won` / `lost`).
4. **Funnel**: counts per stage per profile, plus signups attributed through `/onboarding/add`.

### Phase 4: pre-call SEO snapshot (about 4–5 hrs)
- Run the existing crawl, technical audit and rank and competitor checks against a **prospect** domain, with no client or location rows, and render a one-page summary for the call. Needs `seo-crawl` / `seo-technical-audit` refactored to accept a bare URL. SEO profiles only in v1.

### Phase 5: live testing (6–10 hrs)
- See §8 below.

## §8 Setup and live-test items

Hand-test at the end. Add items as each phase is built.

- [ ] Deploy `outbound-source` with `--no-verify-jwt`.
- [ ] Run one forced, real call on a test profile with `daily_lead_target` 25 (100 listings, about $0.05).
  - Check that the parser's fields fill in: city, region, website, rating, review count.
  - Check whether the rating filters are accepted.
  - Look up the right category ids for dispensaries and HVAC (DataForSEO `business_listings/categories`).
- [ ] Push 0300 to prod. It needs `supabase db push --include-all` if any lower-numbered migration landed first. Afterwards confirm the four tables and `outbound_funnel` exist, and that the anon key returns a permission error on `outbound_leads`.

- [ ] A real DataForSEO listings call returns the expected fields for one dispensary profile. Check coverage for one state.
- [ ] Enrichment finds an email on a sample of 50 real business sites. Record the hit rate.
- [ ] Reoon results match on a known-good and a known-bad address.
- [ ] Instantly push, reply poll and cleanup against a test campaign that sends only to our own inboxes.
- [ ] An unsubscribe in Instantly lands in `outbound_suppressions` within one polling cycle.
- [ ] Seed test of one sending domain (GlockApps or similar) before the first real send.
- [ ] All functions deployed with `--no-verify-jwt`; `supabase functions list` shows verify_jwt = false.

## Open questions

- Staff access model: waiting on the loyalty branch.
- First two profiles: leadership's call (in the Action Plan).
- Who calls positive replies: leadership names them before the first send.
- Scheduling key for per-profile jobs (see Data model).
