# Lumilink — Project Status

**Updated 2026-08-03.** This is the handover document. If you are a new Claude session,
or J on a different machine: **read this file first**, then only the linked docs you need.

The previous version of this file was written 2026-07-29 and had gone badly stale — it
stopped at migration `0014`, called the callbacks dashboard "the last build item" (it
shipped), and pointed at a Comfort Air demo that has since been retired. If something
here disagrees with an older doc, this file wins. `docs/FEATURE-GAPS.md` (2026-08-03) is
the companion: this one is what exists, that one is what's missing.

---

## 0. Orientation in 60 seconds

Lumilink is a multi-tenant AI customer-support platform. Next.js dashboard + Supabase
(Postgres/RLS/Vault) + ElevenLabs voice agents + Stripe.

- **Voice — the product.** ElevenLabs Agents + native Twilio (no media server). Supabase
  Edge Functions do all the work; **Zapier is not involved in voice at all.**
- **Email — live in production, hidden in the UI.** The Zapier pipeline still runs
  (Gmail → resolve client by `+<slug>` plus-address → store + shipping → Claude → send →
  log). The dashboard tab and sidebar chip are hidden while the channel is paused;
  existing threads still appear under All, and `?channel=email` still works if you
  navigate to it directly.

Supabase project ref `xqsxjxrzpxhosedkmufg`. Functions base URL
`https://xqsxjxrzpxhosedkmufg.functions.supabase.co/<fn>`.

### Tenants

| Tenant | Slug | Platform | State |
|---|---|---|---|
| Tsunami | `shopify-store` | Shopify | active — the real client |
| Bud Club | `budmember001` | WooCommerce | configured; no phone exists |
| Northlake Supply | `northlake-demo` | fictional | demo tenant, `supabase/seed/demo_orders_client.sql` |
| Comfort Air | `comfort-air-demo` | HVAC scheduling | **retired**, dormant not deleted |

> **Tsunami sells THCA flower and hemp products.** Twilio **prohibits cannabis/CBD SMS**
> in the US/CA regardless of state law — Programmable **Voice is explicitly exempt**. So
> no SMS anywhere in this product for this client. Note this is client-specific: SMS is
> fine for HVAC/trades tenants if the scheduling side is ever revived. And discretion is
> Tsunami's selling point, so the agent must not read order contents to an unverified
> caller.

---

## 1. What is built

### Backend — migrations `0001`–`0030`

| Area | Migrations | State |
|---|---|---|
| Core schema, RLS, email integration | `0001`–`0005` | live |
| Voice integration (resolve/ingest/log) | `0006` | live |
| Scheduling + reschedule/cancel | `0007`, `0009` | built, **dormant** |
| Entitlements + billing + event ordering | `0008`, `0011`, `0015`, `0026` | live |
| Phone uniqueness | `0010` | live |
| Usage caps + metering | `0012`, `0025`, `0027` | live |
| Order staleness (the WISMO fix) | `0013` | live |
| Tickets + callbacks | `0014`, `0016` | live |
| Order number prefix / Woo scheme | `0017`, `0022` | live |
| Product cache, search, stock, deals | `0018`–`0021`, `0023`, `0024` | live |
| Entitlement gate on voice | `0028` | committed — **verify it's applied** |
| Config timezone + escalation mode | `0029` | uncommitted |
| Strip support email from policies | `0030` | uncommitted |

### Edge functions — 11

`voice-order-lookup` · `voice-product-lookup` · `voice-personalization` ·
`voice-call-logger` · `voice-ticket` · `product-sync` · `scheduling` ·
`billing-webhook` · `provision-feature` · `zapier-upsert-allowlist` ·
`shopify-product-sync` *(renamed to `product-sync` — delete the old deployed copy)*

### Dashboard — 7 pages, all shipped

`/conversations` (+ detail with transcript and an `<audio>` element ready for
recordings) · `/appointments` · `/leads` · `/review-queue` · `/services` · `/settings` ·
`/billing`. Marketing: `/home`, `/plans`, `/preview`, `/demo/orders`, `/demo/hvac`
(parked), `/login`, `/signup`.

**`/review-queue` is complete**, contrary to the old status doc: a Callbacks-due tab
reading the `callbacks_due` view, `tel:` click-to-call, attempt logging through
`record_callback_attempt`, ticket-number chips, and an overdue counter badge.

**`/billing` is complete**: plan state from `entitlements`, a live minutes meter off
`voice_usage_current`, overage disclosure, and tenant-routed checkout.

### Billing — live

Stripe is wired end to end and **a real purchase has completed**. Prices, products and
the Starter Payment Link are recorded in `docs/STRIPE-GO-LIVE.md`. Only Starter is
self-serve; Growth and Scale are sales-assisted because `billing_price_map` is
feature-level — buying Scale today would grant the same `voice` entitlement as Starter
and provision 100 minutes instead of 600.

### Usage limiter — all four layers wired (verified 2026-08-03)

Layer 1 in `voice-personalization`, layer 2 as `default_max_call_secs` = 105, layer 3 in
`voice-order-lookup`, layer 4 in `voice-call-logger`. See `docs/LIMITER-WIRING.md`.
**Caps are deliberately not set**, so nothing currently enforces a limit — that was the
decision on 2026-07-29 so nothing could accidentally block the demo.

### Tests — 9 suites, all green on 2026-08-03

```bash
node --experimental-strip-types scripts/test-voice-lookup-shopify.ts   # orders, both platforms
node --experimental-strip-types scripts/test-product-sync.ts           # 156
node --experimental-strip-types scripts/test-product-lookup.ts         # 119
node --experimental-strip-types scripts/test-voice-personalization.ts  # 86
node --experimental-strip-types scripts/test-limiter-helpers.ts        # 42
node --experimental-strip-types scripts/test-voice-logger.ts
node --experimental-strip-types scripts/test-route-access.ts
node --experimental-strip-types scripts/test-contact-rule.ts
node --experimental-strip-types scripts/test-order-date-tz.ts
psql "$DATABASE_URL" -f scripts/test_voice_usage_caps.sql
psql "$DATABASE_URL" -f scripts/test_evaluate_flag_stale.sql
```

`npx tsx` also works but needs a network install. All SQL suites roll themselves back;
**a local Postgres is enough** — PG16 plus a shim creating roles
`service_role`/`authenticated`/`anon`, schema `auth` with `auth.users` + `auth.uid()`
reading `request.jwt.claim.sub`, and schema `vault` with a `decrypted_secrets` table.
Then apply `0001/0002/0005/0006` and whatever is under test.

---

## 2. Non-obvious things that will bite you

Ordered by how much time they'll cost if rediscovered.

1. **Editing an applied migration changes nothing.** `supabase db push` skips anything
   already in `schema_migrations`. `0025` was applied saying 180s, edited to 105
   afterwards, and production kept 180 — silently, for days. `0027` exists only to fix
   that. Migrations are immutable history; a value change needs a new file.

2. **The secrets RPC returns Shopify creds under the key `"woocommerce"`.**
   `get_client_integration_secrets` (`0002`) predates Shopify: it reads the generic
   `clients.store_credentials_ref` but labels the result `woocommerce` for every
   platform. `pickShopifyCreds()` accepts `shopify` → `store` → `woocommerce`. Reading
   only `secrets.shopify` silently yields no credentials and looks like a Vault problem.

3. **ElevenLabs sends every tool parameter on every call, filling unused ones with EMPTY
   STRINGS.** Phone arrives as `{called_number:"+1…", client_ref:""}`, web as
   `{called_number:"", client_ref:"slug"}`. Treating `""` as present routes a web call
   down the phone path and 400s. `extractClientRef()` handles it — reuse it.

4. **`supabase-js` returns RPC errors in `error`, it does not throw.** A `try/catch`
   around an RPC catches nothing, and the failure branch never runs. Check `error`
   explicitly. This is why the layer-1 gate is written the way it is.

5. **A browser call has no Twilio call SID.** Use the ElevenLabs conversation id as the
   idempotency key (`usageKeyFor`, `buildExternalRef`). Without this, web calls are
   unmeterable and un-ticketable.

6. **Every new VIEW needs `with (security_invoker = true)`.** `0001` ends with
   `alter default privileges … grant select, insert, update, delete on tables` — in
   Postgres that covers **views**. So every new view is auto-granted to `authenticated`,
   and a plain view runs with its *owner's* rights, bypassing RLS. A usage view built
   without this returned all four tenants' rows to a signed-in user. Cross-tenant or
   aggregate views must also be explicitly `revoke`d.

7. **The `is_active` / unique-index trap.** `resolve_client_by_number` (`0006`) filters
   on `is_active`, but `uq_clients_phone_digits` (`0010`) is
   `where phone_number is not null` with **no `is_active` filter**. So a deactivated
   client still holds its number, and reassigning it fails with a unique violation.
   Correct order, one transaction: null the old holder's phone → set `is_active=false` →
   assign to the new tenant. Verify with:
   ```sql
   select slug, is_active, phone_number from clients where phone_number is not null;
   ```

8. **Shopify `name:1001` is a token match, not exact** — it also returns `#1001-A`.
   Always exact-match afterwards (`pickExactOrder`), or you'll read a stranger's order
   out loud.

9. **Shopify GraphQL returns HTTP 200 for query errors and throttling.** Check the body
   (`shopifyErrorFrom`) or you'll treat an error as an empty result.

10. **`read_orders` only reaches back 60 days.** Older orders need `read_all_orders`,
    which requires Shopify approval and is not instant. **Demo with recent orders.**

11. **Voice and email write the SAME `orders_cache` row** on `(client_id, order_number)`.
    The Shopify mapping in `voice-order-lookup/lib.ts` is deliberately aligned
    field-for-field with the production email Zap. **Bump the API version in both
    channels together, never one alone.**

12. **Idempotent RPCs must REPORT duplicates, not swallow them.** `record_call_usage` and
    `create_ticket` both return a `duplicate` flag. A silent `on conflict do nothing` is
    what made agent replies vanish from the dashboard on the email side; a silent
    double-count would falsely trip a usage cap and take a client's line down.

13. **`settings.policies` is surfaced verbatim as `{{store_policies}}`** — anything
    written there is fair game for any question the caller asks. A support address in
    that blob got read out on a live call even though `escalation_mode` was `callback`
    (`0030`). `escalation_mode` governs what the agent *does*, not what it *knows*.

14. **CRLF phantom diffs.** `git status` shows files modified with zero real changes.
    Check `git diff --stat --ignore-cr-at-eol` before believing it.

15. **Files have silently disappeared from this folder after a successful write** (six on
    2026-07-29, including the CFO xlsx). Cause unknown — possibly `git clean`/`git stash
    -u`, possibly OneDrive. **If a build fails with "module not found", check the file
    exists before debugging the code.**

16. **Railway builds from the pushed commit, not your working tree.** Three import pairs
    break the build if committed apart — `docs/DEPLOY-CHECKLIST.md` lists them. `git
    commit -a` does not pick up untracked files, and new files are the usual casualty.

---

## 3. Decisions already made (don't relitigate)

| Decision | Rationale |
|---|---|
| **Claude, not Gemini**, across the product | changed 2026-07-29 |
| Tsunami demo on **tsunami.store web widget**, live Shopify data | J built and maintains that site |
| **Caller verification required on web** (email or ZIP) | a public page is otherwise an unauthenticated API over the order book |
| **`web_lookup_enabled`, never `is_demo`, on a real client** | `is_demo` disables the guard keeping the public widget away from real customer data |
| **Separate ElevenLabs agent per use case** | prompts and tools are disjoint; agents are free, billing is per minute |
| **No LLM call for status normalization in voice** | mid-call that's dead air; `normalizeStatus()` encodes the same rules deterministically |
| **No SMS for Tsunami** | Twilio prohibits cannabis/CBD messaging; voice is exempt |
| **No AI-placed outbound callbacks** | TCPA exposure + a cost loop we control. Schema supports it, switched off |
| **2-minute call policy**, ceiling 105s | CFO model `B15`; earlier 180s/300s recommendations are withdrawn |
| Extend `review_queue`, don't build a `tickets` table | two inboxes that disagree |
| **Retire Comfort Air** (2026-07-29) | one demo to focus on; scheduling data dormant, not deleted |
| **Escalation defaults to callback, not email** (`0029`) | the email channel is paused — pointing a caller at that inbox sends them nowhere |
| Only **Starter** is self-serve | `billing_price_map` is feature-level; a Scale purchase would provision Starter's 100 minutes |

---

## 4. Next steps

Full analysis in **`docs/FEATURE-GAPS.md`**. The short version, in order:

### Now

1. **Commit the tree.** 12 modified files and ~20 untracked, including migrations `0029`
   and `0030`. Given §2.15, this is the highest-value housekeeping task, not a
   formality. Follow `docs/DEPLOY-CHECKLIST.md` A1 — the import pairs go together.
2. **Verify `0028` is applied, not just committed.** Until it is, a cancelled client's
   phone still answers and burns ElevenLabs and Twilio minutes you can't bill.
   Also confirm `select default_max_call_secs from platform_settings;` returns 105.
3. **Resend integration.** There is no email-sending code anywhere in the repo. It
   unblocks three things at once: Supabase Auth SMTP (currently shared, rate-limited,
   lands in spam), the `crossed_warning` 80%-usage alert that fires and reaches nobody,
   and overdue-callback notifications.
4. **Sentry** on the Next app and at minimum `billing-webhook`, `voice-personalization`,
   `voice-order-lookup`. Note the Deno SDK does not instrument `Deno.serve`, so there's
   no scope separation between requests — use `Sentry.withScope()` and keep tenant ids
   out of global tags.
5. **Uptime check on the phone path.** If `voice-personalization` fails, calls still
   connect and the agent answers with the generic fallback prompt. Nothing else will
   tell you.

### Next

6. **Onboarding wizard** (`docs/onboarding-plan.md`, designed, nothing built). Today a
   client pays and provisioning parks at `needs_human` for "no phone number set." The
   Twilio buying half already exists in `provision-feature`; what's missing is number
   search, selection, and re-queueing the parked task.
7. **Website knowledge sync** — sold in `FEATURES`, on the landing page, on `/plans` and
   in the CFO model; implemented nowhere. Build the minimal version or cut the claim.
8. **Number release policy.** `0028` stops a cancelled line answering; nothing stops the
   Twilio number costing $1.15/month forever.

### Then

9. `/insights` page — calls, avg duration, deflection rate, escalations by reason.
10. `/conversations` search + pagination (it currently selects every row).
11. Team invites, then review-queue assignment (`review_queue.assignee` has existed
    since `0001` and no UI surfaces it).

---

## 5. Where things live

| File | What |
|---|---|
| `docs/PROJECT-STATUS.md` | **this file — start here** |
| `docs/FEATURE-GAPS.md` | what's missing, with ordering |
| `docs/launch-readiness.md` | operational + branding gaps before real traffic |
| `docs/DEPLOY-CHECKLIST.md` | the Railway build trap and the commit pairs |
| `docs/STRIPE-GO-LIVE.md` | prices, payment link, webhook metadata |
| `docs/DEMO-SWITCH-ON.md` | turning the Northlake demo on once a number exists |
| `docs/onboarding-plan.md` | the wizard design |
| `docs/LIMITER-WIRING.md` | all four limiter layers, what each does |
| `docs/woocommerce-parity.md` | the seven Woo bugs and the onboarding runbook |
| `docs/TSUNAMI-GO-LIVE.md` | Tsunami runbook (partly historical now) |
| `docs/elevenlabs-tools/*.json` | version-controlled ElevenLabs tool schemas |
| `docs/email-agent-zap-build.md` | how the paused email channel works |
| `docs/COMMIT-CHECKLIST.md` | git state + CRLF trap (§5 file lists are stale) |
