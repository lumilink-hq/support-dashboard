# Scheduling MVP — Go-Live Checklist

One clean sequence to take the HVAC scheduling agent ("Lumi") live on the demo client
(`comfort-air-demo`). Everything referenced here is already built, tested, and in the repo.
Do the steps in order — each depends on the one before.

**Already done (prereqs):** ElevenLabs account with the Twilio number connected, a Google AI
Studio key for Gemini, Supabase project, and `VOICE_TOOL_SECRET` set. Order-support secrets
(`WOO_*`, `SHIPSTATION_*`) are not needed here.

---

## 1. Deploy the backend

- [ ] **Apply migrations** (adds voice + scheduling objects — `0006`, `0007`):
  ```
  supabase db push
  ```
- [ ] **Seed the demo client + price list** — run `supabase/seed_hvac_client.sql` in the
  Supabase SQL editor. It prints the 6 services on success.
- [ ] **Set the demo client's phone number** to the connected ElevenLabs/Twilio number, in
  E.164 (this is the call-routing key):
  ```sql
  update clients set phone_number = '+1XXXXXXXXXX' where slug = 'comfort-air-demo';
  ```
- [ ] **Deploy the two functions** the agent needs (scheduling tool + post-call logger):
  ```
  supabase functions deploy scheduling        --no-verify-jwt
  supabase functions deploy voice-call-logger  --no-verify-jwt
  ```
- [ ] **Confirm secrets** are set on the project (scheduling reuses the phone-MVP ones):
  - `SUPABASE_SECRET_KEYS` — `{"default":"<service-role-key>"}` (same as `zapier-upsert-allowlist`)
  - `VOICE_TOOL_SECRET` — the shared header value the tools send
  - `ELEVENLABS_WEBHOOK_SECRET` — from the ElevenLabs post-call webhook (step 3)
  ```
  supabase secrets set ELEVENLABS_WEBHOOK_SECRET=<from ElevenLabs>
  ```

## 2. Ship the dashboard

- [ ] Commit and push all pending changes (migration, function, dashboard pages, and the
  earlier build fixes — `tsconfig` excludes, restored `package.json`, no `pnpm-workspace.yaml`).
- [ ] Confirm **Railway** rebuilds green. The new pages — Appointments, Leads, Services — appear
  in the sidebar.
- [ ] In **Services**, sanity-check the seeded price list looks right (edit any prices you want
  for the demo).

## 3. Configure the ElevenLabs "Lumi" agent

Full detail is in `docs/scheduling-agent-prompt.md`; the ordered actions:

- [ ] **LLM:** Agent → LLM → **Gemini Flash** (native), paste your Google AI Studio key.
- [ ] **System prompt:** paste the **hardcoded Comfort Air prompt** from
  `scheduling-agent-prompt.md` §3 — business name, services, hours, and area are baked in, so
  there are no custom variables to set for the demo.
- [ ] **System variables are automatic** — nothing to configure. The prompt + tools reference
  `system__time_utc`, `system__called_number`, `system__caller_id`, `system__call_sid`, and
  ElevenLabs populates them per call. (Per-client custom variables are only needed when one agent
  serves many clients — see the prompt doc §6, Phase 2.)
- [ ] **Tools — add three server tools**, each `POST https://<ref>.functions.supabase.co/scheduling`
  with header `x-voice-tool-secret: <VOICE_TOOL_SECRET>` and an `action` field:
  - `check_availability` → `{ action, called_number, service_name, from_date? }`
  - `book` → `{ action, called_number, caller_number, call_sid, service_name,
    appointment_start, customer_name, customer_email, customer_phone, service_address,
    is_emergency, notes }`
  - `capture_lead` → `{ action, called_number, caller_number, call_sid, customer_name,
    customer_phone, issue }`
- [ ] **System tools:** `transfer_to_number` → the client's `settings.transfer_number`
  (set one in the DB if you want live transfer); `end_call`.
- [ ] **Post-call webhook:** point it at `https://<ref>.functions.supabase.co/voice-call-logger`,
  auth **HMAC**, and copy its signing secret into `ELEVENLABS_WEBHOOK_SECRET` (step 1).

## 4. Test (before promoting the number)

- [ ] **Backend loop** (no telephony needed) — against your DB / a shadow db:
  ```
  psql "$DATABASE_URL" -f scripts/test_scheduling.sql       # booking, revenue, no-overlap guard
  npx tsx scripts/test-scheduling-slots.ts                  # tz-aware slot logic
  ```
- [ ] **Function smoke test** — availability for the demo number returns real slots:
  ```
  curl -s -X POST https://<ref>.functions.supabase.co/scheduling \
    -H "Content-Type: application/json" \
    -H "x-voice-tool-secret: <VOICE_TOOL_SECRET>" \
    -d '{"action":"check_availability","called_number":"+1XXXXXXXXXX","service_name":"AC Tune-Up"}'
  ```
  Expect `{ "ok": true, "slots": [ ... ] }`.
- [ ] **Live call:** dial the number and book a tune-up. Confirm:
  - Lumi greets as Comfort Air, offers **real** open times, books one.
  - The appointment appears in **Appointments** (week calendar + list), and the **revenue KPIs**
    update.
  - "I need someone now / emergency" → transfer (or callback), and a **flagged** item / lead
    shows up.
  - "Just checking prices" → **capture_lead**, and it appears in **Leads**.
  - The **transcript** is logged on the conversation.

## 5. Website demo (after the core loop works)

- [ ] Embed the ElevenLabs **web widget** (`<elevenlabs-convai agent-id="…">`) on the marketing
  site — a "Talk to Lumi" button.
- [ ] Optionally publish the **demo phone number** on the site.
- [ ] Point both at the `comfort-air-demo` (`is_demo`) client; keep demo bookings isolated and
  reset the demo data periodically.

## Deferred (Phase 2 — not blocking go-live)

Confirmation email (booking books + logs without emailing until a Resend/SES key is added),
reschedule/cancel by voice, per-technician dispatch, external calendar (Google/Cal.com) sync,
reminders/no-show + deposits, and the knowledge base.

---

**One-line mental model:** deploy backend → ship dashboard → wire the agent (Gemini + prompt +
3 tools + post-call webhook) → test the loop → embed the demo. The number's already connected,
so this is wiring and verification, not building.
