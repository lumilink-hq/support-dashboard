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

## 2. LLM — Claude Haiku as custom LLM (BYOK)

Agent → LLM → **Custom LLM**. Provide the Anthropic-compatible endpoint and your key.
Model: `claude-haiku-4-5` (fast/cheap — on a live call latency is the product). Enable
prompt caching for the system prompt. Keep Sonnet in reserve only for a rare hard turn;
bias toward escalating to a human instead of long silences.

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

## 6. Post-call logging

Configure the agent's **post-call webhook** to POST the transcript to a small logger
(or a second edge function) that calls `log_call_turn` once per turn, keyed
`p_turn_ref = "<call_sid>:<index>"` for idempotency, and sets the final status
(`resolved` / `awaiting_customer` / `flagged`). If recording is enabled, upload the audio
to Supabase Storage and pass its URL as `p_audio_url`. The conversation row already exists
(the lookup tool called `ingest_call`), so the logger only appends turns.

## 7. Escalation → review queue

When a flagged order is escalated, also create the human review item (so it shows in the
dashboard queue): call `apply_flag(conversation_id, reason, details)` with reason
`caller_request` (person requested) or the returned `flag_reason`. Do this from the
post-call webhook using the conversation id resolved from the call SID.

## 8. Go-live checklist (pilot)

- [ ] Twilio number imported into ElevenLabs and assigned to the agent.
- [ ] `clients.phone_number` set to that number (E.164) for `woo-store`.
- [ ] `settings.transfer_number` and `business_hours` set for `woo-store`.
- [ ] Custom LLM points at Claude Haiku with your key; system prompt pasted.
- [ ] `lookup_order` tool points at the deployed function with the shared secret.
- [ ] Test call: greet → order # → correct answer; a flagged order → holding + transfer;
      "talk to a person" → transfer/callback; transcript appears on the conversation.
```
