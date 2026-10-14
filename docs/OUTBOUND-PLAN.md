# Outbound engine build plan

Cold-email lead generation inside the LumiLink portal. Approved 2026-10-13, based on the scope brief
`Claude outputs/LumiLink-Outbound-Engine-Scope.docx` (Draft 5) and the research report
`../reports/Cold email infrastructure cost cutting.md`.

| | |
|---|---|
| **Branch** | `outbound`, cut from `main` on 2026-10-13 |
| **Migrations** | **0300 and up**, reserved for this work. Main is at 0091 and growing; loyalty uses 200 and up. When this branch merges after a lower-numbered migration has already reached prod, `supabase db push` refuses to apply out of order and needs `--include-all`. |
| **Effort** | 26–40 hours: 20–30 of build plus 6–10 of live testing |
| **Tools** | Instantly Growth $47/mo, Zapmail Starter 10 Google mailboxes $39/mo, 5 Cloudflare .com domains about $52/yr, Reoon 25K checks about $29 once, DataForSEO (existing account). That's **$86/mo at launch, $136/mo on Instantly Hypergrowth, about $81 once**, the budget in the scope version sent to leadership (2026-10-13). InboxKit ($30/mo) was considered and not chosen, to stay with what was approved. |
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
- [ ] Zapmail Starter: 10 Google mailboxes on our own 5 domains, 2 per domain. Use the real first and last names of the people who will handle replies, so the From line is honest (CAN-SPAM). Zapmail sets up SPF, DKIM and DMARC. Check them on each domain, with DMARC at `p=none` to start. Use the standard plan, not Zapmail's pre-warmed plan, which comes with generic domains.
- [ ] Instantly Growth: connect all 10 mailboxes and turn warm-up on. **That day is the warm-up start date: record it here.**
- [ ] Instantly campaign settings: LumiLink postal address in the footer and the unsubscribe link on (CAN-SPAM).
- [ ] **On purchase, create an Instantly API key** (Settings → Integrations → API) and confirm `GET /api/v2/campaigns` works. Instantly's help center says API access is on all Outbound plans, so Growth includes it ("API V2" article, checked 2026-10-13); webhooks are Hypergrowth-only, which is why replies are polled. If the key can't be created anyway, move to Hypergrowth ($97). The code doesn't change.
- [ ] Reoon: an account and the 25K credit pack (about $29, never expires; the approved line item).
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
3. **`outbound-enrich`**: fetch home, contact and about pages, using the `seo-crawl` fetch code and `render-service` for JavaScript-rendered sites. Extract emails from mailto links, page text and simple obfuscation. Prefer same-domain addresses and skip images and placeholder addresses. 🟡 **Built and locally verified end to end (2026-10-13); not deployed.**
   - **`0302_outbound_enrich.sql`**
     - Adds `claimed_until` and `outbound_claim_leads(stage, limit, lease)`, which hands out leases with `skip locked` so overlapping runs never work the same lead.
     - Adds `outbound_record_email(lead, email, source_url)`, the only place an email is written. Outcomes: found, no_email, suppressed, duplicate (with a `duplicate_email` event naming the other lead, safe under a concurrent race), stage_changed (leaves a lead a person moved on alone) and not_found.
     - `scripts/test_outbound_enrich.sql` passes.
   - **`supabase/functions/outbound-enrich`** (`index.ts` and `lib.ts`)
     - **Per lead:** robots.txt is honoured for every page. It fetches the homepage (rendered once through `render-service` if it's a JavaScript shell), then up to 3 same-site contact, about or location pages. It stops early when an own-domain address turns up.
     - **Address extraction:** mailto links, visible text, HTML entities, `[at]`/`(at)` obfuscation and Cloudflare email protection (both the link and `data-cfemail` forms).
     - **What it rejects:** placeholders, platform addresses (Sentry, Wix), no-reply, image filenames, and addresses inside scripts or styles. A bare " at " in prose is deliberately not read as an address.
     - **Which address wins:** only the business's own domain (including subdomains) or a free mailbox provider qualifies; a third party such as the web designer never does. Inboxes like privacy, careers and admin are skipped. Ranking puts own domain first, then info, hello and similar, then a named person, with mailto links ahead of text.
     - **Logging:** one `enrich` event per lead records the pages read, the reason and any rejected addresses.
     - **Batching:** batch of 1–25, 4 at a time, a 110-second run budget, and unreached leads are released.
     - **Code sharing:** it imports `decodeEntities`, `normalizeUrl`, `visibleWordCount`, `isAllowedByRobots`, `isCrawlable` and `sameSite` from `seo-crawl` rather than copying them.
   - **Tests**
     - `scripts/test-outbound-enrich.ts`: 37 unit tests pass.
     - **Local end-to-end** (`functions serve` plus 4 fixture sites on host ports and 1 dead port):
       - own-domain mailto on the homepage → found from 1 page
       - nothing on the homepage, a Cloudflare-protected gmail on `/contact-us` → found from 3 pages, source page recorded
       - robots `Disallow: /` → `no_email` (robots_disallowed)
       - only the web designer's address → `no_email` (no_usable_address, address listed for review)
       - dead port → `no_email` (fetch_failed)
     - The first run correctly returned `suppressed` for the two found addresses, because a local crawler-test client's site is also on `host.docker.internal`. That client was moved aside for one rerun and restored afterwards.
     - `npm run check` passes.
   - **Not verified:** real business sites, so the hit rate is unknown (§8 item); the `render-service` path (RENDER_SERVICE_URL isn't set locally); and CPU time on very large pages (HTML is capped at 1.5 MB).
4. **`outbound-verify`**: Reoon single-email check. `valid` → `verified`; `invalid` → `invalid` plus a suppression entry; catch-all and unknown are kept, flagged, and sent last. 🟡 **Built and locally verified against a mock Reoon (2026-10-13); no real Reoon call yet.**
   - **`0303_outbound_verify.sql`** adds `outbound_record_verification(lead, verification, suppress, detail)`, the only writer of results.
     - It acts only on leads still at `email_found`.
     - It logs a `verify` event with the vendor detail every time.
     - It checks suppression first: an address suppressed since it was found moves the lead to `suppressed` and the result isn't applied.
     - `suppress = true` adds the address to `outbound_suppressions` (reason `invalid`, source `reoon`, with the status as a note).
     - `scripts/test_outbound_verify.sql` passes.
   - **`supabase/functions/outbound-verify`** (`index.ts` and `lib.ts`)
     - **Checks:** Reoon power mode (`GET /api/v1/verify?mode=power`), 3 in parallel (Reoon asks for 5 or fewer), with a 75-second timeout per check and a 100-second run budget. Batch size is 1–20. Leads are claimed through `outbound_claim_leads('email_found', …)`.
     - **Mapping (`mapReoon`):**
       - `safe` → valid
       - `role_account` → valid when Reoon says it's deliverable or safe to send (info@ is the inbox we want); catch_all if the domain is catch-all; otherwise unknown
       - `catch_all` and `unknown` → kept at `verified` and flagged
       - `inbox_full` → invalid, not suppressed
       - `invalid`, `disabled` and `spamtrap` → invalid and suppressed
       - `disposable` → disposable and suppressed
       - an unexpected status is an error, never a guess
     - **Errors:** a Reoon error releases the lead. An account error (credits, key, quota) stops the run and releases everything not yet checked.
     - **Testing hook:** `REOON_API_BASE` exists only for tests.
   - **Tests**
     - `scripts/test-outbound-verify.ts`: 23 unit tests pass.
     - **Local end-to-end** (`functions serve` plus a mock Reoon on a host port):
       - one lead per status (8) → all 8 land on the right stage and verification
       - only invalid, spamtrap and disposable are suppressed
       - an out-of-credits answer on the oldest of 6 leads → the run stops; 2 checks already in flight finish; 4 are released with none left leased
       - a wrong secret → 401
     - `npm run check` passes (54 of 54).
   - **Not verified:** a real Reoon response. The field names come from Reoon's API docs. Also unchecked: the exact error body Reoon sends when out of credits (the mapping matches on words like credit, key and quota), and real power-mode latency.
5. Cron: source daily, enrich and verify every 15 minutes in batches. Migration `0301`. 🟡 **Built as `0304_outbound_schedule.sql` and Docker-verified (2026-10-13); not on production.**
   - **`request_outbound_job('source' | 'enrich' | 'verify')`** first checks for work: an active profile for source, unclaimed `sourced` leads for enrich, unclaimed `email_found` leads for verify. Only then does it read `outbound_<job>_url` plus `voice_tool_secret` from Vault and send a pg_net POST with a 150-second timeout.
   - **Safe before Phase 0 is done.** With no work it calls nothing; with a missing secret it raises a notice and makes no call. With no active profile, nothing is ever bought, so **making a profile active is the on switch**.
   - **Schedule:**
     - `outbound-source-daily` at `0 14 * * *`
     - `outbound-enrich-due` at `*/10 * * * *`
     - `outbound-verify-due` at `5-59/10 * * * *`

     That's every 10 minutes rather than 15, which is enough for 1,440 leads a day per step.
   - **Tests:** `scripts/test_outbound_schedule.sql` passes, and removing the no-work early exit makes it fail. The migration was applied twice locally. There's no pg_cron locally, so the schedule block was skipped with its notice.
   - **Deliberately not done:** adding the three secrets and cron jobs to `system_health_snapshot()` (0068). That function belongs to main, so it gets a main migration after the merge.

### Phase 2: Instantly sync (about 4–8 hrs)
1. **`outbound-instantly` push**: verified, unsuppressed leads go into the profile's campaign, up to the daily target. Store the Instantly lead id; stage becomes `queued`.
2. **Reply polling** every 10 minutes: replies and unsubscribes. Unsubscribe or bounce adds a suppression entry. A reply moves the lead to `replied` with a snippet.
3. **Cleanup**: once a lead's sequence has finished, save its final state and delete it from Instantly. Alert when the contact count passes 800 of 1,000.
4. Cron: migration `0302`.

🟡 **Built as `0306_outbound_instantly.sql` and `outbound-instantly`, verified locally against a mock Instantly (2026-10-13). No real Instantly account yet.**
- **`0306`** adds:
  - `outbound_claim_pushable(profile, limit)`: verified, unsuppressed leads not yet in Instantly, valid before catch-all/unknown, oldest first, leased.
  - `outbound_pushed_today(profile)`, `outbound_in_instantly()` and `outbound_suppress_lead(lead, reason, source, note)`. The last one suppresses the address but leaves won/lost/booked/called outcomes alone.
  - An `'instantly'` branch in `request_outbound_job`, and the cron job `outbound-instantly-due` at `2-59/15 * * * *`. It's dispatched only when an active profile has a campaign or leads are held in Instantly.
  - `scripts/test_outbound_instantly.sql` passes.
- **`supabase/functions/outbound-instantly`** (`index.ts` and `lib.ts`): the actions are `sync`, `cleanup` and `push`, and `all` (the default) runs them in that order.
  - **Push:** `POST /api/v2/leads/add` with `skip_if_in_workspace`, sending only documented fields (city, state, category and our lead id go in `custom_variables`). The amount is what's left of `daily_lead_target` today, never past `INSTANTLY_CONTACT_CAP` (default 1,000) minus 50. Leads Instantly didn't create are looked up in the campaign by email: if found they're recorded as queued (a crash-recovery case); otherwise they're suppressed with a note.
  - **Sync:** `POST /api/v2/leads/list` by id, 100 per page.
    - Unsubscribed or bounced → suppressed.
    - A reply → `replied`, and the reply text is fetched from `GET /api/v2/emails` (at most 10 per run, because that endpoint allows 20 a minute), trimmed of quoted history and signatures.
    - Instantly interest → positive / negative / booked / won / lost.
    - A completed sequence with no reply → `finished`.
    - Stages only move forward, so a person's update is never undone. A lead deleted in Instantly by hand is marked removed.
  - **Cleanup:** `DELETE /api/v2/leads/{id}` for finished, suppressed, negative, lost and won leads, and for conversations quiet for 30 days or more. At most 50 per run; a 404 counts as already gone.
  - **Errors:** a 401 or 402 stops the run and releases claimed leads. A warning is logged at 80% of the contact cap.
  - **Testing hook:** `INSTANTLY_API_BASE` exists only for tests.
- **Tests**
  - `scripts/test-outbound-instantly.ts`: 38 unit tests pass.
  - **Local end-to-end** (`functions serve` plus a stateful mock Instantly):
    - **Push:** 7 claimed → 5 created, 1 recovered (already in the campaign), 1 blocklisted → suppressed.
    - **Activity:** after simulated activity, the full run's sync gave replied 1, positive 1, unsubscribed 1, bounced 1, finished 1, unchanged 1, with 2 reply texts fetched and trimmed.
    - **Cleanup:** removed the 3 done leads from the mock; the two live conversations stayed.
    - **Push again:** `nothing_verified`, so nothing was pushed twice.
    - **Wrong API key:** the run stopped at the first call with `stopped` set, and the pending lead was left verified and unclaimed.
  - `npm run check` passes (56 of 56).
- **Not verified:** a real Instantly account, including creating the API key on Growth (Instantly's help center says it's included), real response shapes, real rate limits on `/leads/list` and `DELETE`, whether deleting really frees uploaded-contacts space (Instantly's help center says so), and reply text from real mail clients.

### Phase 3: portal UI (about 9–14 hrs; waits on the staff access model)
1. Access policies plus the route group and sidebar entry, following whatever the loyalty staff concept becomes.
2. **Profiles**: list, create and edit (audience builder, product, offer, campaign link), pause and resume.
3. **Reply inbox**: replies, mark positive or negative, a "call now" task with phone and website, and outcome tracking (`called` / `booked` / `won` / `lost`).
4. **Funnel**: counts per stage per profile, plus signups attributed through `/onboarding/add`.

### Phase 4: pre-call SEO snapshot (about 4–5 hrs)
- Run the existing crawl, technical audit and rank and competitor checks against a **prospect** domain, with no client or location rows, and render a one-page summary for the call. Needs `seo-crawl` / `seo-technical-audit` refactored to accept a bare URL. SEO profiles only in v1.
- 🟡 **Built and locally verified end to end against a mock DataForSEO (2026-10-13); no real DataForSEO call yet.** No refactor of the SEO modules was needed. Their pure helpers are imported as they are:
  - from `seo-crawl/lib.ts`: `auditPage` and `isAllowedByRobots`
  - from `seo-technical-audit/lib.ts`: `analyzeRedirectChain`, `analyzeRobotsTxt` and `analyzeSitemap`
  - from `seo-rank-tracking/lib.ts`: `findOwnRanking`
- **`0305_outbound_snapshots.sql`** adds `outbound_snapshots`: lead, status `ready`/`partial`/`failed`, keyword, `data` (the raw checks), `todo` (ordered list), `summary`, `cost` and `error`. History is kept per lead and deleted with the lead. Service-role only. `scripts/test_outbound_snapshots.sql` passes.
- **`supabase/functions/outbound-snapshot`** (`index.ts` and `lib.ts`): `{lead_id, keyword?, force?}`. It builds three parts in parallel, and any of them may fail without stopping the others:
  1. **Website, no spend.** Robots.txt, the homepage redirect chain, the sitemap (declared in robots.txt or at /sitemap.xml), https, the mobile viewport tag, and `auditPage` (title, description, H1, LocalBusiness markup, phone on page, thin content, image alt text).
  2. **Competitors.** One business-listings call in the lead's primary category within 15 km. It excludes the prospect by cid, domain or name, and drops permanently closed listings. It keeps the top 5 by reviews and computes the median reviews, average rating and the prospect's rank by reviews.
  3. **Ranking.** One live Google SERP for "<category> <city>" (or the `keyword` override) from the lead's coordinates: mobile, depth 20. It records map-pack and organic positions plus the map-pack leaders.
- **Output:** `buildTodo` turns the results into plain-language items ordered critical → warning → info. `summaryLines` gives the caller three lines.
- **Spend control:** a snapshot under 7 days old is returned instead of rebuilding, unless `force` is set. It's on demand only, with nothing scheduled. Each run logs a `snapshot` event.
- **Coordinate units differ between the two APIs.** The SERP `location_coordinate` radius is in **millimetres** (DataForSEO docs: minimum 199), while business listings uses kilometres. `SERP_RADIUS_MM = 1000`.
- **Tests**
  - `scripts/test-outbound-snapshot.ts`: 32 unit tests pass.
  - **Local end-to-end** (`functions serve`, a fixture prospect site and a mock DataForSEO that logs requests):
    - Status `ready`, cost 0.0182 (the mock's figure), 10 to-do items with the map-pack miss and the reviews gap (40 against a median of 120) first. Six website items were in plain language. The phone number on the page was correctly not flagged.
    - The mock received the listings call with a `…,15` km radius and the SERP call with `…,1000` mm, depth 20, mobile.
    - A second call reused the snapshot. `force` with a keyword override rebuilt it with the lower-cased keyword.
    - A lead with no coordinates or category came back `partial` at $0, with the error naming both missing parts.
    - A missing `lead_id` returned 400; an unknown lead returned 404.
  - `npm run check` passes (55 of 55).
- **Not verified:**
  - Real DataForSEO SERP and listings responses, so field names come from the docs.
  - The real cost of a live depth-20 SERP (DataForSEO's docs don't list a base price).
  - PageSpeed: not included, because it needs a key and slows the snapshot down.
  - **Display:** the snapshot is JSON in the database until Phase 3 shows it in the portal.

### Phase 5: live testing (6–10 hrs)
- See §8 below.

## §8 Setup and live-test items

Hand-test at the end. Add items as each phase is built.

- [ ] Deploy `outbound-source` with `--no-verify-jwt`.
- [ ] Run one forced, real call on a test profile with `daily_lead_target` 25 (100 listings, about $0.05).
  - Check that the parser's fields fill in: city, region, website, rating, review count.
  - Check whether the rating filters are accepted.
  - Look up the right category ids for dispensaries and HVAC (DataForSEO `business_listings/categories`).
- [ ] Deploy `outbound-enrich` with `--no-verify-jwt`.
  - Set `RENDER_SERVICE_URL` and `RENDER_SERVICE_SECRET` for it; they're the same values seo-crawl uses.
  - Run it on the leads from the real sourcing call. Record the hit rate, and hand-check 10 `no_email` events for missed addresses.
- [ ] Deploy `outbound-verify` with `--no-verify-jwt` and set `REOON_API_KEY` (not `REOON_API_BASE`). Then:
  - Verify 3 known addresses: one real, one made up on a real domain, one on a catch-all domain. Compare the results with Reoon's dashboard.
  - Check what an empty-credits answer looks like, against the `fatal` matching in `lib.ts`.
- [ ] After 0304 reaches production:
  - Create the Vault secrets `outbound_source_url`, `outbound_enrich_url` and `outbound_verify_url` (commands in 0304's header).
  - Confirm `select jobname, schedule from cron.job where jobname like 'outbound-%'` lists 3 jobs.
  - After the first active profile, confirm `cron.job_run_details` shows them succeeding.
- [ ] After merging to main, add the outbound secrets and cron jobs to `system_health_snapshot()` in a main migration.
- [ ] Deploy `outbound-snapshot` with `--no-verify-jwt` (not `DATAFORSEO_BASE`), then run it on one real lead from the sourcing test. Check:
  - That the competitor list and map-pack names look right next to a real Google search.
  - The real cost per snapshot, from `outbound_snapshots.cost`.
  - That the to-do wording reads well to someone outside the business.
- [ ] Deploy `outbound-instantly` with `--no-verify-jwt`; set `INSTANTLY_API_KEY` (and `INSTANTLY_CONTACT_CAP` if on Hypergrowth: 25000), and create the Vault secret `outbound_instantly_url`. Then, using a test campaign that only sends to our own inboxes:
  - Push 2 leads and confirm the Instantly ids are saved.
  - Reply from one inbox and unsubscribe from the other.
  - Run sync and confirm `replied` with a snippet, plus a suppression.
  - Run cleanup and confirm Instantly's uploaded-contacts count goes down.
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
