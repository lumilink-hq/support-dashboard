# Lumilink — Project Status & Next Steps

**Updated 2026-07-29.** This is the handover document. If you are a new Claude session, or J
on a different machine: **read this file first**, then only the linked docs you need.

Goal right now: **a working Tsunami demo.** Call limits are built but deliberately parked —
the ticket system is the priority because it's the only escalation path that exists.

---

## 0. Orientation in 60 seconds

Lumilink is a multi-tenant AI customer-support platform. Next.js dashboard + Supabase
(Postgres/RLS/Vault) + ElevenLabs voice agents. Two channels:

- **Email — LIVE in production.** Orchestrated by Zapier: Gmail → resolve client by
  `+<slug>` plus-address → fetch store + shipping → Claude → send → log to Supabase.
- **Voice — being built.** ElevenLabs Agents + native Twilio (no media server). Supabase Edge
  Functions do all the work; **Zapier is not involved in voice at all.**

Two pilot clients: **Bud Club** (`woo-store`, WooCommerce) and **Tsunami** (`shopify-store`,
Shopify — the active one). Plus a demo tenant, **Comfort Air** (`comfort-air-demo`, HVAC
scheduling).

Supabase project ref `xqsxjxrzpxhosedkmufg`. Functions base URL
`https://xqsxjxrzpxhosedkmufg.functions.supabase.co/<fn>`. Supabase CLI v2.109.1.

> **Tsunami sells THCA flower and hemp products.** Two consequences that are easy to miss:
> Twilio **prohibits cannabis/CBD SMS** in the US/CA regardless of state law (Programmable
> **Voice is explicitly exempt**) — so no SMS anywhere in this product for this client. And
> discretion is their selling point, so the agent must not read order contents to an
> unverified caller.

---

## 1. THE PHONE NUMBER QUESTION — you almost certainly don't need one

**Belief to correct:** "Tsunami has to reuse the Comfort Air demo number to work."

`+12135332469` belongs to `comfort-air-demo`. Migration `0010_client_phone_unique.sql`
enforces **at most one client per phone-number-digits**, so
`update clients set phone_number='+12135332469' where slug='shopify-store'` **fails with a
unique violation.** That constraint exists because this exact collision already happened once:
two clients shared that number, `resolve_client_by_number` returned an arbitrary one, and the
scheduling demo silently served empty slots.

**But a browser call has no dialed number at all.** Since 2026-07-29, `voice-order-lookup`
routes by **client slug** as well as by dialed number, which is how the scheduling function
already worked. So:

### The demo on tsunami.store needs NO Twilio number and NO number juggling.

```sql
-- Enable the web path on the REAL Tsunami row (live data was the chosen approach).
update clients
   set settings = settings || jsonb_build_object('web_lookup_enabled', true)
 where slug = 'shopify-store';
```

That's the whole configuration. The widget passes
`dynamic-variables='{"client_slug":"shopify-store"}'`, the tool sends
`client_ref: {{client_slug}}`, and the caller-verification gate (§3) protects the live data.

**Do NOT set `is_demo = true` on the real Tsunami row.** That flag exists to mark sandbox
tenants; setting it on a live client disables the guard that keeps the public widget away
from real customer data. `web_lookup_enabled` is the correct, explicit opt-in.

### If you later want a *callable* Tsunami phone line

Two options, in order of preference:

1. **Buy a second Twilio number — $1.15/month.** Cheaper than any workaround's complexity,
   and both demos stay live simultaneously.
2. **Swap the number between tenants** for a one-off scheduled demo. The unique index means
   you must clear the old holder first, in one transaction:
   ```sql
   begin;
   update clients set phone_number = null   where slug = 'comfort-air-demo';
   update clients set phone_number = '+12135332469' where slug = 'shopify-store';
   commit;
   -- revert afterwards by running it in reverse
   ```
   In ElevenLabs you must also reassign the number to the orders agent. **This breaks the
   Comfort Air scheduling demo while it's in effect.**

One number cannot serve two tenants at once — ElevenLabs binds a number to one agent, and
`resolve_client_by_number` maps a number to one client. Don't try to work around that; it's
the invariant that prevents tenant misrouting.

---

## 2. What is BUILT (all uncommitted — see §7)

| Thing | Where | Verified |
|---|---|---|
| Shopify order lookup | `functions/voice-order-lookup/{lib,index}.ts` | 141 unit checks |
| Web slug routing + caller verification | same | included above |
| Usage metering + caps | `migrations/0012_voice_usage_caps.sql` | SQL suite, real PG16 |
| Staleness fix (the WISMO bug) | `migrations/0013_stale_exempt_statuses.sql` | SQL suite, real PG16 |
| Limiter layer 3 (mid-call wrap-up) | `voice-order-lookup/index.ts` | — |
| Limiter layers 1 & 4 (logic only) | `voice-personalization/lib.ts`, `voice-call-logger/lib.ts` | 42 unit checks |
| **Tickets + callbacks** | `migrations/0014_tickets_callbacks.sql` | applied + smoke-tested |
| **`request_callback` tool** | `functions/voice-ticket/{lib,index}.ts` | parses; helpers sanity-checked |
| Shopify policy fetcher | `scripts/fetch-shopify-policies.mjs` | — |

### Test commands

```bash
npx tsx scripts/test-voice-lookup-shopify.ts    # 141
npx tsx scripts/test-limiter-helpers.ts         # 42
npx tsx scripts/test-voice-logger.ts            # pre-existing
psql "$DATABASE_URL" -f scripts/test_voice_usage_caps.sql
psql "$DATABASE_URL" -f scripts/test_evaluate_flag_stale.sql
```

All SQL suites roll themselves back. **A local Postgres is enough** — no Supabase needed: PG16
plus a shim creating roles `service_role`/`authenticated`/`anon`, schema `auth` with
`auth.users` + `auth.uid()` reading `request.jwt.claim.sub`, and schema `vault` with a
`decrypted_secrets` table. Then apply `0001/0002/0005/0006` and whatever is under test.

---

## 3. Non-obvious things that will bite you

Ordered by how much time they'll cost if rediscovered.

1. **The secrets RPC returns Shopify creds under the key `"woocommerce"`.**
   `get_client_integration_secrets` (migration `0002`) predates Shopify: it reads the generic
   `clients.store_credentials_ref` but labels the result `woocommerce` for every platform.
   `pickShopifyCreds()` accepts `shopify` → `store` → `woocommerce`. Reading only
   `secrets.shopify` silently yields **no credentials** and looks like a Vault problem.

2. **ElevenLabs sends every tool parameter on every call, filling unused ones with EMPTY
   STRINGS.** Phone arrives as `{called_number:"+1…", client_ref:""}`, web as
   `{called_number:"", client_ref:"slug"}`. Treating `""` as present routes a web call down
   the phone path and 400s. `extractClientRef()` handles it — reuse it, don't reimplement.

3. **A browser call has no Twilio call SID.** Use the ElevenLabs conversation id as the
   idempotency key (`usageKeyFor`, `buildExternalRef`). Without this, web calls are
   unmeterable and un-ticketable.

4. **Every new VIEW needs `with (security_invoker = true)`.** Migration `0001` ends with
   `alter default privileges ... grant select, insert, update, delete on tables` — and in
   Postgres that covers **views**. So every new view is auto-granted to `authenticated`, and a
   plain view runs with its *owner's* rights, bypassing RLS. A usage view built without this
   returned all four tenants' rows to a signed-in user. Cross-tenant/aggregate views must
   also be explicitly `revoke`d.

5. **Shopify `name:1001` is a token match, not exact** — it also returns `#1001-A`. Always
   exact-match the name afterwards (`pickExactOrder`), or you'll read a stranger's order out
   loud.

6. **Shopify GraphQL returns HTTP 200 for query errors and throttling.** Check the body
   (`shopifyErrorFrom`) or you'll treat an error as an empty result.

7. **`read_orders` only reaches back 60 days.** Older orders need `read_all_orders`, which
   requires Shopify approval and is not instant. **Demo with recent orders.**

8. **Voice and email write the SAME `orders_cache` row** on `(client_id, order_number)`. The
   Shopify query/mapping in `voice-order-lookup/lib.ts` is deliberately aligned field-for-field
   with the production email Zap — API version **2026-04**, line items from `title` +
   `originalUnitPriceSet`, `customer.email` before order email, `shipping_status` from
   `fulfillment.status`. **Bump the API version in both channels together, never one alone.**

9. **Idempotent RPCs must REPORT duplicates, not swallow them.** `record_call_usage` and
   `create_ticket` both return a `duplicate` flag. A silent `on conflict do nothing` is what
   made agent replies vanish from the dashboard on the email side; a silent double-count would
   falsely trip a usage cap and take a client's line down.

10. **CRLF phantom diffs.** `git status` will show ~35 files modified with zero real changes.
    Always check `git diff --stat --ignore-cr-at-eol` before believing it. Details in
    `docs/COMMIT-CHECKLIST.md` §1.

11. **Files have silently disappeared from the repo folder after a successful write** (six of
    them on 2026-07-29, including the CFO xlsx). Cause unknown — possibly `git clean`/`git
    stash -u`, possibly OneDrive. **If a build fails with "module not found", check the file
    exists before debugging the code.** Getting this into git is the real fix.

---

## 4. Decisions already made (don't relitigate)

| Decision | Rationale |
|---|---|
| Tsunami demo on **tsunami.store web widget**, live Shopify data | J built and maintains that site |
| **Caller verification required on web** (email or ZIP) | a public page is otherwise an unauthenticated API over the order book |
| **Separate ElevenLabs agent for orders** | the demo agent has a hardcoded Comfort Air HVAC prompt; agents are free, billing is per minute |
| **Claude, not Gemini**, across the product | changed 2026-07-29 |
| **No LLM call for status normalization in voice** | the email Zap uses Gemini for this; mid-call that's dead air. `normalizeStatus()` encodes the same rules deterministically |
| **No SMS, ever, for this client** | Twilio prohibits cannabis/CBD messaging; voice is exempt |
| **No AI-placed outbound callbacks** | TCPA exposure + it's a cost loop we control. Schema supports it, switched off |
| **100 voice minutes/month** for Tsunami | it's the CFO model's Starter tier (`$149/mo`, `B13`) |
| **2-minute call policy**, `max_call_secs` 180 | CFO model `B15`, listed *Required, before Tsunami*. Earlier 300s/420s recommendations are **withdrawn** |
| Extend `review_queue`, don't build a `tickets` table | two inboxes that disagree |

---

## 5. NEXT STEPS — in order

### 5a. Make the demo work (current focus)

1. **Deploy what exists.**
   ```bash
   supabase db push          # applies 0012, 0013, 0014
   supabase functions deploy voice-order-lookup --no-verify-jwt
   supabase functions deploy voice-ticket --no-verify-jwt
   ```
2. **Shopify credentials into Vault** (read-only custom app: `read_orders`,
   `read_fulfillments`):
   ```sql
   select vault.create_secret(
     '{"access_token":"shpat_…","base_url":"https://tsunami-store-7957.myshopify.com"}',
     'shopify-store_shopify');
   update clients set store_credentials_ref = 'shopify-store_shopify'
    where slug = 'shopify-store';
   ```
3. **Enable the web path** — the `web_lookup_enabled` update in §1.
4. **Apply the staleness fix to Tsunami's rules** (this is what stops every WISMO call
   escalating):
   ```sql
   update clients set abnormal_status_rules = jsonb_build_object(
     'abnormal_statuses', jsonb_build_array('ON_HOLD','RESTOCKED','REFUNDED','VOIDED','PARTIALLY_REFUNDED'),
     'stale_after_hours', 48,
     'stale_exempt_statuses', jsonb_build_array('FULFILLED','PARTIALLY_FULFILLED'))
    where slug = 'shopify-store';
   ```
   ⚠️ `evaluate_flag` is shared with the **live email agent** — this changes email behavior for
   Tsunami too (it stops sending holding replies about shipped-but-old orders). Intended, but
   deliberate.
5. **Fill the empty config**: `business_hours` (currently `{}` — confirm timezone) and
   `settings.policies` (condense from `brand_tone_config.custom_instructions`, or pull with
   `scripts/fetch-shopify-policies.mjs`; keep it ~150 words, it's re-sent every turn).
6. **ElevenLabs — new orders agent**: paste the prompt, add tools `lookup_order`
   (with `client_ref`, `verify_email`, `verify_zip`), `request_callback`, `end_call`. Set the
   post-call webhook to `voice-call-logger`. LLM = Claude. Enable per-field conversation
   overrides in Agent → Security.
7. **Dashboard**: surface the new ticket fields on `/review-queue` — ticket number, callback
   number with a `tel:` link, and the `callbacks_due` view. **This is the last piece needed
   for the demo story** ("caller asks for a human → it appears here").
8. **Embed** on tsunami.store behind the age gate.

### 5b. Parked (built or specced, deliberately not now)

- Wiring limiter layers 1 & 4 — the two `index.ts` inserts in `docs/LIMITER-WIRING.md`.
- The 2-minute call policy prompt.
- `lookup_order.json` / `request_callback.json` for `docs/elevenlabs-tools/`.
- `.gitattributes` (CRLF fix).
- Testing pass — explicitly deferred by J on 2026-07-29.

---

## 6. Where things live

| File | What |
|---|---|
| `docs/PROJECT-STATUS.md` | **this file — start here** |
| `docs/COMMIT-CHECKLIST.md` | git state, CRLF trap, suggested commits |
| `docs/tsunami-voice-orders-plan.md` | the full original plan + cost model |
| `docs/tsunami-config-and-limits-reassessment.md` | per-client config SQL, caps, the staleness finding |
| `docs/tsunami-web-demo-checklist.md` | web embed checklist |
| `docs/cfo-hub-developer-inputs.md` | CFO model review + the cells J owns |
| `docs/LIMITER-WIRING.md` | the two remaining index.ts inserts |
| `docs/email-agent-zap-build.md` | how the live email channel works |

---

## 7. Repo state

**Nothing is committed.** On `main`, last commit `82b11d5 Demo widget restored`. Roughly 4
files with real changes plus ~20 new ones; ~35 more show as modified but are CRLF-only noise.

`docs/COMMIT-CHECKLIST.md` has the full procedure — but note its §5 file lists are **stale**:
`0013`, `0014`, `voice-ticket/`, `test_evaluate_flag_stale.sql`, `test-limiter-helpers.ts` and
`LIMITER-WIRING.md` all landed after it was written.

Given files have already vanished from this folder once, **committing is now the highest-value
housekeeping task**, not a formality.
