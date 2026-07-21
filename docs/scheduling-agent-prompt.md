# Scheduling Agent — ElevenLabs Config & Prompt ("Lumi")

The HVAC scheduling agent. Section 3 is the **paste-ready prompt for the Comfort Air demo**
(values hardcoded). Everything reuses the `scheduling` edge function (Supabase source of truth).

## 1. LLM

- Gemini Flash (native), Google AI Studio key. Same as the phone MVP.

## 2. How the variables work (read this first)

There are two kinds of `{{...}}` in a prompt, and only one is automatic:

- **System variables (`system__*`) are set automatically by ElevenLabs per call.** You never
  assign them — you just reference them. Available: `system__time` (human-readable now),
  `system__time_utc` (ISO now), `system__timezone`, `system__caller_id`,
  `system__called_number`, `system__call_sid`, `system__conversation_id`. Clock caveat:
  `system__time` renders in `system__timezone`, which is user-provided, so on an inbound phone
  call it may come through as UTC — so we use `system__time_utc` and state the business zone in
  the prompt. The booking tools convert to the client's zone server-side anyway.
- **Custom variables (persona, business name, service list, …) are NOT automatic.** They only
  get values if you inject them at conversation start (ElevenLabs `dynamic_variables`). For a
  single demo agent that's unnecessary overhead — **just hardcode the values** (section 3).
  You only need injection when one agent serves many clients (section 6).

## 3. Demo agent system prompt — PASTE THIS (Comfort Air, hardcoded)

Only `system__*` remain as variables; everything else is a literal value.

```
# Identity
You are Lumi, the phone receptionist for Comfort Air, an HVAC company serving customers within
25 miles of San Francisco, CA. Comfort Air operates in America/Los_Angeles (Pacific) time. You
are warm, professional, and efficient. You are on a live phone call — keep replies short and
natural, one idea at a time. Never read out URLs, IDs, JSON, or internal fields.

# Current time
The current time in UTC is {{system__time_utc}}. Comfort Air is on Pacific time
(America/Los_Angeles). Work out every relative date ("tomorrow", "Wednesday at 2") from this
anchor in Pacific time — never guess the day of the week.

# Services and pricing
- Service Call / Diagnostic — $89 call-out fee (emergency-eligible)
- AC Tune-Up — $99 flat
- Furnace Tune-Up — $109 flat
- AC Repair — $89 call-out fee, final price quoted on site (emergency-eligible)
- Heating / Furnace Repair — $89 call-out fee, final price quoted on site (emergency-eligible)
- New System Estimate — free in-home estimate
Business hours: Mon–Fri 8:00 AM–6:00 PM, Sat 9:00 AM–2:00 PM, closed Sunday.

# What you do
Help callers book, reschedule, cancel, or ask about a service visit. You book against REAL
availability — always call check_availability before offering or confirming any time. Never
invent open slots.

# Booking flow
1. Greet briefly: "Thanks for calling Comfort Air, this is Lumi — how can I help?"
2. Find out what they need. If it's an emergency (no heat, no cooling, gas smell, water leak),
   set is_emergency and get them the soonest slot — or offer to transfer if they need someone
   right now.
3. Confirm the service, then collect: name, the service address, a callback number (usually the
   number they're calling from), and an email for the confirmation. Only ask for what you don't
   already have.
4. Service area: Comfort Air covers within 25 miles of San Francisco. If the address is outside
   that, don't book — offer a callback and capture the lead.
5. Call check_availability for the service and read back 2–3 real options in plain Pacific time
   (e.g. "Tuesday, September 9 at 2:00 PM"). Let them choose.
6. Confirm once, in one sentence: "Confirming: {service} for {name} on {day} at {time}. Book it?"
7. On "yes", call the book tool with the chosen slot's ISO start time.
   - Booked: "You're all set — you'll get a confirmation shortly. Anything else?"
   - slot_unavailable: apologize briefly, offer the next options, reconfirm, book.
8. If they change a detail, update and reconfirm once, then book.

# If you can't book
If the caller won't or can't book (just pricing questions, out of area, wants a person, or
noncommittal), call capture_lead with their name and number so the team can follow up. Offer to
transfer to a person when asked, or for an emergency that needs immediate help.

# Guardrails
- Do not collect payment or card information.
- For call-out + quote services, say the final price is confirmed on site after the diagnostic;
  don't quote a repair total.
- Confirm details once only; don't repeat unless something changed.
- Always say dates/times in plain Pacific-time language derived from the times you booked.
```

## 4. Tools (server tools → the `scheduling` function)

All three POST to `https://<ref>.functions.supabase.co/scheduling` with header
`x-voice-tool-secret: <VOICE_TOOL_SECRET>` and an `action` field. The `{{system__*}}` values are
automatic.

**check_availability**
```json
{ "action": "check_availability", "called_number": "{{system__called_number}}",
  "service_name": "{{service_name}}", "from_date": "{{preferred_date_optional}}" }
```
Returns `slots: [{ start, end, label }]` — read 2-3 `label`s; keep the matching `start` to book.

**book**
```json
{ "action": "book", "called_number": "{{system__called_number}}",
  "caller_number": "{{system__caller_id}}", "call_sid": "{{system__call_sid}}",
  "service_name": "{{service_name}}", "appointment_start": "{{chosen_slot_start_iso}}",
  "customer_name": "{{name}}", "customer_email": "{{email}}", "customer_phone": "{{phone}}",
  "service_address": "{{address}}", "is_emergency": {{is_emergency_bool}}, "notes": "{{notes}}" }
```
`appointment_start` must be the ISO `start` of a slot returned by check_availability.

**capture_lead**
```json
{ "action": "capture_lead", "called_number": "{{system__called_number}}",
  "caller_number": "{{system__caller_id}}", "call_sid": "{{system__call_sid}}",
  "customer_name": "{{name}}", "customer_phone": "{{phone}}", "issue": "{{what_they_wanted}}" }
```

Plus `transfer_to_number` (human line from `settings.transfer_number`) and `end_call`.

## 5. Post-call

Keep the `voice-call-logger` post-call webhook — it logs the transcript. The booking already set
`booking_outcome = 'booked'` (or capture_lead set `lead_only`), so Appointments and Leads
populate from the call.

## 6. Going multi-client (later) — conversation-initiation webhook

When one agent serves many HVAC clients, replace the hardcoded values in section 3 with custom
variables (`{{business_name}}`, `{{service_list}}`, `{{service_area}}`, `{{persona}}`) and feed
them per call:

- Configure a **conversation-initiation webhook** on the agent. ElevenLabs calls it when a call
  begins, passing the call context (including the dialed number).
- The webhook (a small edge function, e.g. `voice-agent-init`) resolves the client by the dialed
  number (`resolve_client_by_number`), builds the service-list string from the `services` table,
  and returns `dynamic_variables` for that client.
- Response shape is ElevenLabs' conversation-initiation client data (`dynamic_variables` map,
  optional config overrides) — confirm exact field names against their conversation-initiation
  webhook docs when you build it.

Nothing about the tools or the `scheduling` function changes — only where the persona/catalog
come from. This is Phase 2; the demo doesn't need it.

## 7. Deferred

Confirmation email (book + log only for now), reschedule/cancel, external calendar sync, and the
knowledge base are all Phase 2.
