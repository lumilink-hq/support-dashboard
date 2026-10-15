# AI Concierge build plan

A talking avatar on a client's website, sold as a LumiLink add-on. It runs the
existing ElevenLabs agent (voice, languages, knowledge base, product lookup)
behind a licensed real-time avatar face. PACKS's virtual budtender is the first
client.

**Status: NOT APPROVED (2026-10-15).** This plan exists so the build can start
the day leadership says yes. Nothing here is built yet. The scope is
`docs/LumiLink-AI-Concierge-Scope.docx` (Draft 2), and the research behind it is in
`docs/ai-concierge-findings.md`. Record decisions and findings there; this file
holds the build steps.

| | |
|---|---|
| **Branch** | `concierge`, cut from `main` on approval |
| **Migrations** | **0400 and up**, reserved for this work. Main is at 0091 and growing; loyalty uses 200+, outbound 300+. Merging out of order means `supabase db push --include-all`. |
| **Effort** | 38-54 h for the LL add-on, plus 8-14 h for the PACKS launch. Ceiling 82-118 + 16-24. Phase 1 below may add 3-5 h; see the note there. |
| **Running cost** | $0.18-0.31 per conversation minute, plus ~$99/mo for the avatar vendor plan. Custom-avatar fee unknown. |
| **Critical path** | Custom-avatar delivery from the vendor. Build on a stock avatar while it's being made. |

## Decisions

- **Face only, our brain.** The avatar vendor only renders and lip-syncs. Speech-to-text,
  LLM, voice, tools, guardrails and logging stay in our ElevenLabs agent and
  Supabase. A vendor's full-stack mode would mean rebuilding all of that inside
  them and getting locked in.
- **Vendor is swappable.** Everything vendor-specific sits behind one adapter
  (`lib/concierge/avatar/<vendor>.ts` plus one edge-function module). The rest of
  the code never names a vendor.
- **Private agent, short-lived tokens.** The browser never sees a usable agent ID
  or vendor key. Every session starts with a server-minted ElevenLabs
  conversation token and avatar session token, after checking origin, cap and
  rate limit. See `docs/shopify-gated-widget-plan.md` §0 for why.
- **Fail closed on cost, open on nothing else.** Phone calls fail open on the
  allowance check (`LIMITER-WIRING.md`), because a caller hearing a hang-up is worse than
  a few cents of overage. A public web page is different: anyone can open it in a loop.
  Concierge sessions **fail closed**. If the allowance check errors, show the text
  fallback and no avatar.
- **Every function deploys with `--no-verify-jwt`** and authenticates with the
  shared-secret header, like every other function.
- **Website only.** The PACKS mobile app belongs to Digital Awesome and is out of scope.

## Data model (0400)

| Table | Holds | Key points |
|---|---|---|
| `concierge_configs` | One per client | `enabled` (kill switch, separate from `is_active` so killing the avatar doesn't kill the phone line), `vendor`, `avatar_id`, `voice_id`, `persona` text, `compliance_profile` (`null` / `cannabis_retail` / `ruo_research`), `age_gate` bool, `allowed_origins` text[], `monthly_minute_cap`, `per_session_max_secs` (default 600), `languages` text[]. Tenant-write via an RPC with the `current_user_can_act()` guard. |
| `concierge_sessions` | One per avatar session | `client_id`, `started_at`, `ended_at`, `billed_secs`, ElevenLabs `conversation_id`, vendor session id, `origin`, `language`, `ended_reason` (`user` / `cap` / `timeout` / `error`), hashed IP for the rate limit. Service-role write; tenant read through RLS. |

RPCs: `check_concierge_allowance(client_id)` returns minutes left this month and
whether a session may start. `record_concierge_usage(session_id, secs)`.
Copy the shape of `check_voice_allowance` / `record_call_usage`.

> Read `[[feedback-rpc-key-drop]]` before touching `get_client_config`. If the
> concierge needs keys there, copy the existing object verbatim and append.

## Phases

### Phase 0: vendor and accounts (no code; ~6-8 h, brief row 1)
- [ ] LiveAvatar Essential trial and D-ID trial. Same test script on both: latency to first word,
      lip sync on ElevenLabs audio, Spanish and one other language, mobile Safari, and a 10-min session.
- [ ] D-ID: confirm it works with a **private** ElevenLabs agent and our chosen voice
      (forum reports said cloned voices failed; see findings §3).
- [ ] Quotes from both: custom-avatar creation fee, turnaround, streaming rate at
      1k / 10k min/month, concurrency per plan.
- [ ] Pick a vendor. Record the choice and the reasons in findings §9.
- [ ] Create a **private** ElevenLabs agent for the concierge (not the phone agent).
      Hostname allowlist on.
- [ ] Order the custom avatar for PACKS as soon as PACKS picks the look. This starts the critical path.
- [ ] Secrets: `AVATAR_VENDOR_API_KEY`, `ELEVENLABS_API_KEY` (check whether it's already set,
      since `provision-feature` uses it), `CONCIERGE_ORIGIN_SECRET` if needed.

### Phase 1: browser-session prerequisites (~3-5 h, NOT in the brief's hours)
`docs/BUILD-PLAN-2026-08.md` §H lists what blocks any browser-only agent. The
concierge inherits it. Two of those items are real work:
- [ ] **Agent forwards `client_slug` into every tool call** (§H.1). Agent config only,
      but the tools 400 without it.
- [ ] **Browser sessions are metered** (§H.2). Nothing meters a web session today, which is
      why Website Chat is `available: false` in `lib/addons.ts`. The 0400 RPCs above are the fix.
      Build them here, and Website Chat can reuse them.
- [ ] **Per-slug rate limit**: max sessions per IP hash per hour and per client per hour.
- [ ] Decide what the web path may **do** (§H.5). The concierge gets read-only tools:
      KB, product lookup and recommend. No booking, no order lookup at launch.

> The brief's Dashboard row (4-5 h) assumed caps were a settings field. The
> metering itself is this phase. If the brief is revised, add 3-5 h here.

### Phase 2: session service (~3-4 h; with Phase 3, brief rows 2-3)
1. **`0400_concierge.sql`**: tables, RLS, the two RPCs, and SQL isolation tests
   (`scripts/test_concierge_isolation.sql`).
2. **`concierge-session` edge function**: `POST { client_slug }` with an `Origin` header.
   - Resolve the client by slug. Reject unless `enabled` and the origin is in `allowed_origins`.
   - Rate limit, then `check_concierge_allowance`. Fail closed.
   - Mint an ElevenLabs conversation token for the private agent, with
     `client_slug`, persona and language passed as dynamic variables.
   - Mint the avatar vendor session through the adapter.
   - Insert a `concierge_sessions` row. Return `{ session_id, el_token, avatar_session }`.
   - Pure helpers in `lib.ts` with `scripts/test-concierge-session.ts`.
3. **`concierge-end`**: called on hang-up and by the post-call webhook. Records `billed_secs`
   and closes the vendor session. ElevenLabs' post-call webhook (`voice-call-logger`) already
   handles the slug route; make sure it tags concierge conversations so they don't count as
   phone minutes.

### Phase 3: embed and avatar player (~6-9 h; with Phase 2, brief rows 2-3)
1. **`public/concierge.js`**: a one-line loader a client pastes on their site
   (`<script src=".../concierge.js" data-client="packs" async>`). It mounts a launcher
   button and lazy-loads the player only on click, so it costs nothing until used.
2. **Player**: calls `concierge-session`, starts the avatar stream, and connects
   ElevenLabs audio to the avatar through the vendor adapter (D-ID's native path or
   LiveAvatar LITE's audio input).
3. **Before the avatar talks**: age gate when `age_gate` is set (21+), then a one-line
   recording and privacy notice, then mic permission. If mic is denied, fall back to text.
4. **Text fallback**: same agent in ElevenLabs chat mode, avatar muted or hidden.
   It's also used when the allowance check fails or the vendor is down.
5. **Mobile**: test on real iOS Safari and Android Chrome: autoplay rules, mic prompt,
   backgrounding the tab, and a 4G connection. **The biggest overrun risk is here.**
6. A React wrapper for our own pages (`components/concierge-widget.tsx`) that loads the same script.

### Phase 4: persona, guardrails, knowledge (~12-18 h, brief rows 4-6)
1. Persona block built from `concierge_configs.persona`, plus a base prompt shared by all clients.
2. **`cannabis_retail` compliance profile**, modelled on `restricted-vertical-compliance.md`:
   - No medical, therapeutic or effect claims ("helps with sleep", "good for anxiety"),
     including any framed as research. Describe products by type, strain, terpenes, potency
     and the store's own wording only.
   - No dosing advice. No advice on mixing with medication. Point those questions to a
     doctor or the in-store budtender.
   - No sales or delivery across state lines. Confirm purchase limits come from store policy.
   - Every recommendation comes from `recommend_product` results. Never from general knowledge.
3. **Red-team set** `scripts/concierge-redteam.json` + runner: ~40 prompts across
   medical claims, minors, dosing, jailbreaks, competitor bashing and other languages. Run it
   before every prompt change; it gates launch.
4. **`recommend_product` tool**: extends `voice-product-lookup` with filters (category,
   effect-free attributes like strain type, potency range, price, in stock). It reads
   `products_cache` per store.
5. Language: ElevenLabs auto-detect on; test the top 5 languages with the red-team subset.

### Phase 5: dashboard and billing (~5-7 h, brief rows 7-8)
1. `/concierge` page under the Phone Agent product in `lib/catalog.ts`: enable/kill switch,
   persona, avatar, allowed origins, minute cap, minutes used this month, and the embed snippet.
2. Concierge sessions appear in `/conversations` with a filter and transcripts.
3. Add-on in `lib/addons.ts`: `available: false` until the price is set and Phase 1 ships.
   `manualFulfilment: true` at launch, because the custom avatar is ordered by hand.
4. Stripe price via env (`STRIPE_PRICE_CONCIERGE`). Per-minute overage TBD with leadership.

### Phase 6: QA and launch (~6-8 h, brief row 9)
- [ ] Concurrency: open sessions up to the vendor plan's limit; check that the next one gets the text fallback.
- [ ] Cap: set a 2-minute cap on a test client; check the session ends gracefully.
- [ ] Kill switch: turn it off mid-session; check new sessions are refused.
- [ ] Red-team set passes 100% on the launch prompt.
- [ ] `npm run check`, `npm run test:sql`, functions deployed `--no-verify-jwt`,
      `supabase functions list` shows `verify_jwt` false.

### Phase 7: PACKS launch (~8-14 h, brief comparison table)
- [ ] PACKS picks the avatar look, name and personality. Order the custom avatar (Phase 0).
- [ ] **Menu data source**: what replaces AIQ Dispense, and does it have an API with per-store
      inventory? If it's Shopify, `shopify-product-sync` covers it. If not, a new sync
      adapter is needed, and this phase grows.
- [ ] Per-store context: work out which store the shopper is browsing (URL path or a
      store picker) and pass it as a dynamic variable.
- [ ] Knowledge base: ingest PACKS store pages, FAQ, policies.
- [ ] `compliance_profile = 'cannabis_retail'`, `age_gate = true`.
- [ ] **Counsel signs off on the guardrail script** before going public.
- [ ] Soft launch on one store page, with a low minute cap; review transcripts daily for the first week.

## Setup and live-test items (for the end-of-build hand test)

| Item | Where | Done |
|---|---|---|
| Private concierge agent created, hostname allowlist set | ElevenLabs | |
| Agent tools forward `client_slug` | ElevenLabs agent config | |
| Avatar vendor account, plan and API key | Vendor + `supabase secrets set` | |
| Custom avatar delivered and `avatar_id` saved | `concierge_configs` | |
| `0400` pushed | `supabase db push` | |
| `concierge-session`, `concierge-end` deployed with `--no-verify-jwt` | Supabase | |
| Stripe price created, env set on Railway | Stripe + Railway | |
| Live test: desktop Chrome, iOS Safari, Android Chrome | PACKS staging page | |
| Live test: Spanish conversation end to end | PACKS staging page | |
| Live test: red-team subset against prod agent | Runner | |
| Counsel sign-off recorded | findings §8 | |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Mobile Safari audio/video quirks | Hours overrun on Phase 3 | Test on real devices in week 1 with the stock avatar |
| The avatar makes a medical claim | Regulatory exposure for PACKS | Compliance profile, red-team gate, counsel review, transcript review |
| A public page runs up minutes | Cost runaway | Fail-closed allowance, per-IP rate limit, per-session max, monthly cap |
| Vendor outage or price change | Avatar down | Text fallback, and an adapter so we can swap vendors |
| Custom avatar delivery slips | Launch date slips | Launch on a stock avatar and swap it in later |
