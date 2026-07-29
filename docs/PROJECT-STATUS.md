# Lumilink — Project Status & Next Steps

**Updated 2026-07-29.** This is the handover document. If you are a new Claude session, or J
on a different machine: **read this file first**, then only the linked docs you need.

Goal right now: **a working Tsunami demo.** Call limits are built but deliberately parked —
the ticket system is the priority because it's the only escalation path that exists.

> **→ To finish the build, follow `docs/TSUNAMI-GO-LIVE.md`.** It's the ordered runbook:
> retire Comfort Air, hand over the number, configure, deploy, build the agent. This file is
> the map; that one is the route.
>
> **Decision 2026-07-29: Comfort Air is being retired and the demo number `+12135332469`
> moved to Tsunami.** All resources go to the orders agent. Scheduling data is left intact —
> dormant, not deleted.

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

## 1. THE PHONE NUMBER — one number, one tenant, and the trap in between

**Current plan:** `+12135332469` moves from `comfort-air-demo` to `shopify-store` (Tsunami).
Comfort Air is retired. Exact SQL in `docs/TSUNAMI-GO-LIVE.md` §1.

**The trap that will cost you an hour if you hit it blind.** Two migrations disagree about
what `is_active` means:

- `resolve_client_by_number` (`0006`) **filters on `is_active`** — deactivating a client stops
  it answering calls.
- The unique index `uq_clients_phone_digits` (`0010`) is `where phone_number is not null` and
  has **no `is_active` filter** — a deactivated client *still holds its number*.

So **deactivating Comfort Air does not free the number.** You must set its `phone_number` to
NULL, or Tsunami's `update` fails with a unique violation. And if the number is switched
**only in the ElevenLabs UI**, the database still maps those digits to Comfort Air: calls
route to the wrong tenant, or return "this phone line isn't configured for a store." Verify
with the query in `TSUNAMI-GO-LIVE.md` §0 before debugging anything else.

That constraint exists because the collision already happened once — two clients shared a
number, resolution returned an arbitrary one, and the scheduling demo silently served empty
slots. One number cannot serve two tenants: ElevenLabs binds a number to one agent, and
`resolve_client_by_number` maps it to one client. Don't work around it.

### The web widget needs no number at all

A browser call has no dialed number; `voice-order-lookup` routes by **client slug**. So the
tsunami.store embed works independently of all of the above, and both paths can run at once —
phone by number, web by slug.

```sql
update clients
   set settings = settings || jsonb_build_object('web_lookup_enabled', true)
 where slug = 'shopify-store';
```

**Do NOT set `is_demo = true` on the real Tsunami row** to enable web routing. That flag marks
sandbox tenants, and setting it on a live client disables the guard keeping the public widget
away from real customer data. `web_lookup_enabled` is the explicit, safe opt-in.

### Restoring Comfort Air later

Two `update`s plus reassigning a number in ElevenLabs — rollback SQL is in
`TSUNAMI-GO-LIVE.md` §7. Its `services` and `appointments` data is untouched.

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
| Tool schemas | `docs/elevenlabs-tools/{lookup_order,request_callback}.json` | valid JSON |
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
| **Retire Comfort Air**, move its number to Tsunami (2026-07-29) | one demo to focus on; scheduling data left dormant, not deleted |

---

## 5. NEXT STEPS — in order

### 5a. Make the demo work (current focus)

**Follow `docs/TSUNAMI-GO-LIVE.md`** — it has the SQL, the agent prompt, and the tool config
in order. Summary of the sequence:

| # | Step | Where |
|---|---|---|
| 0 | Verify the number switch actually landed in the DB | GO-LIVE §0 |
| 1 | Retire Comfort Air, hand over the number | §1 |
| 2 | Shopify token → Vault; `web_lookup_enabled`; **staleness rules**; business hours; policy blob | §2 |
| 3 | `db push` + deploy `voice-order-lookup` and `voice-ticket` | §3 |
| 4 | Build the new ElevenLabs orders agent (prompt + 3 tools + post-call webhook) | §4 |
| 5 | **Dashboard: ticket number, `tel:` callback link, `callbacks_due`** — the last build item | §5 |
| 6 | Walk the five call scenarios before demoing | §6 |
| 7 | Embed on tsunami.store behind the age gate | web-demo checklist |

The single highest-impact line in there is the `stale_exempt_statuses` update in §2c. Without
it nearly every "where's my order?" call escalates instead of answering.

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
| `docs/TSUNAMI-GO-LIVE.md` | **the runbook to finish the build** |
| `docs/elevenlabs-tools/*.json` | version-controlled ElevenLabs tool schemas |
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
