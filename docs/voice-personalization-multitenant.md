# Multi-tenant voice — one agent, many clients (`voice-personalization`)

How Lumilink serves every client from **one shared ElevenLabs agent** instead of
building a new agent per company. This is the voice analog of the email `+slug`
routing: the **dialed number** identifies the tenant, and a webhook hands the
agent that tenant's prompt, greeting, and variables at the start of each call.

## The idea

ElevenLabs lets you override an agent's behavior *per conversation* — system
prompt, first message, language, voice, even tools — and the way you supply
those for inbound phone calls is the **conversation-initiation (personalization)
webhook**. On each inbound call, before audio connects, ElevenLabs POSTs the
dialed number to our webhook; we look up the client and return their
configuration. Same agent, different business, decided per call.

So you do **not**:

- make a new agent per client (one shared agent),
- redeploy any function per client (the backend is tenant-agnostic),
- write per-client code (onboarding a client is just DB rows).

You **do** give each client their own phone number — that number *is* the routing
key (and they want their own caller ID anyway).

## The function

`supabase/functions/voice-personalization/` (`index.ts` + pure `lib.ts`).

- **Request (ElevenLabs → us):** `{ caller_id, agent_id, called_number, call_sid }`
- **Response (us → ElevenLabs):**
  ```json
  {
    "dynamic_variables": { "store_name": "...", "persona": "...", "...": "..." },
    "conversation_config_override": {
      "agent": {
        "prompt": { "prompt": "<per-tenant system prompt>" },
        "first_message": "Thanks for calling <store>, this is <persona>...",
        "language": "en"
      }
    }
  }
  ```

What it does: verify the ElevenLabs HMAC signature → `resolve_client_by_number`
(digits-only, E.164) → load the `clients` row + active `services` →
`lib.ts/buildResponse` assembles the prompt (persona, tone, hours, service area,
and a priced service menu baked in) + greeting + variables. If the number maps to
no client, it returns a safe generic fallback so the call still connects instead
of dropping.

All prompt/greeting/menu construction lives in `lib.ts` as pure functions and is
unit-tested in `scripts/test-voice-personalization.ts` (run
`npx tsx scripts/test-voice-personalization.ts`).

## Deploy

```bash
supabase functions deploy voice-personalization --no-verify-jwt
# SUPABASE_URL / SUPABASE_SECRET_KEYS are already set (same as the other voice fns).
# Set the webhook signing secret once you have it from ElevenLabs (below):
supabase secrets set ELEVENLABS_PERSONALIZATION_SECRET=<secret>
```

> If `ELEVENLABS_PERSONALIZATION_SECRET` is unset the function **skips** signature
> verification and logs a warning — fine for a first smoke test, set it before
> go-live.

## Wire it in ElevenLabs (once, on the shared agent)

1. **Enable overrides.** Agent → **Security** tab → allow `System prompt`,
   `First message`, and `Language` to be overridden. Overrides are disabled by
   default; a call that tries to override a field you haven't enabled will error.
2. **Set the personalization webhook.** Agent → add the **Conversation
   initiation / fetch initiation client data** webhook →
   `https://<project-ref>.functions.supabase.co/voice-personalization`. Copy the
   signing secret ElevenLabs shows and set it as
   `ELEVENLABS_PERSONALIZATION_SECRET`.
3. **Dynamic variables.** The function always returns this set — keep the agent's
   base prompt using only these (or none), so agent and function agree:
   `store_name, persona, brand_voice, timezone, business_hours, service_area,
   services_summary, transfer_number, is_demo`.
4. Leave the scheduling tools (`check_availability`, `book`, `capture_lead`) and
   `transfer_to_number` / `end_call` as they are — they already self-route by
   `{{system__called_number}}`, so they need no per-tenant change.

## Onboarding a new client (the whole checklist)

1. Insert/seed a `clients` row: `name`, `slug`, `is_active`, `phone_number`
   (E.164), `brand_tone_config` (`voice`, `persona`), `business_hours`, and
   `settings.scheduling` (`timezone`, structured `hours`, `service_area`,
   `slot_granularity_minutes`, `min_notice_minutes`), plus optional
   `settings.transfer_number`.
2. Insert their `services` rows (name, `price_type`, `price`/`callout_fee`,
   `default_duration_min`, `emergency_eligible`).
3. Buy a number in Twilio, import it into ElevenLabs, assign it to the shared
   agent, and set `clients.phone_number` to it.
4. (If they use order lookups) add their store secrets to Vault.

No new agent, no deploy. Call the number and the agent is that business.

## Web routing — slug instead of dialed number (BUILT)

The `/demo` browser widget has no dialed number, so it routes the tenant by
**client slug** instead. This is wired end to end and symmetric with the phone
path:

- **The page** (`app/demo/page.tsx`) reads `?client=<slug>` (default
  `comfort-air-demo`, overridable via `NEXT_PUBLIC_DEMO_CLIENT_SLUG`) and passes
  it to the widget as a dynamic variable:
  `<elevenlabs-convai dynamic-variables='{"client_slug":"comfort-air-demo"}'>`.
  Per-client demo links are just `/demo?client=<slug>`.
- **The scheduling tool** (`supabase/functions/scheduling`) now resolves the
  tenant from **either** `called_number` (phone) **or** `client_ref` (web slug).
  In the tool's body mapping in ElevenLabs, add `client_ref: {{client_slug}}`
  alongside `called_number: {{system__called_number}}`. On a phone call
  `system__called_number` is set and `client_slug` is empty → routes by number;
  in the widget it's the reverse → routes by slug. Same tool, both channels.
- **Demo-only guard.** Slug resolution only matches clients with
  `settings.is_demo = true`, so the public widget can never reach a real client's
  calendar. Real clients stay phone-only. (To later embed a widget on a real
  client's *own* site, you'd add authenticated per-client web access rather than
  loosening this.)
- **Personalization for web.** `voice-personalization` also accepts `client_slug`
  (same demo-only guard) and includes `client_slug` in the returned
  `dynamic_variables`, so the same function serves both channels. It additionally
  accepts an internal `x-voice-tool-secret` header (matching `VOICE_TOOL_SECRET`)
  so our own server can fetch a client's prompt/greeting for a web session
  without an ElevenLabs HMAC — the hook for per-client web *prompts* (set the
  widget's `override-prompt` / `override-first-message` from it) when you go
  beyond one demo client. For the single Comfort Air demo the agent's base
  config already carries Lumi's prompt, so passing `client_slug` for tool routing
  is all that's required today.
