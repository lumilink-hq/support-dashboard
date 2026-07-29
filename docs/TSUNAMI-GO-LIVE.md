# Tsunami Agent — Go-Live Runbook

**2026-07-29.** Everything needed to get the Tsunami voice agent fully running, and to retire
the Comfort Air demo. Ordered — §0 first, it's the most likely thing that's currently broken.

---

## §0 — Verify the number switch actually landed in the database

> ⚠️ **Deactivating Comfort Air does NOT free its phone number.** The unique index
> `uq_clients_phone_digits` (migration `0010`) is
> `where phone_number is not null` — it has **no `is_active` filter**. So an inactive client
> still holds the number, and `update clients set phone_number = '+12135332469'` on Tsunami
> fails with a unique violation. The old holder's number must be set to **NULL**.

Meanwhile `resolve_client_by_number` *does* filter on `is_active`. Those two facts combine
into a nasty failure mode: if you switched the number **only in the ElevenLabs UI**, the
database still maps those digits to `comfort-air-demo`, and every Tsunami call either routes
to the wrong tenant or returns "this phone line isn't configured for a store."

Run this first:

```sql
select slug, name, is_active, phone_number
from clients
where phone_number is not null
   or slug in ('shopify-store','comfort-air-demo')
order by slug;
```

**What you want to see:** `shopify-store` holds `+12135332469`, `comfort-air-demo` has
`phone_number = null`. If it's the other way round, §1 fixes it.

---

## §1 — Retire Comfort Air and hand the number over

One transaction — the NULL must happen before the assignment or the unique index rejects it.

```sql
begin;

-- Free the number FIRST (the index doesn't care that a client is inactive).
update clients set phone_number = null where slug = 'comfort-air-demo';

-- Hide the demo tenant. resolve_client_by_number filters on is_active, so this
-- alone stops it answering anything.
update clients set is_active = false where slug = 'comfort-air-demo';

-- Hand the number to Tsunami.
update clients set phone_number = '+12135332469' where slug = 'shopify-store';

commit;
```

Then re-run the §0 query to confirm.

**In ElevenLabs:** unassign `+12135332469` from the Comfort Air scheduling agent and assign it
to the new orders agent (§4). A number can only be bound to one agent.

**Leave the scheduling data alone.** `services`, `appointments`, and the scheduling functions
are untouched by this — Comfort Air is dormant, not deleted, and re-activating it later is
two `update` statements plus reassigning a number.

> Not required, but worth knowing: with the number on Tsunami, **both** the phone line and the
> tsunami.store web widget work at once. Phone routes by dialed number, web by slug. They
> don't conflict.

---

## §2 — Database configuration

```sql
-- 2a. Shopify credentials (read-only custom app: read_orders + read_fulfillments)
select vault.create_secret(
  '{"access_token":"shpat_…","base_url":"https://tsunami-store-7957.myshopify.com"}',
  'shopify-store_shopify');

update clients set store_credentials_ref = 'shopify-store_shopify'
 where slug = 'shopify-store';

-- 2b. Enable the web widget path (needed only for the tsunami.store embed)
update clients
   set settings = settings || jsonb_build_object('web_lookup_enabled', true)
 where slug = 'shopify-store';

-- 2c. THE STALENESS FIX — without this, nearly every "where's my order?" call
--     escalates instead of answering. This is the single highest-impact line here.
update clients set abnormal_status_rules = jsonb_build_object(
  'abnormal_statuses', jsonb_build_array(
     'ON_HOLD','RESTOCKED','REFUNDED','VOIDED','PARTIALLY_REFUNDED'),
  'stale_after_hours', 48,
  'stale_exempt_statuses', jsonb_build_array('FULFILLED','PARTIALLY_FULFILLED'))
 where slug = 'shopify-store';

-- 2d. Business hours — currently {}. CONFIRM the timezone before running.
update clients
   set business_hours = jsonb_build_object(
         'tz', 'America/New_York',
         'hours', 'Mon-Fri 09:00-17:00')
 where slug = 'shopify-store';

-- 2e. Voice-sized policy blob (~150 words of DECISION RULES, not prose — it is
--     re-sent to the model on every turn).
update clients
   set settings = settings || jsonb_build_object('policies',
'All sales are final — no refunds or exchanges once an order is processed.
Damaged or wrong item: report within 7 days of delivery through the contact page with
photos; replacement is case by case.
Cancellations: only before the order is fulfilled or shipped. Once it shows fulfilled or
shipped it cannot be cancelled.
Tracking is emailed when the order is fulfilled; if it is missing, check spam.
Delivery times vary by carrier and count business days only, no federal holidays.
Lost, delayed, or marked delivered but missing: the carrier handles it — the customer files
the claim with the carrier.
Wrong address entered at checkout: reshipment is at the customer''s expense.
All orders ship discreetly.
Never give medical or legal advice. Never confirm or deny whether a specific product is in
stock — ask them to browse the store.
Anything not covered here: direct them to tsunami.store/contact-us.')
 where slug = 'shopify-store';
```

> ⚠️ **2c changes the LIVE EMAIL AGENT too.** `evaluate_flag` is shared, so Tsunami's email
> replies also stop treating shipped-but-old orders as problems. That's an improvement, but
> it's a production behavior change — make it deliberately.

**No usage caps are being set.** Limiter layers 1 and 4 aren't wired, so nothing enforces a
cap and nothing can accidentally block the demo. That's the current intent.

---

## §3 — Deploy

```bash
supabase db push          # applies 0012, 0013, 0014
supabase functions deploy voice-order-lookup --no-verify-jwt
supabase functions deploy voice-ticket      --no-verify-jwt

# Confirm the migrations actually landed (files have gone missing before):
psql "$DATABASE_URL" -c "select count(*) from platform_settings;"        -- 0012
psql "$DATABASE_URL" -c "select ticket_no from review_queue limit 1;"    -- 0014
```

Secrets, if not already set:

```bash
supabase secrets set VOICE_TOOL_SECRET=<same value used in the ElevenLabs tools>
supabase secrets set ELEVENLABS_WEBHOOK_SECRET=<post-call webhook signing secret>
```

---

## §4 — Build the ElevenLabs orders agent

**Create a NEW agent.** Don't repoint the Comfort Air one — its prompt is hardcoded HVAC
scheduling, and agents cost nothing (billing is per minute).

**Settings:** LLM = Claude · prompt caching on · max call duration 180s · assign
`+12135332469` · post-call webhook → `voice-call-logger` · Agent → Security → enable
per-field conversation overrides (required if you later drive the prompt from
`voice-personalization`; the call errors if a field is overridden without being enabled).

### System prompt

```
You are the phone support agent for {{store_name}}. You are speaking out loud on a live call,
so keep replies short and natural — one idea at a time. Never read out URLs, IDs, JSON, or
internal field names.

You can help with: order status, tracking, what's in an order, delivery timing, and questions
about {{store_name}}'s policies. You look orders up with the lookup_order tool. Never guess or
invent order details, dates, or policies.

Store policies — answer ONLY from these. If it isn't here, say a teammate will follow up:
{{store_policies}}

FLOW
1. Greet: "Thanks for calling {{store_name}}, how can I help?"
2. For anything order-specific you need the order number. Ask once, clearly. Order numbers
   sound like "ten oh one" — read it back to confirm before looking it up.
3. Call lookup_order. Then branch on what comes back:
   - need_order_number: ask for the order number.
   - order_not_found: say you couldn't find it, ask them to double-check, and offer a callback.
   - verification_required: ask for the email address on the order OR the shipping ZIP code,
     then call lookup_order again including it. Share NOTHING about the order until this passes.
   - verification_failed: say it didn't match and ask them to double-check. Reveal nothing.
   - found, should_escalate false: answer using only the returned fields.
   - found, should_escalate true: give a brief, non-committal holding answer — "let me get a
     teammate to take a closer look." Promise nothing. Then escalate (step 5).
   - wrap_up true: finish the current answer, then close the call politely.
4. PRIVACY. Before reading back anything personal — the name on the order, the address, or
   what was purchased — confirm the caller knows the name on the order or the shipping ZIP.
   Until then refer to it only as "your order". Never list product names to an unverified
   caller. This store ships discreetly and that matters to customers.
5. ESCALATION — when the order is flagged, the caller asks for a person, or you can't help:
   - Call request_callback. Default to the number they're calling from, but read it back digit
     by digit and confirm it. Ask when suits them. Summarize their issue in one sentence.
   - Read the reference back using the ticket_no_spoken value exactly as given.
   - Say someone will be in touch during the next business window. NEVER promise a specific
     time. Then end_call.
   - If request_callback returns ok:false, do NOT promise a call back — apologize, give the
     support email, and end the call.
6. Never give medical or legal advice. Never confirm or deny whether a specific product is in
   stock — invite them to browse the store.
7. Aim to resolve within about two minutes. If it's running long, offer a callback rather than
   continuing to dig.
8. Tone: {{brand_voice}}. Warm, concise, discreet.
```

Dynamic variables to define: `store_name`, `brand_voice`, `store_policies`, `client_slug`.
Until `voice-personalization` is wired, set them as static defaults on the agent.

### Tools

Add three. JSON bodies are version-controlled in `docs/elevenlabs-tools/`.

1. **`lookup_order`** — webhook `POST .../voice-order-lookup`, header
   `x-voice-tool-secret: <VOICE_TOOL_SECRET>`.
2. **`request_callback`** — webhook `POST .../voice-ticket`, same header.
3. **`end_call`** — system tool.

> Both webhook tools take `called_number` **and** `client_ref`. Phone fills the number and
> leaves the slug empty; web does the reverse. Send both — the functions treat an empty string
> as absent, which is exactly how ElevenLabs sends unused parameters.

---

## §5 — Dashboard (the last build item)

`0014` added the data; the UI doesn't show it yet. For the demo story — *"the caller asked for
a human, and here it is"* — `/review-queue` needs:

- ticket number (`ticket_no`) on each row
- callback number as a `tel:` link
- a "callbacks due" filter backed by the `callbacks_due` view (it already exposes `overdue`)
- buttons calling `record_callback_attempt(ticket_id, 'attempted'|'completed'|'failed')`

The existing `review-queue/actions.ts` server-action + `revalidatePath` pattern extends
directly. Also add a `callback_request` label to `FlagChip` in `components/status-badge.tsx`,
or it'll render an unlabelled chip.

---

## §6 — Five things to try on the first call

Formal testing is deferred, but don't demo without walking these:

1. **Recent, shipped order** → status + tracking read back, **no escalation.** If it escalates,
   §2c didn't apply.
2. **Refunded or on-hold order** → holding answer + callback offered.
3. **"Let me talk to someone"** → `request_callback`, number read back digit by digit, ticket
   number spoken, ticket appears in the dashboard.
4. **Bad order number** → graceful retry, no invented details.
5. **Order older than 60 days** → "not found". Expected: `read_orders` only reaches back 60
   days without `read_all_orders`. Use a recent order for the actual demo.

Then confirm the transcript landed on the conversation, and the ticket has a callback number.

---

## §7 — Rollback

```sql
begin;
update clients set phone_number = null where slug = 'shopify-store';
update clients set is_active = true, phone_number = '+12135332469'
 where slug = 'comfort-air-demo';
commit;
```

Plus reassign the number to the scheduling agent in ElevenLabs. Nothing else needs undoing —
the migrations are additive and the config changes are per-client.
