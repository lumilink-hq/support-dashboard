# Gated widget via a Shopify custom app — build plan

Status: PLAN, 2026-08-17. Target: the peptide store (one merchant, Shopify).
Companion doc: `docs/restricted-vertical-compliance.md` — read §3 and §4 of that first; this
doc builds the enforcement, not the policy.

Decision taken: **Shopify custom (unlisted) app**, not a public app-store listing. Same proxy
+ theme-extension code either way, so nothing is thrown away when a second merchant appears;
we skip app review, billing API, and multi-merchant install flow for now.

---

## §0 — Why an app, and the one thing it fixes

`components/lumi-widget.tsx` and `app/demo/convai-widget.tsx` both inject
`<elevenlabs-convai agent-id="…">` and load the public embed script. The agent ID is in the
page source. Wrapping that in `{% if customer %}` hides the button and gates nothing —
anyone can paste the ID into their own page and talk to the agent.

The app fixes it in two moves:

1. **ElevenLabs agent set to private** + hostname allowlist. A raw agent ID stops being
   usable. The browser can only connect with a short-lived signed URL (WebSocket) or
   conversation token (WebRTC) minted by our server with our API key. Signed URLs expire
   after 15 minutes.
2. **Shopify app proxy** gives us a trustworthy answer to "is this person signed in" without
   building auth. Shopify forwards the storefront request to our endpoint with `shop`,
   `logged_in_customer_id`, `path_prefix`, `timestamp`, and `signature`; we verify the
   HMAC-SHA256 with the app's shared secret. Nothing the browser claims is trusted.

Theme app extension is the third benefit — merchant-facing toggles in the theme editor, no
Liquid edits, no snippet the client can paste onto the wrong page.

### ⚠️ Phase 0 blocker: which customer accounts?

`logged_in_customer_id` is **not populated for new (passwordless) customer accounts**, and it
is not set for requests originating in customer-account UI extensions. If this store uses new
customer accounts, identity has to come from a session token (the `sub` claim) or the Customer
Account API instead.

**Resolve this before writing any code — it changes §3 entirely.** Check
Settings → Customer accounts in the store admin.

---

## §1 — Data model

Next migration number is **0037**.

### 0037_restricted_vertical.sql

Add to `get_client_config`:

- `requires_customer_auth` — bool, default false. Token mint refuses without a verified
  Shopify customer.
- `compliance_profile` — text, `null` | `'ruo_research'`. Selects the guardrail block.
- `widget_enabled` — bool, default false. The §7 kill switch. Separate from `is_active` so
  killing the widget doesn't kill the phone line.

> ⚠️ **Read `[[feedback-rpc-key-drop]]` before editing this function.** `0029` re-typed the
> `jsonb_build_object` and silently deleted two keys, breaking order lookup for a live caller.
> Copy the existing object verbatim, append, and put the before/after key list in the migration
> comment. Add an assertion to the test script that the returned key set is a superset of the
> previous one.

New table:

```
customer_attestations
  client_id             uuid    not null references clients(id)
  external_customer_id  text    not null   -- Shopify customer id, or session-token sub
  attested_at           timestamptz not null default now()
  attestation_version   text    not null
  consent_text_sha256   text    not null
  primary key (client_id, external_customer_id)
```

RLS on, tenant policy matching the `voice_usage_events` pattern in `0012`. If you add a view
over this, it needs `security_invoker` — see `[[feedback-rls-views]]`.

Also needed: a `shopify_shop_domain` on `clients` so the proxy can resolve `?shop=` → client
row. **Do not reuse `store_base_url`** — that column holds the storefront URL
(`https://shop.example.com`, per `0001`), whereas the proxy sends the admin domain
(`something.myshopify.com`). On a store with a custom domain these differ, and matching one
against the other fails in exactly the case that matters. Add the column, index it, expose it
in `get_client_config`.

### Client row for this tenant

```
slug:                   <peptide-store-slug>
settings.web_lookup_enabled:    true
settings.requires_customer_auth: true
settings.compliance_profile:     'ruo_research'
settings.widget_enabled:         false   (flip at go-live)
settings.is_demo:                false   ← never true on a real client
```

---

## §2 — ElevenLabs setup (manual, do first)

Per `[[advanced-transfers]]`, work that depends on hand-configured ElevenLabs state gets
blocked for weeks. Do this before building against it.

- [ ] Create a **separate agent** for this tenant. Do not reuse the orders agent — it carries
      Tsunami's prompt, and a restricted tenant needs a different base prompt.
- [ ] Set the agent to **private / require authentication**.
- [ ] Add the **hostname allowlist**: the store domain only. Not `*`.
- [ ] Enable **conversation overrides** for the fields `voice-personalization` overrides
      (`prompt`, `first_message`). Overrides are rejected unless enabled per field in the
      agent's security settings — this silently no-ops otherwise.
- [ ] Decide WebSocket (signed URL) vs WebRTC (conversation token) and note it; §3 and §4
      must agree.
- [ ] Add `client_ref` / `verify_email` / `verify_zip` params to the lookup tool if this
      tenant does order lookup — same gap still open for Tsunami per
      `[[tsunami-web-demo]]`.
- [ ] Set `max_call_secs` backstop and the wrap-up policy per §5 of the Tsunami checklist.

---

## §3 — Token mint: `supabase/functions/widget-session`

The whole gate lives here. New edge function, deployed `--no-verify-jwt` (Shopify won't send
a Supabase JWT).

`POST /widget-session` — reached only through the app proxy.

1. **Verify the proxy signature.** Compute HMAC-SHA256 over the query params sorted by key
   and joined **with no delimiter**, using the app's shared secret; constant-time compare
   against `signature`. Note the shape differs from Shopify's webhook/OAuth HMAC — the
   `shopify-api-js` helpers have known issues with proxy requests, so implement it directly
   and unit-test it.
2. **Reject stale requests** — `timestamp` older than 5 minutes.
3. **Resolve tenant** from `?shop=`. 404 on unknown. Refuse if `is_active` or
   `widget_enabled` is false.
4. **Require identity.** If `requires_customer_auth`, `logged_in_customer_id` must be
   non-empty (or a verified session-token `sub` — see the Phase 0 blocker). Empty → 401
   `not_signed_in`.
5. **Require attestation.** Look up `customer_attestations`; missing, or
   `attestation_version` behind current → 403 `needs_attestation` plus the current version so
   the client can render the modal.
6. **Check caps.** Reuse the `0012` limiter — read effective caps, and if over, return
   `over_cap` rather than a token. A browser session that never mints costs nothing, which is
   much better than deflecting mid-call.
7. **Rate limit** per `external_customer_id`: N sessions/day, M/hour. An authenticated
   customer is still an authenticated adversary.
8. **Mint** the signed URL or conversation token from the ElevenLabs API using the key from
   function secrets. Return `{ token, expires_at }` and nothing else.
9. **Never return `agent_id`** for a restricted tenant. It should not appear anywhere in the
   page, the JS bundle, or the network response.

`POST /widget-session/attest` — same signature verification, writes the attestation row with
the current version and consent-text hash. Idempotent on the primary key.

Every rejection path logs a structured reason. Reasons are the only way you'll debug "the
widget doesn't open" for a merchant you can't shell into.

---

## §4 — Shopify custom app

### App config

- App proxy: subpath prefix `apps`, subpath `lumilink`, proxy URL → the `widget-session`
  function URL. Storefront path becomes `/apps/lumilink/*`.
- Scopes: only what's needed. Customer metafield read if attestation is mirrored to Shopify
  (optional — Supabase is the source of truth).
- Store the app's shared secret in Supabase function secrets, never in the repo. See
  `[[repo-git-hygiene]]`.

### Theme app extension (app embed block)

Merchant-facing settings — this is the "toggles" answer:

| Setting | Type | Notes |
|---|---|---|
| Enabled | checkbox | client-side convenience only; §3 step 3 is the real switch |
| Mode | select | voice / chat / both |
| Placement | select | bottom-right, bottom-left, inline anchor |
| Page scope | text | path allowlist, e.g. `/pages/support`, `/account` |
| Launcher label | text | |
| Disclaimer text | — | **not merchant-editable** on a restricted profile; rendered from `compliance_profile` |

The block renders the launcher only when `customer` is present in Liquid. That is UX, so a
signed-out visitor doesn't click a button that 401s — it is *not* the gate.

### Front-end flow

1. Customer signed in, on an allowlisted page → launcher renders.
2. Click → `POST /apps/lumilink/widget-session`.
3. `needs_attestation` → attestation modal → `POST /apps/lumilink/widget-session/attest` →
   retry.
4. Token in hand → open the session. **Verify whether `@elevenlabs/convai-widget-embed`
   accepts a server-minted signed URL / token.** If it doesn't, use `@elevenlabs/client`
   directly with our own launcher UI — plan for this, it's the likely outcome and it changes
   the front-end estimate.
5. Mic permission requires a user gesture; the click is the gesture. Nothing auto-starts.
6. Mobile first — a storefront's traffic is mostly phones.

---

## §5 — Agent behaviour

In `supabase/functions/voice-personalization/lib.ts`:

- Add an agent type (e.g. `'orders_restricted'`) rather than branching inside `'orders'`.
  `'orders'` deliberately sends **no** prompt override so the agent keeps its own prompt;
  the restricted profile must send one, so it needs its own path.
- The override composes: base support instructions + the §3 refusal block from the compliance
  doc + the §5 disclosure first message. Assembled from `compliance_profile`, entirely
  server-side. **No client-supplied text in this block** — per
  `[[onboarding-kb-intake]]`, client input stays out of the prompt.
- `voice-product-lookup`: field allowlist for restricted tenants (name, size, price,
  availability, COA URL). Never `body_html` / `description` / tags.
- `kb-ingest`: source allowlist. Policies, shipping, returns, reviewed FAQ, COA index. Never
  product description bodies. See compliance §4 — this is the largest leak.
- `voice-call-logger`: a browser session has no Twilio SID. The `conversation_id` fallback
  exists (`[[tsunami-web-demo]]`) but has not been confirmed to **meter** — verify
  `record_call_usage` keys correctly and `voice_usage_current` increments, or the caps in §3
  step 6 are guarding nothing.

---

## §6 — Retention & flags

- Migration for compliance flags on conversation rows (Tier 0 trigger, Tier 2 deflection).
- Review-queue filter in `app/(dashboard)/review-queue` for compliance-flagged conversations.
- Retention job: delete restricted-tenant transcripts past the window, with a logged run
  history. Compliance §6.

---

## §7 — Kill switch

`settings.widget_enabled = false` → §3 step 3 refuses every mint immediately. No theme
deploy, no merchant action, no ElevenLabs change. Surface it as a toggle in the dashboard
settings page so it doesn't require a SQL console at the moment you need it.

---

## §8 — Tests

Run `scripts/check-migration-sql.mjs` on `0037` before pushing.

Unit (`scripts/`, following the `test-voice-lookup-shopify.ts` and
`test-voice-personalization.ts` patterns; limiter helpers already have
`test-limiter-helpers.ts` and `test_voice_usage_caps.sql`):

- [ ] Proxy HMAC: valid signature passes; tampered param fails; missing `signature` fails;
      reordered params still pass; stale timestamp fails.
- [ ] Empty `logged_in_customer_id` → 401.
- [ ] Signed in, no attestation → 403 `needs_attestation`.
- [ ] Attestation at an old version → 403.
- [ ] `widget_enabled = false` → refused.
- [ ] Over cap → `over_cap`, no token minted.
- [ ] `get_client_config` returns a superset of the pre-0037 key set.
- [ ] A non-restricted tenant (`requires_customer_auth` absent) is unaffected — the Tsunami
      path must not regress.

Integration, before public:

- [ ] **The test that matters:** clean browser, no session, scrape the page for an agent ID
      and try to connect. Must fail. If it succeeds, the gate is decorative.
- [ ] Direct `POST` to the function URL bypassing the proxy → rejected for missing signature.
- [ ] Signed-in happy path end to end, transcript lands in the dashboard, usage increments.
- [ ] Red-team eval from compliance §8 passes clean.
- [ ] KB grep for Tier 0 vocabulary returns nothing.
- [ ] Mobile Safari + Chrome Android.

---

## §9 — Order of work

1. Phase 0: confirm customer-account type. Blocks §3.
2. §2 ElevenLabs manual setup (long lead time, do in parallel).
3. §1 migration `0037` + client row.
4. §3 `widget-session` + unit tests.
5. §4 custom app: proxy config, then theme extension.
6. §5 agent type, product/KB allowlists.
7. §6 retention & flags.
8. §8 full test pass, then flip `widget_enabled`.

Counsel review of compliance §1–§2 runs alongside 2–6 and gates step 8.
