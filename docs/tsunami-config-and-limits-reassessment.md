# Tsunami — Config Fill-In + Limits Reassessment

**2026-07-29.** Written from the live `clients` row for `shopify-store`. Two things came out
of it: a flag rule that would have made the demo look broken, and a compliance constraint
specific to this vertical. Both change the plan.

Decisions applied: **no human transfer line yet** (callback-only, transfer wired but off),
and a mandated ceiling of **100 voice minutes/month** for the final Tsunami version (§4).

---

## 1. The finding that matters most: every WISMO call would escalate

`abnormal_status_rules` on the live row is:

```json
{"abnormal_statuses": ["ON_HOLD","RESTOCKED","REFUNDED","VOIDED","PARTIALLY_REFUNDED"],
 "stale_after_hours": 24}
```

`evaluate_flag` (migration `0002`) checks staleness **without looking at fulfillment
state**:

```sql
if  p_store_status is not null and v_abnormal ? p_store_status then 'abnormal_status'
elsif p_order_placed_at is not null
      and p_order_placed_at < now() - stale_after_hours then 'order_over_24h'
```

So a perfectly healthy order — **placed 3 days ago, shipped, in transit, `FULFILLED`** —
flags as `order_over_24h`. `voice-order-lookup` returns `should_escalate: true`, and the
prompt then tells the agent to give a non-committal holding answer and escalate.

That means the single most common call — *"where's my order?"*, where the customer is
calling precisely **because** it's been a few days — gets:

> "Let me get a teammate to take a closer look."

...instead of the tracking number the bot is holding in memory. On email this was tolerable
(a holding reply). On voice it's the difference between a working demo and one that never
answers a question.

**Cost impact:** escalation adds roughly 45–60s per call (confirming a callback number
digit by digit, capturing a reason, reading back a ticket number). Average call goes from
~2.9 min to ~4.3 min, and **every** call generates a callback ticket a human has to work.

| | Avg call | Calls inside a 300-min cap | Tickets/mo |
|---|---|---|---|
| Staleness rule as-is | ~4.3 min | ~70 | ~70 |
| Staleness rule fixed | ~2.9 min | ~103 | ~15–20 |

Same spend, ~47% more customers actually served, and a third of the human workload.

### Fix A — one line, no deploy, unblocks the demo today

```sql
update clients
   set abnormal_status_rules = jsonb_set(abnormal_status_rules, '{stale_after_hours}', '8760')
 where slug = 'shopify-store';
```

8760 hours = a year, which disables the staleness rule in practice. Abnormal statuses
(`ON_HOLD`, `REFUNDED`, …) still flag correctly — those are the ones that *should* escalate.
The tradeoff: a genuinely stuck unfulfilled order no longer auto-flags.

### Fix B — the real fix, backwards compatible

Add a `stale_exempt_statuses` key so the staleness rule skips orders already in a good
terminal state. Absent key → `'[]'` → today's exact behavior, so no other client changes.

```sql
-- 0013_stale_exempt_statuses.sql  (renumber the tickets migration to 0014)
create or replace function evaluate_flag(
  p_client_id uuid, p_store_status text, p_order_placed_at timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_rules jsonb; v_abnormal jsonb; v_stale_hours numeric; v_exempt jsonb;
begin
  select abnormal_status_rules into v_rules from clients where id = p_client_id;
  if v_rules is null then return jsonb_build_object('flagged', false, 'reason', null); end if;

  v_abnormal    := coalesce(v_rules -> 'abnormal_statuses', '[]'::jsonb);
  v_stale_hours := coalesce((v_rules ->> 'stale_after_hours')::numeric, 24);
  -- NEW: statuses that end the clock. Absent -> [] -> previous behavior exactly.
  v_exempt      := coalesce(v_rules -> 'stale_exempt_statuses', '[]'::jsonb);

  if p_store_status is not null and v_abnormal ? p_store_status then
    return jsonb_build_object('flagged', true, 'reason', 'abnormal_status');
  elsif p_order_placed_at is not null
        and not (p_store_status is not null and v_exempt ? p_store_status)
        and p_order_placed_at < now() - (v_stale_hours::text || ' hours')::interval then
    return jsonb_build_object('flagged', true, 'reason', 'order_over_24h');
  end if;
  return jsonb_build_object('flagged', false, 'reason', null);
end; $$;
```

Then for Tsunami:

```sql
update clients set abnormal_status_rules = jsonb_build_object(
  'abnormal_statuses', jsonb_build_array('ON_HOLD','RESTOCKED','REFUNDED','VOIDED','PARTIALLY_REFUNDED'),
  'stale_after_hours', 48,                                    -- 24h is aggressive for this store
  'stale_exempt_statuses', jsonb_build_array('FULFILLED','PARTIALLY_FULFILLED'))
 where slug = 'shopify-store';
```

> ⚠️ `evaluate_flag` is shared with the **live email agent**. This change also stops email
> from sending holding replies about shipped-but-old orders — almost certainly an
> improvement, but it is a behavior change on a production channel. Worth a deliberate yes.

---

## 2. Compliance constraint: voice is fine, SMS is not

Tsunami sells THCA flower and hemp products. Twilio **prohibits cannabis and CBD messaging
traffic in the US and Canada regardless of state legality** — and defines it broadly, as any
message relating to the marketing or sale of a cannabis product, whether or not it contains
cannabis terms or links. Campaigns get rejected (error 30940) and toll-free verification is
refused (30459).

**Programmable Voice is explicitly exempt** — Twilio's own guidance names cannabis
businesses using voice for transactional notifications. So:

- ✅ The inbound phone bot is fine as designed.
- ❌ **No SMS anywhere in this product for this client.** No text confirmations, no "here's
  your tracking" SMS, no SMS callback notifications.
- Callback notifications must be **voice or email**. The plan already used email (Resend/SES)
  for ticket notifications — now there's a hard reason, not just a preference.
- Keep the Twilio number **voice-only**. If someone later enables messaging on it for this
  brand, the exposure is the Twilio account, not just the feature.

---

## 3. Vertical-specific prompt rules (discretion)

Their own instructions say *"All orders ship discreetly"* and *"be discreet at all times."*
A phone caller is anonymous until verified — and the order line items are strain names.

- **Never read line items aloud before verification.** Refer to "your order" generically.
  Only after the caller confirms the name or shipping zip should the bot describe contents.
  The `verify_hint` field added to `voice-order-lookup` exists for exactly this.
- Inherit two rules verbatim from their email instructions: **no medical or legal advice**,
  and **never confirm or deny whether a specific product is in stock**.
- "Is THCA legal?" will come up on the phone. The safe answer is the one already in their
  blob — federally legal under the 2018 Farm Bill under 0.3% Delta-9, laws vary by state,
  customer is responsible — and then stop. No elaboration.

---

## 4. Reassessed limits

All-in ≈ **$0.10/min** (ElevenLabs ~$0.08 + Twilio ~$0.0085 + Gemini Flash pass-through).

Expected call mix for this store, with the staleness rule fixed:

| Call type | Share | Length |
|---|---|---|
| WISMO / tracking | ~55% | 2.0–2.5 min |
| Policy Q&A (all-sales-final, cancel, legal, age) | ~25% | 2.5–3.5 min |
| Escalation → callback capture | ~20% | 4.0–5.0 min |
| **Weighted average** | | **~2.9 min ≈ $0.29/call** |

### Caps — set to the mandated 100 min/month

Boss's constraint: **100 minutes/month for the final Tsunami version.** That's the number
below. What it buys:

| | Avg call | Calls/month | Variable cost |
|---|---|---|---|
| Staleness rule as-is | ~4.3 min | **~23** | ~$10 |
| Staleness rule fixed | ~2.9 min | **~34** | ~$10 |

**At 100 min the cap is a safety rail, not a budget control.** 100 minutes costs about $10 —
noise next to the $99/mo plan fee. So the fix in §1 isn't a cost optimization any more; it
buys **~11 more answered calls a month for the same spend**, which at this ceiling is a third
of total capacity. It moves from "important" to "the single highest-leverage change here."

```sql
update clients
   set settings = settings || jsonb_build_object('voice_caps', jsonb_build_object(
         'monthly_minutes', 100,     -- mandated ceiling: ~34 calls, ~$10/mo
         'daily_minutes',    15,     -- a runaway would otherwise burn the whole month in
                                     -- ~2 hours; this caps the damage at 15% of it per day
         'max_call_secs',   300,     -- 5 min = 5% of the ENTIRE month in one call (see below)
         'monthly_cost_usd', 15,     -- headroom if burst pricing kicks in at ~$0.16/min
         'enabled', true))
 where slug = 'shopify-store';
```

**I'm withdrawing the 420-second recommendation.** At a 300-minute cap, a 7-minute call was
2% of the month and worth it to avoid hanging up mid–phone-number. At 100 minutes it's 7% of
the month in a single call, which is indefensible. Back to 300s — but that reintroduces the
problem it was meant to solve, so **shorten the escalation path instead of the timer**:
default the callback to the number they're calling from and confirm it once ("we'll call you
back on this number — is that right?") rather than collecting and reading back digits. Saves
roughly 30 seconds on every escalation and fits comfortably inside 5 minutes.

**Pool math.** 100 of 990 allocatable minutes is ~10% — the reserve concern disappears
entirely. You could run eight more clients at this ceiling before the pool tightens.

> ⚠️ **Setup calls come out of the same 100 minutes.** A dozen test calls at 3 minutes is 36
> minutes — a third of the month gone before launch. Test against the existing
> `comfort-air-demo` client row or with `MOCK_STORE=1`, or raise Tsunami's cap during setup
> week and drop it to 100 the day you go live.

### The honest risk at this ceiling

At 100 min/month the binding constraint is **customer experience, not money**. If Tsunami
takes 60 support calls a month, 26 of those callers hear *"our phone support is unavailable
right now."* A line that turns people away half the time is worse than not launching it.

That's not an argument against the number — it's an argument for knowing the volume before
go-live. Two things make it safe:

1. **The 80% alert.** `record_call_usage` returns `crossed_warning` exactly once, on the call
   that crosses 80 minutes. Wire that to an email so someone decides — raise the cap or let
   it deflect — rather than finding out from a customer.
2. **Once the human line exists, over-cap should forward to it, not deflect.** Handing an
   over-cap caller to a person is strictly better than telling them to email. That's a small
   change to the pre-call gate's deflect branch and worth doing the week the line goes live.

```sql
update platform_settings
   set plan_minutes = 1238,          -- ⚠️ confirm your ACTUAL ElevenLabs plan
       default_monthly_minutes = 200,
       reserve_pct = 20
 where id = 1;

select * from voice_cap_allocation;   -- over_allocated must be false
```

**Review trigger:** after two weeks, check `voice_usage_current`. Two numbers decide what
happens next:

- `avg_call_minutes` **above ~3.5** → the prompt is running long. Fix that before touching
  the cap; it's the cheapest capacity you'll ever buy.
- **cap hit before month-end** → real demand exceeds 34 calls. That's a conversation with
  your boss backed by data, not a guess.

---

## 5. Everything that's null or empty on the live row

| Field | Now | Needs to be | Blocker? |
|---|---|---|---|
| `phone_number` | `null` | the Twilio number, E.164 | **Yes — no voice routing without it** |
| `store_credentials_ref` | `null` | Vault secret name | **Yes — no order lookup** |
| `business_hours` | `{}` | tz + hours | **Yes — see below** |
| `settings.voice_caps` | absent | §4 (100 min) | inherits the 200 default — **double the mandate** until set |
| `settings.policies` | absent | §6 blob | bot can't answer policy questions |
| `settings.transfer_number` | absent | later | no — callback-only for now |
| `abnormal_status_rules` | 24h, no exempt | §1 | **Yes — breaks WISMO** |

**`business_hours: {}` is doing more damage than it looks.** Three things read it:

1. `client_timezone()` in `0012` falls back to `UTC`, so their "monthly" cap rolls over at
   8pm ET on the last day of the month, not midnight local.
2. The escalation branch has no hours to decide transfer-vs-callback against.
3. The callback promise ("someone will call you back before five") has nothing to anchor to.

The seed file used `America/New_York` for Tsunami — **confirm that's right** before applying.

```sql
update clients
   set business_hours = jsonb_build_object(
         'tz', 'America/New_York',                 -- CONFIRM
         'hours', 'Mon-Fri 09:00-17:00')           -- CONFIRM
 where slug = 'shopify-store';

-- after importing the number into ElevenLabs:
update clients set phone_number = '+1XXXXXXXXXX' where slug = 'shopify-store';

-- read-only Shopify custom app token (read_orders + read_fulfillments):
select vault.create_secret(
  '{"access_token":"shpat_…","base_url":"https://tsunami-store-7957.myshopify.com"}',
  'shopify-store_shopify');
update clients set store_credentials_ref = 'shopify-store_shopify'
 where slug = 'shopify-store';
```

---

## 6. Condensed voice policy blob

`brand_tone_config.custom_instructions` is ~1,200 words. That's right for email and wrong
for voice: it's re-sent every turn, it inflates per-turn latency, and the model only needs
the decision rules. Condensed to ~160 words, decisions only:

```sql
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

Keep the full blob on `custom_instructions` for email — it's doing its job there.

---

## 7. Revised order of work

The no-transfer-line answer reorders things: **callback capture is now demo-critical, not
Phase 3 polish.** With no human line, a callback ticket is the *only* escalation path.

1. Fix the staleness rule (§1) — Fix A today, Fix B before go-live.
2. Fill the config gaps (§5, §6).
3. Twilio number + Shopify token + deploy `voice-order-lookup` + `db push` for `0012`.
4. **Ticket + callback capture** (was Phase 3) — the demo has no other escalation path.
5. Wire the three limiter enforcement layers.
6. Set caps (§4), confirm `voice_cap_allocation.over_allocated = false`.

---

## Still needed from the sheet

I couldn't open `docs/LumiLink_CFO_Financial_Hub/` — the desktop bridge dropped mid-session,
so the repo isn't reachable from here. Attaching the `.xlsx` straight to the chat is the
fastest fix. Once I can see it I'll fill in the cells it asks for; the per-call and monthly
figures above are the inputs it most likely wants.

## Sources

- [Twilio — cannabis/CBD messaging policy](https://support.twilio.com/hc/en-us/articles/1260804628349-Can-I-send-cannabis-or-CBD-related-messaging-traffic-on-Twilio) — messaging prohibited US/CA regardless of state law; Programmable Voice permitted
- [Twilio error 30940](https://www.twilio.com/docs/api/errors/30940) — campaign rejected for cannabis/CBD content
- [Twilio error 30459](https://www.twilio.com/docs/api/errors/30459) — toll-free verification rejected for cannabis/CBD
- [ElevenAgents pricing](https://elevenlabs.io/pricing/agents) — per-minute rates, LLM billed separately
