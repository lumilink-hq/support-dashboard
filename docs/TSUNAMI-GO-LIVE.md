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
Never give medical or legal advice, and never advise on effects, dosage, potency, or what a
product will do to someone.
Product questions: use the lookup_product tool and answer only from what it returns.
Anything not covered here: direct them to tsunami.store/contact-us.')
 where slug = 'shopify-store';

-- 2f. AGENT MODE — required, and easy to miss. Without it, voice-personalization
--     ships the HVAC *scheduling* system prompt as a conversation override and
--     REPLACES the orders agent's prompt: the call greets correctly as Tsunami,
--     then refuses every order question because the injected prompt is a booking
--     receptionist. 'orders' makes the function return dynamic variables only
--     and leave the agent's own prompt alone.
update clients
   set settings = settings || jsonb_build_object('voice_agent_mode', 'orders')
 where slug = 'shopify-store';

-- 2g. PRODUCT LOOKUP (added 2026-07-29 when product Q&A became a requirement).
--     order_number_prefix is what makes "TSU#1749" resolvable; the other two
--     drive the catalogue.
update clients
   set settings = settings || jsonb_build_object(
         'order_number_prefix', 'TSU#',
         -- How old products_cache may be before search_products stops letting
         -- the agent state stock. Flower moves fast, so keep this tight.
         'product_cache_max_age_minutes', 60)
 where slug = 'shopify-store';

-- 2h. SHIPPING RESTRICTIONS — must be TSUNAMI'S OWN WORDS, reviewed by them.
--     The agent answers shipping and legality questions ONLY from this text and
--     declines anything not covered. Leave it unset and the agent declines every
--     shipping question, which is the safe default. Do NOT write this yourself:
--     where hemp may be shipped is a legal question that varies by state and
--     changes, and a confident wrong answer is the client's liability.
-- update clients
--    set settings = settings || jsonb_build_object('shipping_restrictions',
-- 'We ship to … We cannot ship to … Orders to restricted states are cancelled and refunded.')
--  where slug = 'shopify-store';
```

Verify the three that make or break the agent's answers:

```sql
select settings ->> 'voice_agent_mode'               as mode,     -- expect: orders
       left(settings ->> 'policies', 40)             as policies, -- expect: non-empty
       abnormal_status_rules ->> 'stale_after_hours'  as stale,    -- expect: 48
       settings ->> 'web_lookup_enabled'             as web
  from clients where slug = 'shopify-store';
```

> ⚠️ **2c changes the LIVE EMAIL AGENT too.** `evaluate_flag` is shared, so Tsunami's email
> replies also stop treating shipped-but-old orders as problems. That's an improvement, but
> it's a production behavior change — make it deliberately.

**No usage caps are being set.** Limiter layers 1 and 4 aren't wired, so nothing enforces a
cap and nothing can accidentally block the demo. That's the current intent.

---

## §3 — Deploy

> ⚠️ **Check migration history BEFORE pushing.** `0009` was used twice
> (`0009_reschedule_cancel.sql` and an untracked `0009_paywall_flag.sql`). The CLI keys history
> on the leading version number, so it records one and silently skips the other. The paywall
> file has been renumbered to `0015`, but confirm the state first:
>
> ```sql
> select version from supabase_migrations.schema_migrations order by version;
> select to_regclass('app_config'), to_regproc('paywall_enabled');
> ```
>
> If `app_config` exists but `paywall_enabled()` doesn't, the original `0009` died partway —
> re-running `0015` now completes it. (It also claimed to be idempotent and wasn't: `create
> trigger` and `create policy` have no `if not exists` form. Both now `drop ... if exists`
> first.) `paywall_enabled` **must** end up `false`, or the demo hits locked pages.

```bash
supabase db push          # applies 0012, 0013, 0014, 0015, 0016
supabase functions deploy voice-order-lookup --no-verify-jwt
supabase functions deploy voice-ticket      --no-verify-jwt

# Confirm the migrations actually landed (files have gone missing before):
psql "$DATABASE_URL" -c "select count(*) from platform_settings;"        -- 0012
psql "$DATABASE_URL" -c "select ticket_no from review_queue limit 1;"    -- 0014
psql "$DATABASE_URL" -c "select paywall_enabled from app_config;"        -- 0015, expect f
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
6. PRODUCTS. For anything about what the store sells, call lookup_product. Send just the
   product name or type, not the caller's whole sentence. Then branch:
   - need_product_name: ask which product they mean.
   - found, stock_known true: you may say which sizes are available. Read sizes_in_stock and
     sizes_out_of_stock as given. If one size is out and others are not, say exactly that.
   - found, stock_known false: give the name, price and description. Do NOT say whether it is
     in stock, and do not hedge about it either. Say you will have someone confirm
     availability, and offer a callback. (With `stock_policy = always` this branch no longer
     fires for staleness — only when a product has inventory tracking switched off.)
   - match_count 0 WITH a catalog field: do NOT say the store doesn't sell it — the caller
     probably used a different name. Say what is carried, using only the types, examples and
     brands in the catalog field, and let them pick. Never name a product that isn't listed
     there.
   - match_count 0 with no catalog field: ask them to describe it differently or invite them to
     browse the store.
   - catalog_unavailable: say you cannot check the catalogue right now and offer a callback.
     NEVER tell the caller the product does not exist.
   Quote prices only from price_from and price_to. Never estimate a price.
7. WHAT YOU WILL NOT SAY ABOUT PRODUCTS. No medical or therapeutic claims, and no advice on
   effects, dosage, potency, or what a product will do to someone. If asked what to take for
   sleep, pain, anxiety, or any symptom, say you cannot advise on that and point them to the
   product pages or a callback. This holds even when the caller insists, and even when the
   product description mentions an effect.
8. SHIPPING AND LEGALITY. Answer only from the shipping rules below. If a state, country or
   restriction is not covered there, say you are not able to confirm it and offer a callback.
   Never reason from your own knowledge about where these products may be sent.
   {{shipping_restrictions}}
9. Never give medical or legal advice.
10. Aim to resolve within about two minutes. If it's running long, offer a callback rather than
    continuing to dig.
11. Tone: {{brand_voice}}. Warm, concise, discreet.
```

> ⚠️ **THE POLICY BLOB OUTRANKS THIS SECTION — check §2e first.** On 2026-07-29 the agent
> deflected every availability question no matter what the tool returned, and the cause was
> not the prompt or the cache. `clients.settings.policies` still contained *"Never confirm or
> deny whether a specific product is in stock — ask them to browse the store."* That text is
> injected as `{{store_policies}}` on every turn, under a prompt line reading "answer ONLY from
> these". So the agent was obeying a stored instruction, and no code change could override it.
> If availability answers look wrong, read the blob in the database before touching anything
> else:
>
> ```sql
> select settings ->> 'policies' from clients where slug = 'shopify-store';
> ```
>
> ⚠️ **Step 6 reverses the previous rule.** The old prompt said "never confirm or deny whether a
> product is in stock." That was correct while nothing could check. Now `lookup_product` reads
> `products_cache`, and `search_products` decides whether the data is fresh enough to speak —
> the agent is never trusted to judge staleness itself. `stock_known: false` strips the stock
> fields before the agent sees them, so it cannot leak a stale "yes" even if the prompt slips.
>
> ⚠️ **Steps 7 and 8 are new guardrails, not fine print.** Tsunami sells THCA and hemp. The
> catalogue is strain names and weights, so "which one helps me sleep" is a predictable
> question, and answering it is a health claim. `{{shipping_restrictions}}` must be text
> Tsunami wrote and approved — see §2g. Leaving it blank means the agent declines shipping
> questions, which is the correct failure mode.

Dynamic variables: `store_name`, `brand_voice`, `store_policies`, `client_slug`.

**`voice-personalization` now supplies all four** (`store_policies` was added 2026-07-29 — it
was missing, so `{{store_policies}}` would have rendered EMPTY and the agent would have had no
policies at all while looking like it was working). Wire the conversation-initiation webhook to
`voice-personalization` and they arrive per call. Still set static defaults on the agent as a
safety net for when the webhook fails — an undefined variable renders as an empty string rather
than erroring, so a silent blank is the failure mode you're guarding against.

Requires §2f (`voice_agent_mode = 'orders'`). Without it this function overrides your prompt
with the HVAC scheduler — see §2f.

### Tools

Add four. JSON bodies are version-controlled in `docs/elevenlabs-tools/`.

1. **`lookup_order`** — webhook `POST .../voice-order-lookup`, header
   `x-voice-tool-secret: <VOICE_TOOL_SECRET>`.
2. **`request_callback`** — webhook `POST .../voice-ticket`, same header.
3. **`lookup_product`** — webhook `POST .../voice-product-lookup`, same header. Reads
   `products_cache`, never Shopify, so it answers in tens of ms.
4. **`end_call`** — system tool.

> `lookup_product.json` was written against `lookup_order.json`, which is the **UI-exported**
> file and the only reliable template. The scheduling tool JSONs pre-date a schema change and
> will 422. See `docs/elevenlabs-tools/README.md`.

> Both webhook tools take `called_number` **and** `client_ref`. Phone fills the number and
> leaves the slug empty; web does the reverse. Send both — the functions treat an empty string
> as absent, which is exactly how ElevenLabs sends unused parameters.

---

## §5 — Dashboard ✅ BUILT (2026-07-29)

All four items shipped. No action needed here beyond deploying `0016` (below).

- ticket number (`ticket_no`) as a monospace `#1042` chip — matches what the agent says aloud
- callback number as a `tel:` link
- a **Callbacks due** tab reading the `callbacks_due` view, soonest-first, red border when
  `overdue`, plus a count badge on the tab so it's visible from any other tab
- **Reached them / No answer / Can't reach** → `record_callback_attempt`. These also render on
  regular pending rows that carry a callback, so you don't have to switch tabs to work one.

Files: `app/(dashboard)/review-queue/{page,actions}.tsx|ts`, `components/status-badge.tsx`,
`lib/types.ts`.

Two notes on what was actually found:

**`FlagChip` was never going to render unlabelled** — it passes `reason` through `humanize()`,
so `callback_request` already read as "callback request". The real problem was that it rendered
**red ⚑**. A caller asking for a human is a normal outcome, not a failure; if every ticket is
red the client learns to ignore red. It now gets a neutral violet ☎ (as does `caller_request`).

**⚠️ `0016_harden_record_callback_attempt.sql` is REQUIRED before the UI is safe to use.**
`0014`'s `record_callback_attempt` is `security definer` and granted to `authenticated`, but
never checks the ticket belongs to the caller's tenant — it reads `client_id` only to stamp the
`ticket_notes` row. Any signed-in user could pass another tenant's ticket UUID and mark it
`completed`, which also flips `status` to `resolved` and silently empties that tenant's queue.
Ticket UUIDs aren't guessable so this was never a live breach, but the dashboard is now calling
that function directly. `0016` adds the tenant guard, lets NULL callers (service_role, no
`auth.uid()`) through so the edge functions are unaffected, and returns `unknown_ticket` for
both the missing and forbidden cases so it can't be used to probe other tenants' ids.

`callbacks_due` itself needs no fix — it's `security_invoker = true`, so it inherits
`review_queue`'s RLS.

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
