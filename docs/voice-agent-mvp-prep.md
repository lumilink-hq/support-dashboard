# Phone (Voice) Agent MVP — Prep & Onboarding Runbook

_Lumilink · companion to `email-agent-zap-build.md`. Decisions locked: **ElevenLabs Agents + native Twilio**, **one pilot store**, **warm transfer with callback fallback**._

The good news up front: the database was built voice-ready on day one. `conversations.channel`
already has a `voice` value, `clients.phone_number` exists, `messages.audio_url` exists,
`external_ref` is meant to hold a Twilio call SID, and `review_queue` already allows the
`caller_request` and `no_order_id` reasons. So the phone MVP is **wiring + config + one small
webhook**, not a new data model or a migration to the core tables.

---

## 1. The MVP shape (what we're building)

```
Caller dials the pilot store's number
  → Twilio number (imported into ElevenLabs, native integration — no media server to run)
  → ElevenLabs Agent handles speech-to-text, turn-taking, text-to-speech
      · LLM = Claude Haiku 4.5 via YOUR Anthropic key (custom LLM / BYOK)
      · greets caller, asks for the order number
      · server tool  lookup_order(called_number, order_number)
          → our webhook → resolve client by dialed number → fetch Woo + ShipStation
          → normalize → upsert orders_cache → evaluate_flag → return order + flagged/reason
      · agent answers status / tracking / items / refunds
      · if flagged OR caller asks for a person:
          in business hours → transfer_to_number(human line)   [warm transfer]
          else               → capture callback number → review_queue item [fallback]
  → post-call: transcript (+ optional recording) written to Supabase
  → Dashboard shows the call beside email threads, review queue picks up flags
```

Multi-tenant resolution mirrors email exactly. Email routes by the `+<slug>` plus-address;
voice routes by **the number that was dialed → `clients.phone_number`**. One shared ElevenLabs
agent serves every client, just like one shared Zap serves every client on email.

**Key consequence for onboarding:** any store already onboarded for email keeps its store
credentials, brand/tone, and flag rules. Adding voice for that store is *incremental* — assign a
number, set a transfer line and greeting. No new per-client integration work.

---

## 2. What I need from you

### 2a. Accounts & keys (only you can create these)

- [ ] **Twilio** — create an account, buy one US local number for the pilot, and send me the
  **Account SID** + **Auth Token** (or add me/grant access). One number, ~$1.15/mo + ~$0.0085/min.
- [ ] **ElevenLabs** — an account on a plan that includes **Agents + custom LLM (bring-your-own
  model) + phone-number import**. Send the **API key** and pick a **voice** you like for the store.
  ⚠️ Please confirm your plan tier actually unlocks custom-LLM + phone import (the lower tiers
  gate these); I'll verify against their docs but you own the billing choice.
- [ ] **Anthropic API key** — for Claude Haiku as the custom LLM. Likely the same key you already
  use on the email side; confirm it can take the added call volume.
- [ ] **Supabase** — you already have this. I'll need you to run one new migration and deploy one
  edge function (same as you've done for `0003`–`0005`). Service-role key stays server-side only.

### 2b. Pilot store + business inputs

- [ ] **Confirm the pilot store.** My recommendation: **Bud Club (`woo-store`, WooCommerce)** —
  lookup is a simple REST call by order id (`order_number_scheme = "id"`), the fastest thing to
  prove end-to-end. (Tsunami/Shopify works too; Woo is just the shorter road to a live call.)
- [ ] **Human transfer line** — a real phone number that rings a person during business hours,
  for the warm transfer. Goes in the client config.
- [ ] **Business hours** — already seeded as Mon–Fri 09:00–17:00 America/New_York for Bud Club;
  confirm or correct. This is what decides transfer vs. callback.
- [ ] **Greeting + persona** — how the agent should answer ("Thanks for calling Bud Club, this is…")
  and anything policy-ish it should know: return window, standard shipping times, what it must
  *never* do (e.g. never promise a refund — say a teammate will follow up). This becomes the voice
  agent's system prompt + reuses your existing `brand_tone_config` and `custom_instructions`.
- [ ] **How customers say an order number** — for Woo `id` it's a plain number; confirm there's no
  prefix/format quirk we need to coach the agent to parse from speech.

### 2c. One compliance decision

- [ ] **Call recording: on or off?** If on, we store audio to Supabase and set `messages.audio_url`,
  and the greeting must include a consent line (consent rules vary by state — some are two-party).
  If you're unsure, we ship **recording off** for the MVP (transcripts only) and add it later.
  Transcripts and the caller's number for callbacks are captured either way.

---

## 3. What I'll build in parallel (needs none of your accounts)

I can start these now while you set up Twilio/ElevenLabs — they only touch your Supabase/repo:

1. **`0006_voice_integration.sql`** — small, additive migration, service-role-locked like `0002`:
   - `resolve_client_by_number(p_called_number)` → `client_id` (voice's analog of the `+slug` lookup).
   - `ingest_call(...)` → upsert the `voice` conversation by call SID, return conversation id
     (mirrors `ingest_email`).
   - `log_call_turn(...)` → append a transcript turn (customer/agent/human), optional `audio_url`.
   - Reuses `evaluate_flag`, `apply_flag`, `get_client_config`, `get_client_integration_secrets`
     unchanged.
2. **`voice-order-lookup` edge function** — the webhook ElevenLabs calls as a server tool. It's the
   email Zap's steps 2/5/6/7/8 (resolve secrets → fetch Woo → fetch ShipStation → normalize →
   cache → evaluate flag) packaged as one HTTP call returning the order + `flagged`/`reason`.
   You already have the `supabase/functions/` pattern from `zapier-upsert-allowlist`.
3. **The ElevenLabs agent config + system prompt** — voice persona, the `lookup_order` tool schema,
   `transfer_to_number`, `end_call`, and the flag/escalation logic, as a ready-to-paste spec.
4. **Dashboard check** — confirm voice conversations render in the unified inbox (they should; the UI
   is channel-agnostic) and add a small audio player for `audio_url` if we enable recording.
5. **A test harness** — simulate an inbound-call payload against the webhook + RPCs so we prove the
   loop before spending a single Twilio minute.

Say the word and I'll start on #1 and #2 right now — they don't need any of your accounts.

---

## 4. Onboarding a client for voice (the repeatable process)

This is the "handle onboarding clients" part. It deliberately mirrors the email onboarding in
`email-agent-zap-build.md`, and reuses most of it.

**If the client is already onboarded for email**, steps 1 and 3 are already done — you only do 2 and 4.

1. **Client config row** (`clients`) — most of this already exists from email onboarding. For voice
   set/confirm:
   - `phone_number` = the client's dedicated inbound number (this is the routing key).
   - `business_hours` (drives transfer vs. callback).
   - `settings.transfer_number` = the human line for warm transfer.
   - `settings.recording` = `"on"` | `"off"` (+ consent handled in the greeting if on).
   - `brand_tone_config` / `custom_instructions` — reused from email; add any voice-only phrasing.
2. **Number provisioning** — buy/import a Twilio number, import it into ElevenLabs (native
   integration), and attach it to the one shared voice agent. The agent passes the dialed number to
   `lookup_order`; the webhook resolves the client via `resolve_client_by_number`. No per-client
   agent, no code change — exactly the "same Zap serves the new client" property email has.
3. **Store credentials** — already in Supabase Vault from email onboarding
   (`store_credentials_ref`, `shipstation_credentials_ref`). Voice reuses
   `get_client_integration_secrets`, so there's nothing new to store.
4. **Go-live checklist** (per client):
   - [ ] Test call connects and the agent greets with the right store name.
   - [ ] Agent captures a real order number by voice and `lookup_order` returns the right order.
   - [ ] A normal order → correct status/tracking answer.
   - [ ] A flagged order (>24h or abnormal status) → holding answer + warm transfer (in hours) or
         callback capture (out of hours), and a `review_queue` item appears in the dashboard.
   - [ ] "Let me talk to a person" → transfer/callback path fires.
   - [ ] Transcript (and recording, if on) shows up on the conversation in the dashboard.

---

## 5. Sequence / who does what next

| Owner | Next step |
|---|---|
| **You** | Confirm pilot store (Bud Club?), create Twilio + ElevenLabs accounts, pick a voice, decide recording on/off, send me the keys + transfer line + greeting/policies. |
| **Me (can start now)** | `0006_voice_integration.sql`, the `voice-order-lookup` webhook, the ElevenLabs agent spec, and the test harness — none of which need your accounts. |
| **Together** | Wire the number into ElevenLabs, point the agent at Claude + the webhook, run the go-live checklist on one live call. |

Rough run cost for the pilot at low volume is dominated by ElevenLabs minutes (~$0.10/min) and
Twilio (~$0.0085/min + ~$1.15/number); Claude Haiku is pennies. Verify current ElevenLabs plan
pricing when you pick the tier.
