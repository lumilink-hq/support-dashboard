# Tsunami Web Demo on tsunami.store — Checklist

**2026-07-29.** Plan: embed the voice demo on a page on tsunami.store, reusing the existing
demo agent/number for now.

Read §0 first. Two items there are hard blockers that no amount of config will get around,
and one is a decision only you can make.

---

## §0 — Blockers and decisions, before any work starts

### 0.1 ❌ The demo number cannot be moved to Tsunami — and doesn't need to be

`+12135332469` belongs to `comfort-air-demo`. Migration `0010_client_phone_unique.sql`
enforces **one client per phone-number-digits**, so `update clients set phone_number =
'+12135332469' where slug='shopify-store'` will fail with a unique violation. That
constraint exists because this exact collision already happened once — two clients shared
that number, `resolve_client_by_number` returned an arbitrary one, and the scheduling demo
served empty slots.

**The good news: a browser widget has no dialed number at all.** Web calls route by client
**slug**, not phone number. So the demo number is irrelevant to a tsunami.store embed — it
only matters if you also want a callable phone line. Don't fight the constraint; the web
path doesn't need it.

### 0.2 ❌ `voice-order-lookup` is not slug-aware — this is the one real code task

The function hard-requires `called_number` and returns `400 Missing called_number` without
it. A browser call can't supply one. `scheduling` and `voice-personalization` already solved
this (they accept `client_ref` / `client_slug`), but the order lookup never got the same
treatment — it was phone-only by design.

**Nothing else on this list works until this lands.** Detail in §1.1.

### 0.3 ⚠️ DECISION: real order data on a public page, or demo data?

This is the item I'd escalate before writing any code.

On the phone there's caller ID, a phone bill, and social friction. **On a public web page, a
live order lookup is an unauthenticated API to their order database, in natural language.**
Anyone can try `1001`, `1002`, `1003`… and get back customer names and order contents — for
a store whose stated selling point is discreet shipping of hemp products.

Three options:

| Option | Risk | Demo quality |
|---|---|---|
| **A. Canned demo dataset** (recommended) | None | **Better** — repeatable, you script the story, no "sorry, that order isn't found" on stage |
| **B. Live data + two-factor** — require order number **and** matching email/zip before returning anything | Low-ish | Real, but callers fumble two identifiers |
| **C. Gated page** — unlisted URL or password, not public | Low | Real data, but it's not a marketing page any more |

**Recommendation: A.** For a marketing page, a canned dataset is genuinely the better
product decision, not just the safer one — you control which scenarios visitors see
(shipped, in transit, refunded) instead of hoping their random guess lands somewhere
interesting. The existing `MOCK_STORE=1` path already does most of this.

> The `is_demo` guard makes this concrete: slug routing is deliberately restricted to
> `settings.is_demo = true` so the public widget can't reach a real client's data. Marking
> the real Tsunami row `is_demo = true` to make the widget work would disable the exact
> protection that guard exists for. **Create a separate `tsunami-demo` client row instead.**

### 0.4 ⚠️ Age gate

tsunami.store requires age verification to purchase. A voice widget that discusses their
products should sit **behind** that gate, not on a pre-gate landing page. Worth confirming
with them before choosing which page it goes on.

---

## §1 — Backend

- [ ] **1.1 Make `voice-order-lookup` slug-aware.** Mirror the pattern already in
      `scheduling/index.ts` and `voice-personalization`:
  - Accept `client_ref` / `client_slug` in the request body.
  - Resolve tenant by `called_number` when present, else by slug.
  - **Guard the slug path to `settings.is_demo = true`** — same as scheduling. A slug must
    never reach a non-demo client's live store credentials.
  - Extend `scripts/test-voice-lookup-shopify.ts` with the phone-shape and web-shape
    extraction cases (`test-voice-personalization.ts` has the reference tests for this).
- [ ] **1.2 Decide the data source per §0.3.** If option A, point the demo client at the
      mock path rather than live Shopify credentials — no token, no live orders, nothing to
      leak.
- [ ] **1.3 Confirm `voice-call-logger` handles a web session.** It already reads
      `clientSlug` from dynamic variables (`CallFields.clientSlug` exists in its `lib.ts`),
      but a browser call has no Twilio call SID — verify the conversation ref and the
      `record_call_usage` call still key correctly, or usage won't meter.
- [ ] **1.4 Deploy:** `supabase functions deploy voice-order-lookup --no-verify-jwt`, plus
      `db push` for `0012` if not already applied.

## §2 — Data / config

- [ ] **2.1 Create a `tsunami-demo` client row** (separate from `shopify-store`):
      `is_demo = true`, `store_platform = 'shopify'`, **no** `store_credentials_ref` if using
      mock data, `phone_number = null`.
- [ ] **2.2 Copy the brand voice + condensed policy blob** from the real row so the demo
      sounds like Tsunami.
- [ ] **2.3 Set `voice_caps` on the demo row** — this is what makes the demo budget real
      rather than aspirational (see §4).
- [ ] **2.4 Leave the real `shopify-store` row untouched.** `is_demo` stays false/absent.

## §3 — ElevenLabs

- [ ] **3.1 Use a separate agent for the orders demo.** The existing demo agent carries the
      hardcoded Comfort Air HVAC scheduling prompt — repointing it breaks the scheduling
      demo. Agents are free; you're billed per minute.
- [ ] **3.2 Add `client_ref: {{client_slug}}` to the `lookup_order` tool body**, alongside
      the existing `called_number: {{system__called_number}}`. Phone sets the number and an
      empty slug; web sets the slug and an empty number.
- [ ] **3.3 Enable per-field conversation overrides** in Agent → Security if you want the
      personalization webhook driving the prompt — the call errors if overrides aren't
      enabled per field.
- [ ] **3.4 Set the 2-minute call policy in the prompt** (see §5 — this is the CFO model's
      "Required / before Tsunami" item, and it's a prompt change, not just a timer).
- [ ] **3.5 Confirm concurrency headroom.** Pro allows 20 concurrent calls; a public page
      can spike in a way a phone line never does.

## §4 — Cost control (the part a public page makes urgent)

A public storefront widget invites **curiosity clicks**, not support calls. Every "what's
this?" costs minutes, and per the CFO model those are **LumiLink-paid** (Assumptions B59),
not billed to Tsunami.

- [ ] **4.1 Cap the demo client row.** `0012` is what turns the demo budget into a hard
      number instead of a hope:
      ```sql
      update clients set settings = settings || jsonb_build_object('voice_caps',
        jsonb_build_object('monthly_minutes', 200, 'daily_minutes', 20,
                           'max_call_secs', 180, 'enabled', true))
       where slug = 'tsunami-demo';
      ```
      200 min ≈ **$16/month** at $0.08 (no Twilio cost on browser calls). `daily_minutes: 20`
      means a link going viral costs you $1.60 that day, not $300.
- [ ] **4.2 Set Assumptions **B59** to the same number.** Then the CFO model's demo line is
      true *by construction* rather than by forecast — see the sheet notes doc.
- [ ] **4.3 Wire the pre-call gate** (`check_voice_allowance` in `voice-personalization`) —
      without it the caps are recorded but not enforced.
- [ ] **4.4 Make the over-cap deflect message demo-appropriate**: "our live demo is at
      capacity for today, please try tomorrow or contact us" — not the customer-support
      wording.

## §5 — The 2-minute call policy

The CFO model lists this as **Required, owner Developer, timing "before Tsunami"** — and it
sets `Calls at cap = minutes ÷ 2`, so the entire revenue model assumes it.

Implement it as **prompt policy first, timer second**:

- [ ] **5.1 Prompt:** at ~90 seconds, the agent gives a soft warning; at ~2 minutes it
      confirms and converts to a callback ticket, transfer, or a clean close.
- [ ] **5.2 `max_call_secs: 180`** as the *backstop*, not the mechanism. I previously
      recommended 300s and then 420s — **both are withdrawn.** With a 2-minute wrap-up
      policy doing the work, a 3-minute hard stop only fires when the policy has already
      failed, so it never cuts someone off mid-sentence.
- [ ] **5.3 Shorten the callback capture** to fit: default to the number they're calling
      from and confirm once, rather than collecting and reading back digits.

## §6 — Website embed

- [ ] **6.1 Page choice** — behind the age gate (§0.4); a support/help page rather than the
      homepage.
- [ ] **6.2 Pass the slug**: `dynamic-variables='{"client_slug":"tsunami-demo"}'`, the same
      shape `/demo` already uses from `?client=<slug>`.
- [ ] **6.3 Set expectations in the surrounding copy** — "AI demo", what it can answer, and
      a sample order number if using canned data. Half of demo quality is the frame around it.
- [ ] **6.4 Mic permission**: browsers require a user gesture; make sure the widget isn't
      auto-starting.
- [ ] **6.5 Mobile check.** A storefront's traffic is mostly phones, and a voice widget on
      mobile behaves differently from desktop.

## §7 — Test before it's public

- [ ] **7.1** Slug routing reaches the demo client, and a **real** client slug is rejected by
      the `is_demo` guard. Test the rejection explicitly — that's the guard that matters.
- [ ] **7.2** The 2-minute policy fires: warning → confirm → clean exit.
- [ ] **7.3** Over-cap deflect: set `monthly_minutes: 1`, confirm the message plays and the
      call ends, then restore.
- [ ] **7.4** The call appears in the dashboard with a transcript, and `voice_usage_current`
      increments.
- [ ] **7.5** Concurrency: two browsers at once.
- [ ] **7.6** If using live data (option B/C), verify the two-factor check actually blocks a
      wrong email — the failure mode is silent and severe.

## §8 — Not in scope, deliberately

- No SMS anywhere — Twilio prohibits cannabis/CBD messaging in the US/CA regardless of state
  law. Voice is explicitly exempt. Keep any number voice-only.
- No AI outbound callbacks (TCPA + cost loop).
- The real Tsunami phone line is a separate track — it needs its own number, and the demo
  number can't serve it.

---

## Sequencing

**Blocked until §0.3 is decided.** Then: §1.1 (slug routing) → §2 (demo row) → §3 (agent) →
§4 (caps + gate) → §5 (2-min policy) → §7 (test) → §6 (embed).

§1.1 and §5 are the only real engineering. Everything else is config, and §4 is fifteen
minutes that prevents an unbounded bill.
