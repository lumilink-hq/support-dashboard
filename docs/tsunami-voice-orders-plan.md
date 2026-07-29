# Tsunami Voice Agent — Orders & Customer Service (Demo → Pilot)

**Written 2026-07-29.** Goal: a phone bot that answers Tsunami's order/CS calls on a real
number, demoable ASAP, with per-client spend metered and hard-capped so a runaway can't
drain the ElevenLabs minute pool.

Decisions locked at kickoff:

| Question | Answer |
|---|---|
| Demo surface | Real Twilio number imported into ElevenLabs |
| Order data | Tsunami's **live** Shopify store, read-only |
| Behavior at cap | Polite deflect ("line's unavailable, email us") + `end_call` |
| v1 scope | Order status/tracking **+ store policies** (returns window, shipping times) |
| Added mid-plan | Per-client spend metering + hard cap (§4); ticket system with callbacks (§5) |

---

## 1. What already exists vs. what's actually missing

The voice stack is ~80% built. It was built for **Bud Club / WooCommerce**, and Tsunami is
**Shopify** — that mismatch is the real work.

**Reuse as-is (no changes):**

- `0006_voice_integration.sql` — `resolve_client_by_number`, `ingest_call`, `log_call_turn`.
  Routes by dialed number, idempotent, service-role locked.
- `voice-call-logger` — post-call webhook: HMAC verify, transcript → `log_call_turn`,
  escalation → `apply_flag` → review queue. Already handles the `caller_request` path.
- `evaluate_flag` / `apply_flag` / `get_client_config` / `get_client_integration_secrets`
  — shared with the email agent, so voice and email flag identically.
- The Tsunami `clients` row exists (`seed_clients.sql`, slug `shopify-store`), including the
  Shopify-aware `abnormal_statuses` array and `order_number_scheme: 'name'`.
- Dashboard conversations view — voice calls surface there with no frontend work.
- `0010_client_phone_unique.sql` — the duplicate-phone footgun that broke scheduling is
  already fixed, so the new Tsunami number is safe to add.

**Genuinely missing — this is the build list:**

1. **`voice-order-lookup` has no Shopify branch.** It hardcodes
   `GET {base}/wp-json/wc/v3/orders/{id}` with Woo basic auth. Tsunami needs the Shopify
   Admin GraphQL path. *This is the critical path item.*
2. **No policy answers.** The agent can read order fields but knows nothing about returns
   windows or shipping times. Needs a policy blob on the client row + prompt.
3. **No spend metering or cap anywhere.** Nothing records call minutes, nothing stops a
   client (or a loop) from eating the whole plan. Addressed in §4 — treat as P0, not polish.
4. **Order-mode prompt.** `voice-personalization/lib.ts` builds a *scheduling* (HVAC)
   prompt only — `buildSystemPrompt` reads `settings.scheduling` and a priced service menu.
   There is no orders variant.
5. **Caller identity check.** Order number alone over the phone is weak; anyone who reads a
   number off a packing slip gets the customer's name and address read back.
6. **No structured callback capture.** Escalation today is `apply_flag('caller_request')`
   *after* the call, which creates a review item with no callback number attached — the
   number only exists as spoken words inside the transcript. Nobody can work that queue.
   Covered in §5.

---

## 2. Architecture (deliberately boring — reuses the phone path that already works)

```
Caller ──▶ Twilio number ──▶ ElevenLabs agent "Lumi — Orders"
                                  │
      (1) pre-call ───────────────┤  voice-personalization
          conversation-init       │  → resolve tenant by called_number
          webhook                 │  → CHECK VOICE ALLOWANCE  ◀── cap gate
                                  │  → return prompt + greeting + vars
                                  │
      (2) mid-call ───────────────┤  voice-order-lookup
          server tool             │  → Shopify Admin GraphQL (order by name)
          "lookup_order"          │  → normalize → orders_cache → evaluate_flag
                                  │  → ingest_call
                                  │
      (3) escalate ───────────────┤  transfer_to_number | request_callback | end_call
                                  │  → voice-ticket: creates ticket + callback
                                  │
      (4) post-call ──────────────┘  voice-call-logger
          webhook                    → transcript turns → apply_flag
                                     → RECORD USAGE  ◀── meter
```

**Agent decision: run a second, dedicated ElevenLabs agent for orders.** Don't try to make
one agent do both scheduling and orders. Reasons: the prompts have almost nothing in
common, tool sets differ (`lookup_order` vs the three scheduling tools), and a second agent
costs nothing extra — you're billed per minute, not per agent. Multi-tenancy within the
orders agent still works the same way (one orders agent serves every ecommerce client,
routed by dialed number).

---

## 3. The Shopify lookup — the one piece of real code

> ✅ **BUILT 2026-07-29.** `voice-order-lookup/lib.ts` (new, pure helpers),
> `voice-order-lookup/index.ts` (platform branch), `scripts/test-voice-lookup-shopify.ts`
> (94 unit tests, all passing via `npx tsx`). Not yet deployed — see §9.

Adds a `store_platform` branch to `voice-order-lookup/index.ts`. Everything downstream
(normalize → `orders_cache` → `evaluate_flag` → response shape) stays byte-identical, so
the agent prompt and the dashboard don't care which platform answered.

**Query** — Admin GraphQL, API version `2026-07`:

```graphql
query($q: String!) {
  orders(first: 1, query: $q) {
    edges { node {
      name
      createdAt
      displayFinancialStatus
      displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      customer { firstName lastName }
      email
      shippingAddress { zip city province }
      lineItems(first: 20) { edges { node { name quantity } } }
      fulfillments(first: 5) {
        trackingInfo { number company url }
        estimatedDeliveryAt
        displayStatus
        createdAt
      }
    }}
  }
}
```

- `POST https://tsunami-store-7957.myshopify.com/admin/api/2026-07/graphql.json`
- Header `X-Shopify-Access-Token: <token>`; variable `q = "name:1001"` (strip a leading `#`
  and any whitespace before sending — callers say "ten oh one" and the LLM will hand you
  anything).
- Empty `edges` → the existing `order_not_found` path. Non-200 → the existing
  `lookup_error` + escalate path. **Never fabricate** — that rule is already in the code.

**Status normalization.** `evaluate_flag` takes one status string, and Tsunami's
`abnormal_statuses` array (`ON_HOLD, RESTOCKED, REFUNDED, VOIDED, PARTIALLY_REFUNDED`)
deliberately spans both Shopify enums. Apply the same rule the email Zap uses:

```ts
const status =
  ["REFUNDED", "VOIDED", "PARTIALLY_REFUNDED"].includes(o.displayFinancialStatus)
    ? o.displayFinancialStatus
    : o.displayFulfillmentStatus;
```

Port this from the working Zap rather than reinventing it — the email agent's Shopify
branch is the reference implementation and it's already correct in production.

**No ShipStation.** Shopify carries tracking natively on `fulfillments.trackingInfo`. Skip
the ShipStation call entirely for Shopify clients: one less API, one less secret, ~200ms
less latency on a live call.

**Credentials.** Create a custom app in the Tsunami Shopify admin with `read_orders` +
`read_fulfillments` (read-only — the bot must never be able to write). Store as a Vault
secret and point `clients.store_credentials_ref` at it:

```sql
select vault.create_secret(
  '{"access_token":"shpat_…","base_url":"https://tsunami-store-7957.myshopify.com"}',
  'shopify-store_shopify');
update clients set store_credentials_ref = 'shopify-store_shopify'
where slug = 'shopify-store';
```

> ⚠️ **60-day gotcha.** `read_orders` only returns orders from the last 60 days. Anything
> older needs `read_all_orders`, which requires Shopify approval and is not instant. **Demo
> with recent orders**, and request `read_all_orders` now if the pilot needs history.

> ⚠️ **Secrets-key gotcha (found during the build).** `get_client_integration_secrets`
> (migration `0002`) predates Shopify support: it reads the generic
> `clients.store_credentials_ref` but returns it under the JSON key **`"woocommerce"`**
> whatever the platform. So a Shopify token arrives at `secrets.woocommerce`, *not*
> `secrets.shopify`. `pickShopifyCreds()` accepts `shopify` → `store` → `woocommerce` in
> that order, so the Shopify path works against the current database **with no migration**
> and keeps working if the RPC is ever renamed. Don't "fix" this by only reading
> `secrets.shopify` — that silently yields no credentials.

**Also added while in there:** a `verify_hint` field on the response (`name_on_order` /
`email_on_order`) so the agent knows *what* to ask the caller to confirm before reading
personal details back — the value to confirm is deliberately never sent over the wire.
That's Phase 4's verification step made possible for free.

---

## 4. Cost model and the limiter (P0)

### 4a. What a call actually costs

| Component | Rate | Per 3-min call |
|---|---|---|
| ElevenLabs agent minutes | ~$0.08/min (Pro: $99 → 1,238 min) | $0.24 |
| Twilio inbound local | ~$0.0085/min + $1.15/mo/number | $0.026 |
| LLM (Gemini Flash, paid tier) | pass-through at cost | ~$0.01–0.02 |
| Supabase edge fns + Postgres | negligible | <$0.001 |
| Shopify Admin API | free | $0 |
| **All-in** | **≈ $0.09–0.10/min** | **≈ $0.28–0.31** |

Sanity check at pilot volume: **300 calls/mo × 3 min = 900 min ≈ $85/mo** in variable cost,
sitting inside a single $99 Pro plan.

**The number that matters is average call duration, not call count.** A WISMO call should
be 90–150 seconds. If it drifts to 5 minutes your unit cost doubles, so treat duration as
the KPI you watch on the dashboard.

**Two ElevenLabs billing facts to verify on your actual plan before the demo:** silence
longer than 10s is discounted 95% (so dead air is nearly free), and over-plan minutes
either fail or bill as "burst" at roughly double rate depending on your settings. Confirm
which mode your workspace is in — it decides whether overage means *broken* or *expensive*.

### 4b. Why a per-client cap is non-negotiable

The minute pool is **shared across every client on the workspace**. One client's runaway
loop — or one prank caller sitting on the line — burns minutes that your *demo* needs.
Rule of thumb: **the sum of per-client caps should be ≤ 80% of the plan's minutes**, leaving
~20% as reserve for demos and support calls. On Pro that's 1,238 min → allocate ≤ 990.

### 4c. Design: `0012_voice_usage_caps.sql` — ✅ BUILT 2026-07-29

> Written and verified against a real Postgres 16 with `0001/0002/0005/0006` applied:
> `supabase/migrations/0012_voice_usage_caps.sql` + `scripts/test_voice_usage_caps.sql`
> (both suites pass; the migration is re-runnable). Not yet deployed.
>
> **Security finding worth knowing about.** `0001` sets *default privileges* granting
> `authenticated` select/insert/update/delete on every future table **and view** in the
> schema. A plain Postgres view executes with its **owner's** rights, so
> `voice_usage_current` would have handed every tenant every other tenant's usage —
> silently, with RLS enabled and looking correct. It's now
> `create view … with (security_invoker = true)`, the cross-tenant
> `voice_cap_allocation` view is explicitly revoked from `authenticated`, and write
> privileges on the meter are revoked rather than merely unpolicied. The isolation test
> was checked against a deliberately-reverted view to confirm it fails loudly: it sees 4
> tenants' rows instead of 1. **Any future view in this schema needs the same treatment.**
>
> Two deltas from the sketch below: caps also fall back to platform-level defaults (a new
> `platform_settings` singleton, which also carries the global kill switch), and
> `assignee`-style helper functions `client_voice_caps()` / `client_timezone()` are
> `SECURITY INVOKER` so the dashboard can call them without leaking across tenants.

```sql
-- one row per completed call; idempotent on (client_id, call_sid)
create table voice_usage_events (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  call_sid      text not null,
  started_at    timestamptz not null default now(),
  duration_secs int  not null default 0,
  est_cost_usd  numeric(10,4) not null default 0,
  source        text not null default 'post_call',
  created_at    timestamptz not null default now()
);
create unique index uq_voice_usage_call on voice_usage_events (client_id, call_sid);
create index idx_voice_usage_period on voice_usage_events (client_id, started_at desc);
```

Caps live in `clients.settings.voice_caps`, so onboarding stays config-only:

```json
{ "voice_caps": {
    "monthly_minutes": 200,
    "monthly_cost_usd": 25,
    "daily_minutes": 30,
    "max_call_secs": 300,
    "enabled": true } }
```

Two service-role RPCs:

- **`check_voice_allowance(p_client_id)`** → `{ allowed, reason, minutes_used,
  minutes_cap, pct_used, cost_used }`. `reason` ∈ `ok | over_monthly_minutes |
  over_monthly_cost | over_daily_minutes | disabled | global_pause`.
- **`record_call_usage(p_client_id, p_call_sid, p_duration_secs, p_est_cost_usd)`** →
  `insert … on conflict do nothing`, returns updated period totals.

> **Idempotency warning, learned the hard way.** `record_call_usage` must dedupe on
> `call_sid` the same way `log_agent_reply` dedupes on `external_ref` — and unlike that
> one, it should **return whether it inserted**, not swallow the conflict silently. A
> re-fired post-call webhook double-counting minutes would trip the cap and take a client's
> line down for no reason. That silent-`do nothing` pattern is exactly what caused the
> vanishing-agent-replies bug on email.

### 4d. Enforcement — four layers, cheapest first

| # | Layer | Where | What it does |
|---|---|---|---|
| 1 | **Pre-call gate** | `voice-personalization` | Calls `check_voice_allowance`. If not allowed, returns an override prompt + first message: *"Thanks for calling Tsunami — our phone support is unavailable right now. Please email hey@tsunami.store and the team will get right back to you."* plus an instruction to `end_call` immediately. Costs ~8 seconds of minutes instead of 3 minutes. |
| 2 | **Per-call ceiling** | ElevenLabs agent settings | Max call duration 300s; silence/turn timeouts. Hard stop on any single runaway call. |
| 3 | **Mid-call wrap** | `voice-order-lookup` | Returns `wrap_up: true` when the client is over cap, so a call that *started* under cap gets closed out politely instead of running long. |
| 4 | **Meter + alert** | `voice-call-logger` | Reads duration from the post-call payload → `record_call_usage`. At 80% of cap, raise a dashboard warning; at 100%, layer 1 starts deflecting. |

Plus two switches that don't depend on any of the above:

- **Global kill switch** — a platform-level flag that layer 1 checks, so you can stop *all*
  AI calls in one SQL statement if something goes wrong at 2am.
- **Twilio geo permissions** — disable international inbound/outbound on the number. Cheap
  insurance against toll-fraud, which is how these bills actually explode.

### 4e. Dashboard

One "Voice usage" card per client: minutes used / cap with a progress bar, estimated cost,
call count, **average call duration**, and a manual pause toggle. Reuse the entitlements
patterns from `0008` — the locked/warning/active states map cleanly onto
`under cap / 80% / over cap`.

---

## 5. Ticket system + callbacks

### 5a. Extend `review_queue` — do not build a second table

`review_queue` is already ~70% of a ticket system: `reason`, `details`,
`status` (pending/resolved/dismissed), `resolved_at`, a conversation link, **an `assignee`
column that already references `users(id)`** (built in `0001`, just never surfaced in the
UI), and a working dashboard page with resolve/dismiss/reopen actions. Building a separate
`tickets` table next to it gives the client **two inboxes that disagree** — the classic
version of this mistake. Evolve the table you have.

`0013_tickets_callbacks.sql` adds:

```sql
alter table review_queue
  add column ticket_no      bigint generated by default as identity,
  add column priority       text not null default 'normal'
       check (priority in ('low','normal','high','urgent')),
  add column channel        text,          -- denormalized from conversation, for filtering
  add column external_ref   text,          -- '<call_sid>:callback' — idempotency key
  -- callback fields
  add column callback_number   text,
  add column callback_window   text,       -- what the caller actually said: "after 3pm"
  add column callback_due_at   timestamptz,
  add column callback_status   text not null default 'none'
       check (callback_status in ('none','scheduled','attempted','completed','failed')),
  add column callback_attempts int not null default 0,
  add column last_attempt_at   timestamptz;

create unique index uq_review_external_ref
  on review_queue (client_id, external_ref) where external_ref is not null;

create table ticket_notes (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references review_queue(id) on delete cascade,
  author_id uuid references users(id) on delete set null,  -- matches review_queue.assignee
  body text not null,
  created_at timestamptz not null default now()
);
-- plus the tenant-scoped RLS policy every table in 0001 carries
```

`reason` is a `text` column with a CHECK constraint (not an enum — `0001` chose that
deliberately so "new triggers incl. voice don't need a type migration"), so adding
`callback_request` is a drop-and-recreate of the constraint:

```sql
alter table review_queue drop constraint review_queue_reason_check;
alter table review_queue add constraint review_queue_reason_check
  check (reason in ('order_over_24h','abnormal_status','caller_request',
                    'no_order_id','callback_request','other'));
```

`ticket_no` gives staff and callers a short human reference ("ticket ten forty-two") — a
UUID is unusable out loud.

> Same idempotency rule as everywhere else in this codebase: the unique index on
> `external_ref` must **not** be paired with a silent `on conflict do nothing`. Have
> `create_ticket` return the existing ticket's number on conflict, so a retried tool call
> reads back the *same* number instead of failing or silently creating nothing.

### 5b. Capturing the callback on the call

New server tool `request_callback` → new edge function `voice-ticket`. The agent calls it
when: the caller asks for a person outside business hours, a transfer fails, the order is
flagged, or the caller just wants someone to call back.

Tool body:

```json
{
  "called_number": "{{system__called_number}}",
  "caller_number": "{{system__caller_number}}",
  "call_sid":      "{{system__call_sid}}",
  "callback_number": "{{callback_number}}",
  "callback_window": "{{callback_window}}",
  "reason":          "{{reason_summary}}",
  "order_number":    "{{order_number}}",
  "priority":        "{{priority}}"
}
```

The function resolves the tenant, ensures the conversation exists (`ingest_call`), calls
`create_ticket(...)` with `external_ref = '<call_sid>:callback'`, and returns
`{ ticket_no, callback_due_at }` so the agent can say: *"You're all set — your reference is
ticket ten forty-two, and someone will call you back on that number before five today."*

Prompt rules that matter more than the code:

- **Default the callback number to the caller ID, but read it back and confirm.** Callers
  routinely want a callback on a different phone than the one they're calling from.
- **Never promise a specific time** — only the window from `settings.business_hours`.
- Capture a one-sentence reason. That's what makes the ticket workable without listening
  to the recording.

### 5c. Dashboard: Review Queue → Tickets

Same route, upgraded (`/review-queue` can redirect to `/tickets`):

- **List:** ticket number, priority chip, channel icon (phone/email), reason, customer,
  order number, age, assignee (the column already exists — this is the first UI for it).
  Filters for status, priority, assignee, channel, plus a
  **"Callbacks due"** filter that's the default landing view for phone-heavy clients.
- **Sort:** callbacks due soonest first, then oldest — an overdue callback is the single
  most expensive thing in a support queue.
- **Detail view:** the existing conversation transcript, plus a callback panel —
  `tel:` click-to-call link, "Mark attempted / completed / failed", attempt counter — and
  the notes trail.
- **Top-of-page counter:** "3 callbacks due today, 1 overdue." Overdue in red.
- Reuse the `FlagChip` / `STATUS_BADGE` patterns already in `review-queue/page.tsx`; the
  server-action + `revalidatePath` shape in `actions.ts` extends directly to notes and
  callback status.

Notification: email the client when a callback ticket is created and when one goes overdue.
This shares whatever mailer you pick for the booking confirmation email (Resend/SES), so
do them together.

### 5d. Should the AI make the callback?

Tempting, and technically straightforward — ElevenLabs supports outbound Twilio calls, so a
scheduled job could drain `callback_status = 'scheduled'` when `callback_due_at` arrives.
**Recommend not in v1**, for three reasons:

1. **Cost shape flips.** Inbound calls are demand-limited; outbound is a loop *you* control,
   which is exactly the failure mode §4 exists to prevent. If you build it: max 3 attempts
   per ticket, business hours only, and route every outbound minute through the same
   `check_voice_allowance` gate.
2. **Legal.** Automated outbound calls fall under TCPA and state analogues in the US, with
   real per-call statutory damages. At minimum you'd need explicit recorded consent on the
   line ("is it OK if we call you back on this number?") and a scrubbing process. Worth an
   actual lawyer's read before switching it on — I'm not one.
3. **Demo value is low.** "A human gets a ticket with the number and the reason" is a
   completely convincing story to a client. AI-calls-you-back invites scrutiny you don't
   need in a first meeting.

Design the schema for it (the `callback_attempts` / `last_attempt_at` columns above are
already the right shape) and leave it switched off.

---

## 6. Build order (ASAP path)

**Phase 1 — a working demo call (~1 day)**

1. Add the Shopify branch to `voice-order-lookup` (§3), keeping `MOCK_STORE=1` working.
2. Create the Shopify custom app, store the token in Vault, wire `store_credentials_ref`.
3. Buy a Twilio number → import into ElevenLabs → assign to a new agent "Lumi — Orders" →
   `update clients set phone_number = '+1XXXXXXXXXX' where slug = 'shopify-store';`
4. Paste the orders system prompt (§7) with Tsunami's name, tone, and policy blob
   hardcoded for now. Add tools: `lookup_order`, `transfer_to_number`, `end_call`.
5. Set LLM = Gemini Flash **on the paid tier** (mandatory — this is live customer PII, and
   the free tier trains on it), prompt caching on, max call duration 300s.
6. Point the post-call webhook at `voice-call-logger`, set the signing secret.
7. Test call: real recent order → correct status + tracking; refunded order → holding reply
   + transfer; "let me talk to someone" → transfer; bad order number → graceful retry.

**Phase 2 — the limiter (~1 day, before anyone else's number goes live)**

8. ✅ `0012_voice_usage_caps.sql` + `check_voice_allowance` / `record_call_usage` + tests.
9. Wire layer 4 (meter) into `voice-call-logger`, then layer 1 (gate) into
   `voice-personalization`, then layer 3 (`wrap_up`). **← next**
10. Set Tsunami's caps and `platform_settings.plan_minutes`; check `voice_cap_allocation`
    isn't already over-allocated. Test by setting `monthly_minutes: 1` and confirming the
    deflect message plays and the call ends.

**Phase 3 — tickets + callbacks (~1–1.5 days)**

11. `0013_tickets_callbacks.sql` + `create_ticket` RPC + `ticket_notes`.
12. `voice-ticket` edge function; add the `request_callback` tool to the agent and the
    callback branch to the prompt.
13. Dashboard: Tickets list (filters, priority, assignee) + callback panel on the detail
    view + "callbacks due today" counter.
14. Callback-created / callback-overdue emails (share the mailer with the booking
    confirmation email that's already on the backlog).

**Phase 4 — polish for the client meeting (~half day)**

15. Move the Tsunami prompt out of the hardcoded agent into `voice-personalization` with an
    orders/scheduling mode branch, so client #2 is config-only.
16. Voice usage card on the dashboard.
17. Caller verification: after `lookup_order` succeeds, have the agent confirm one fact the
    caller should know (shipping zip or the name on the order) *before* reading back
    address or contact details. Cheap, and it's the first thing a security-minded client
    asks about.

**Demo-critical subset**, if time collapses: Phase 1 + the ticket/callback capture (11–13).
The limiter (Phase 2) can be a manually-set low cap on the ElevenLabs plan for one meeting
— but it must be built before a second client's number goes live.

---

## 7. Orders + policy system prompt (paste into the agent)

```
You are the phone support agent for {{store_name}}. You are on a live phone call, so keep
replies short and natural — one idea at a time. Never read out URLs, IDs, JSON, or internal
flags. Never invent order details, dates, or policies.

You can help with: order status, tracking, what's in an order, delivery timing, and
questions about {{store_name}}'s return and shipping policies.

Store policies (answer from these only — if it isn't here, say you'll have a teammate
follow up):
{{store_policies}}

Flow:
1. Greet: "Thanks for calling {{store_name}}, how can I help?"
2. For anything order-specific you need the order number. Ask once, clearly. Order numbers
   sound like "ten-oh-one" — read it back to confirm before looking it up.
3. Call lookup_order. Then:
   - need_order_number → ask for it.
   - order_not_found → say you couldn't find it, ask them to double-check, offer a callback.
   - found, should_escalate false → before reading back any personal details, confirm the
     name on the order or the shipping zip. Then answer using only the returned fields.
   - found, should_escalate true → brief, non-committal holding answer ("let me get a
     teammate to take a closer look"). Promise nothing. Escalate.
   - wrap_up true → politely close the call out and end_call.
4. Escalation, or the caller asks for a person:
   - During business hours → transfer_to_number.
   - Outside hours, or if the transfer fails → call request_callback. Confirm the best
     number by reading it back digit by digit (default to the number they're calling from,
     but always ask). Ask when suits them. Summarize their issue in one sentence for the
     ticket. Then read back the ticket number and end_call.
   - Never promise a specific callback time — only the next business window.
5. Tone: {{brand_voice}}.
```

Fill `{{store_policies}}` from a new `clients.settings.policies` field (returns window,
shipping times, refund timing) — keep it under ~150 words so it stays cached and doesn't
slow first-token latency.

---

## 8. Risks and open items

| Risk | Impact | Mitigation |
|---|---|---|
| Shopify 60-day order limit | Demo order returns "not found" | Demo with recent orders; request `read_all_orders` now |
| Live customer PII through the LLM | Privacy exposure | Gemini **paid tier** before any real call; verification step (Phase 3.13); read-only token |
| Post-call webhook double-fires | Double-counted minutes → false cap trip | `record_call_usage` idempotent on `call_sid`, and returns insert status rather than failing silently |
| Order numbers misheard on the line | Wrong order or repeated failures | Read-back confirmation in the prompt; normalize `#`/spaces server-side |
| Uncommitted repo batch (since 2026-07-24) | New voice work gets tangled in an already-large diff | Commit the existing batch **before** starting — and note git is blocked from this session, so it has to be done locally |
| ElevenLabs pool exhaustion | *All* clients' lines fail, including the demo | Per-client caps summing to ≤80% of plan; confirm burst-vs-fail setting |
| Callback number misheard | Ticket is unworkable; caller never hears back | Digit-by-digit read-back in the prompt; default to caller ID; dashboard shows both |
| Callbacks pile up unworked | Worse than no bot — the client's customers were promised a call | Overdue counter + overdue email; callbacks-due as the default queue view |
| AI outbound callbacks (if built later) | TCPA exposure, runaway cost loop | Not in v1; if built: recorded consent, ≤3 attempts, business hours, same cap gate, and a lawyer's review |

**Not in scope for v1:** AI-placed outbound callbacks (§5d), returns/refund *processing*
(intake via ticket is in scope), call recording → Storage (`audio_url` hook exists but
isn't wired), web widget on the Tsunami site (needs slug-aware `voice-order-lookup`), and a
real knowledge base.

---

## 9. Deploying what's built so far

```bash
# from the repo root, locally (git + supabase CLI are blocked from the cloud session)
npx tsx scripts/test-voice-lookup-shopify.ts          # 94 checks, expect all green
supabase functions deploy voice-order-lookup --no-verify-jwt

# 0012 — run the test against a shadow/staging db first; it rolls itself back
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_voice_usage_caps.sql
supabase db push
```

After `db push`, set the pool size and this client's caps:

```sql
update platform_settings
   set plan_minutes = 1238,          -- your actual ElevenLabs plan
       default_monthly_minutes = 200,
       reserve_pct = 20
 where id = 1;

update clients
   set settings = settings || jsonb_build_object('voice_caps',
         jsonb_build_object('monthly_minutes', 200, 'daily_minutes', 30,
                            'max_call_secs', 300, 'enabled', true))
 where slug = 'shopify-store';

select * from voice_cap_allocation;   -- over_allocated must be false
```

Global kill switch, if a call ever goes wrong at 2am:
`update platform_settings set voice_enabled = false where id = 1;`

No migration is required for the Shopify branch. Before the first real lookup:

```sql
-- 1. read-only Shopify custom app token -> Vault
select vault.create_secret(
  '{"access_token":"shpat_…","base_url":"https://tsunami-store-7957.myshopify.com"}',
  'shopify-store_shopify');

update clients
   set store_credentials_ref = 'shopify-store_shopify',
       phone_number          = '+1XXXXXXXXXX'   -- the new Twilio number, E.164
 where slug = 'shopify-store';
```

Smoke test without touching the store: set `MOCK_STORE=1` and call the function — the
canned order path is unchanged. Then unset it and try a real recent order number.

---

## Sources

- [ElevenAgents pricing](https://elevenlabs.io/pricing/agents) — plan tiers, per-minute rates, LLM billed separately at cost
- [How much does ElevenAgents cost](https://help.elevenlabs.io/hc/en-us/articles/29298065878929-How-much-does-ElevenAgents-cost) — 95% silence discount, LLM pass-through
- [Shopify Admin GraphQL — orders query](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders) — `name:` search filter, API version 2026-07
- [Apps now need Shopify approval to read orders older than 60 days](https://shopify.dev/changelog/apps-now-need-shopify-approval-to-read-orders-older-than-60-days) — the `read_all_orders` constraint
- [Shopify API access scopes](https://shopify.dev/docs/api/usage/access-scopes) — `read_orders` / `read_fulfillments`
