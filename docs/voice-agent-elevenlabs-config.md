# Voice Agent — ElevenLabs Config & Prompt (Bud Club pilot)

How the ElevenLabs Agent is wired for the WooCommerce pilot. One shared agent serves
every client; the dialed number identifies the tenant via `voice-order-lookup`. This is
the voice analog of `email-agent-zap-build.md`.

---

## 1. Telephony — native Twilio import

ElevenLabs Agents integrate Twilio natively, so there is **no media-streaming server to
run**. Steps:

1. Buy a US local number in Twilio.
2. In ElevenLabs → Agents → Phone Numbers → **Import from Twilio**: paste the Twilio
   Account SID + Auth Token and select the number.
3. Assign that number to this agent.
4. Store the same number on the client row in E.164:
   `update clients set phone_number = '+1XXXXXXXXXX' where slug = 'woo-store';`
   (That's the routing key `resolve_client_by_number` matches on.)

## 2. LLM — Gemini Flash (pilot default)

On a live call, latency is the product, so use a fast Flash-class model. For the pilot we
use **Google Gemini Flash**, which ElevenLabs supports natively:

- Agent → LLM → pick **Gemini Flash** from the built-in model list (no Custom LLM endpoint
  needed — it's a native provider).
- Paste a **Google AI Studio** API key (aistudio.google.com → Get API key).
- Enable prompt caching on the system prompt.

Why Gemini Flash for the pilot: it's the low-latency tier (the same reason we'd otherwise
pick Claude Haiku) and Google's free tier is enough to test end to end at no cost.

> ⚠️ **Free-tier data use.** Google's *free-tier* Gemini API may use your prompts/data to
> improve their products. That's fine for `MOCK_STORE` testing and your own test calls, but
> before real customers give order numbers / names / phone numbers on the line, switch
> Gemini to the **paid tier** (turns off training use, still cheap at Flash rates) or make a
> deliberate decision to accept the free-tier terms for the pilot. It's a billing-tier
> toggle in Google AI Studio — no code or config change here.

**Switching LLMs is a dropdown change, nothing else.** The model never touches the database;
it only calls the `lookup_order` tool and reads back the returned fields. To move to Claude
later: Agent → LLM → select Claude natively if `claude-haiku-4-5` is listed, or use **Custom
LLM** with Anthropic's OpenAI-compatible endpoint `https://api.anthropic.com/v1/`, your
Anthropic key, and model id `claude-haiku-4-5`. No change to the function, RPCs, prompt, or
tools.

## 3. Dynamic variables (from Twilio → agent)

Make these available to the prompt and tools:

- `system__called_number` → the dialed number (Twilio "To")   → tool arg `called_number`
- `system__caller_number` → the caller (Twilio "From")        → tool args `caller_number`
- `system__call_sid`      → Twilio call SID                    → tool arg `call_sid`

## 4. System prompt (paste into the agent)

```
You are the phone support agent for {{store_name}}. You are speaking out loud on a live
phone call, so keep replies short, natural, and one idea at a time. Never read out URLs,
IDs, JSON, or internal flags.

You can help with order status, tracking, what's in an order, and refund questions. You
look orders up with the lookup_order tool — never guess or invent order details.

Flow:
1. Greet: "Thanks for calling {{store_name}}, this is the support line. How can I help?"
2. To look anything up you need the order number. If you don't have it, ask for it once,
   clearly. If the caller can't provide it, offer a callback (collect their number) and
   call end_call after confirming.
3. Call lookup_order with the order number. Handle the result:
   - need_order_number: ask for the order number.
   - order_not_found: say you couldn't find that order and ask them to double-check the
     number; offer a callback if still stuck.
   - found and should_escalate is false: answer their question using only the returned
     fields (status, tracking_number, carrier, items, total, estimated_delivery).
   - found and should_escalate is true (flagged order): give a brief, non-committal
     holding answer ("Let me get a teammate to take a closer look"). Do NOT promise
     refunds, dates, or resolutions. Then escalate (step 4).
4. Escalation (flagged order, OR the caller asks for a person):
   - During business hours: use transfer_to_number to warm-transfer to the human line.
   - Outside business hours or if transfer fails: confirm the best callback number and
     tell them a teammate will call back, then end_call.
5. Be warm and concise. Match this tone: {{brand_voice}}. Never make commitments the
   holding path forbids.
```

Fill `{{store_name}}`, `{{brand_voice}}` from the client's `name` / `brand_tone_config`
(and append `custom_instructions` for store policies like return window / shipping times).

## 5. Tools

### 5a. `lookup_order` — server tool (webhook)

- **Method/URL:** `POST https://<project-ref>.functions.supabase.co/voice-order-lookup`
- **Headers:** `Content-Type: application/json`, `x-voice-tool-secret: <VOICE_TOOL_SECRET>`
- **Body (JSON):**
  ```json
  {
    "called_number": "{{system__called_number}}",
    "caller_number": "{{system__caller_number}}",
    "call_sid": "{{system__call_sid}}",
    "order_number": "{{order_number}}"
  }
  ```
  `order_number` is the parameter the LLM fills from the caller. The function returns
  `found`, `status`, `tracking_number`, `carrier`, `items`, `total`,
  `estimated_delivery`, and `should_escalate` / `flag_reason` — the fields the prompt
  above branches on.

### 5b. `transfer_to_number` — system tool

Warm transfer to the client's human line. Set the destination from the client's
`settings.transfer_number`. Use only during business hours / on escalation.

### 5c. `end_call` — system tool

End the call after a callback is confirmed or the caller is done.

## 6. Post-call logging + escalation — `voice-call-logger` function

This is built: `supabase/functions/voice-call-logger`. Wire it as the agent's **post-call
webhook** (ElevenLabs → agent → Post-call webhook → your function URL):

- **URL:** `https://<project-ref>.functions.supabase.co/voice-call-logger`
- **Auth:** ElevenLabs signs post-call webhooks with an HMAC in the `ElevenLabs-Signature`
  header. Copy the webhook's signing secret from ElevenLabs and set it as
  `supabase secrets set ELEVENLABS_WEBHOOK_SECRET=<secret>`. The function verifies
  `t=<ts>,v0=<hmac_sha256(ts + "." + rawBody)>`. **If the secret is unset the function skips
  verification** (handy for a first smoke test) and logs a warning — set it before go-live.

What it does, all with the RPCs from `0006`:

1. Pulls `system__call_sid`, `system__called_number`, `system__caller_id` from
   `data.conversation_initiation_client_data.dynamic_variables`.
2. Resolves the client (`resolve_client_by_number`) and ensures the conversation exists
   (`ingest_call`; it already does from the mid-call lookup, so this is a no-op).
3. Appends every transcript turn via `log_call_turn`, keyed
   `p_turn_ref = "<call_sid>:<index>"` so a re-fired webhook can't double-log. `user` →
   `customer`, `agent` → `agent`.
4. **Escalation → review queue:** if the discussed order is flagged (re-checks
   `orders_cache` via `evaluate_flag`) it calls `apply_flag(conversation_id, flag_reason)`;
   if a transfer/human-request tool call appears in the transcript it calls
   `apply_flag(conversation_id, 'caller_request')`. That's what makes the call surface in
   the dashboard review queue. Otherwise the conversation is closed as `resolved`.

If recording is enabled later, upload the audio to Supabase Storage and pass its URL as
`p_audio_url` on the relevant turn (the function leaves a hook for this).

## 8. Go-live checklist (pilot)

- [ ] Twilio number imported into ElevenLabs and assigned to the agent.
- [ ] `clients.phone_number` set to that number (E.164) for `woo-store`.
- [ ] `settings.transfer_number` and `business_hours` set for `woo-store`.
- [ ] LLM set to Gemini Flash (native) with your Google AI Studio key; system prompt pasted.
      (Gemini on paid tier before real-customer calls — see §2 data-use note.)
- [ ] `lookup_order` tool points at the deployed function with the shared secret.
- [ ] Test call: greet → order # → correct answer; a flagged order → holding + transfer;
      "talk to a person" → transfer/callback; transcript appears on the conversation.
```
