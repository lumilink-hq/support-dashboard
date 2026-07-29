# LumiLink — Scheduling MVP Build Plan (HVAC service assistant)

_Supersedes the order-first framing in `voice-agent-mvp-prep.md`. Decisions locked
2026-07-21: **scheduling is the MVP**, order support is parked; target = **HVAC / service
companies**; revenue is first-class. Calendar = **our own, in Supabase** (external calendar
sync deferred to Phase 2); availability = **single calendar now, schema designed for
multi-tech**; pricing = **configurable per service (fixed price or call-out fee + quote)**;
persona = **"Lumi" for the demo, per-client business name for real clients**; website demo =
**web widget + a demo phone number**._

---

## 0. The product in one line

A 24/7 AI receptionist ("Lumi") that answers a service company's phone, books jobs into the
app's calendar against real availability, captures every lead even when it can't book, and
shows the owner the revenue it's generating. The pitch to an HVAC owner is **"stop losing
after-hours and missed calls"** — so the build is organized around *capture and revenue*.

## 1. What we reuse vs. what's new

**Reused as-is** (already built + verified): ElevenLabs voice + the custom LLM (Gemini),
Supabase + RLS + the dashboard shell, the post-call logger pattern (`voice-call-logger`),
client resolution by dialed number, conversation/message logging, and the review queue.

**Parked** (kept for later e-commerce clients, not deleted): `voice-order-lookup` and the
WooCommerce/ShipStation path. The `WOO_*`/`SHIPSTATION_*` secrets are unused for this MVP.

**New for this MVP:** a services + appointments data model with revenue fields, an in-app
styled calendar, the booking agent + tools (Supabase-native), an Appointments dashboard with
revenue reporting, and the website demo.

## 2. Backend decision — our own calendar in Supabase; external sync deferred

Because the app has its own styled calendar, **Supabase is the source of truth** for the MVP.
Appointments live in the `appointments` table, we render our own calendar, and availability is
computed in-app from those appointments + the client's business hours + the service duration.
No Google Cloud project, no OAuth, nothing external to stand up to start.

**What the Google Calendar API would add (and why we defer it):** it does two things a
Supabase-only calendar can't — (1) it sees events created *outside* Lumi (the owner's personal
commitments, jobs booked by phone or another system), so availability reflects their real day,
and (2) it writes the booking into the calendar the business already lives in, so techs see it
on their phone with Google's reminder/invite emails. Neither is needed to prove the MVP: as
long as Lumi is the thing booking, our own appointments *are* the availability. So Google (or
Cal.com) becomes an optional **sync** in Phase 2 for shops that keep a separate calendar.

Two small things become ours instead of Google's, both minor: the **confirmation email** (send
from the booking function via a lightweight email API) and **reminders** (Phase 2).

The schema stays provider-agnostic (`provider` + `calendar_event_ref` sit null until a sync is
connected), so adding Google or Cal.com later is additive, not a rewrite.

## 3. Data model — `0007_scheduling.sql` (additive)

Single-calendar for the MVP, shaped so per-tech dispatch is a later add (note the nullable
`assigned_tech_id` and a future `technicians` table).

**`services`** (per client — the price list the agent quotes from):
`id, client_id, name, category, price_type ('fixed'|'quote'), price (fixed),
callout_fee (quote mode), default_duration_min, emergency_eligible bool, active bool`.

**`appointments`** (the job — everything an HVAC owner needs to see):
- Who/where: `customer_name, customer_email, customer_phone, service_address` (job site —
  HVAC is on-site, so address is required), `is_emergency`.
- What/when: `service_id, service_name, starts_at, ends_at, timezone`.
- Calendar link: `provider ('none'|'google'|'cal_com')` — `'none'` in the MVP (Supabase is the
  source of truth); `calendar_event_ref` and `assigned_tech_id` stay null until a sync / techs
  are added.
- Lifecycle: `status ('booked'|'confirmed'|'rescheduled'|'cancelled'|'completed'|'no_show')`,
  `source ('voice'|'web'|'phone')`, `conversation_id` (links to the call transcript).
- **Revenue:** `currency, price_type, committed_amount` (fixed price, or the call-out fee at
  booking), `estimated_value` (quote pipeline), `final_value` (after the visit),
  `deposit_amount`, `revenue_status ('committed'|'estimated'|'realized')`.
- `notes, created_at, updated_at`. RLS tenant policy like every other table.

**Lead capture (no lead left behind):** when a caller doesn't book, record contact + issue via
a `booking_outcome` on the conversation (`'booked'|'lead_only'|'info'|'transferred'`) plus the
transcript — no separate table yet.

**Client config** (`clients.settings.scheduling`, no DDL): `timezone`, `service_area`,
`min_notice_minutes`, `slot_granularity_minutes`, `deposit` settings, and the persona/brand
(greeting name — "Lumi" for the demo, the business name for real clients). External-calendar
fields (`provider`, `calendar_id`, `credentials_ref`) stay empty until Phase 2 sync.

One service-role RPC `log_appointment(...)`, idempotent, plus a `get_availability(...)` RPC that
returns open slots from Supabase.

## 4. The agent — tools + a merged prompt

Fold the teammate's "Lumi" prompt (good bones: field collection, confirm-once, guardrails, date
read-back) into the scheduling agent, with these fixes:

- **Check availability before confirming.** New tool `check_availability` → the Supabase
  `get_availability` RPC (open slots from existing appointments + business hours + service
  duration) → offer 2–3 real slots. Never book blind.
- **Ground the date.** Inject current date/time + timezone as a dynamic variable so "Wednesday
  at 2" resolves to the correct ISO date instead of a guess.
- **Persona.** Greet with the client's configured name — "Lumi" for the demo client, the
  business name ("Thanks for calling {{business_name}}") for real clients. One config field, no
  code fork.
- **HVAC intents:** emergency triage (no-heat / no-AC → mark `is_emergency`, prioritize or
  transfer), service-area check (decline or transfer for out-of-area), and lead capture when it
  can't book.

Tools (ElevenLabs server tools → a new `scheduling` edge function):
`check_availability` (reads Supabase), `book_appointment` (inserts the appointment in Supabase
with a conflict check, sends the confirmation email, logs it), `capture_lead`, plus the existing
`transfer_to_number` / `end_call`.

## 5. Dashboard — calendar + appointments + revenue

Replace the "Soon" Appointments stub with a real area:

- **Styled calendar view** (our own): day/week view of appointments, color-coded by status /
  emergency — the source of truth, rendered from Supabase.
- **Appointments list:** customer, service, date/time, **status**, **revenue ($)**, source,
  emergency flag; filters by status / service / date / emergency; job address + linked call
  transcript on each row.
- **Revenue KPI row** (prove the ROI): booked revenue this period (committed + estimated
  pipeline + realized), appointments booked, **booking conversion rate**, **after-hours
  captures**, average job value, emergencies handled.
- **Leads view:** calls that didn't book, with contact + issue, for follow-up.
- **Settings additions:** a Services & pricing editor (fixed vs call-out+quote per service),
  business hours, service area, persona/greeting name, deposit settings — plus the
  phone/transfer/recording fields already shipped. (Connect-Google-Calendar lands in Phase 2.)

## 6. Website demo — "Talk to Lumi"

Both surfaces, one sandbox brain:

- **Web widget:** ElevenLabs' embeddable `<elevenlabs-convai>` widget on the marketing site — a
  "Talk to Lumi" button starts an in-browser voice call, no phone needed. (Plan confirmed to
  include the widget.)
- **Demo phone number:** a dialable number on the site for people who prefer calling.
- **Sandbox client:** both point at a demo client (e.g. "Comfort Air Demo") flagged `is_demo`,
  persona = **"Lumi"**, with placeholder HVAC services + prices. Demo bookings live in Supabase,
  are isolated from real dashboards, and reset nightly so the calendar never fills with test
  junk.

## 7. Suggestions worth adding (revenue-maximization for HVAC)

1. **After-hours / missed-call capture is the headline** — HVAC owners lose money when calls
   hit voicemail nights/weekends. Surface an "after-hours captured" number prominently.
2. **Emergency triage** — no-heat/no-AC callers are high-value and time-sensitive; detect, flag
   `is_emergency`, prioritize a slot or warm-transfer to on-call.
3. **No lead left behind** — capture name + number + issue even when it can't book.
4. **No-show reduction** — email/SMS reminders and an optional deposit cut no-shows (revisit the
   teammate prompt's "no SMS links" rule for reminders).
5. **Service-area guardrail** — don't book out-of-area jobs; offer a callback/referral.
6. **Deposits / payment (later)** — reduces no-shows and pulls revenue forward; Phase 2 + a
   compliance step.

## 8. Sequence + what I need from you

**Phase 1 (MVP):** `0007_scheduling.sql` → `scheduling` edge function (Supabase-native
availability + booking + confirmation email) → merged agent prompt + tools → dashboard
(calendar + appointments + revenue KPIs + services/pricing settings) → website demo (widget +
number). Verified locally, same as the phone MVP.

**Phase 2:** external calendar sync (Google/Cal.com), per-tech dispatch, reminders/no-show +
deposits, knowledge base, richer analytics.

What I need from you to start Phase 1 (much shorter now that Google is deferred):

- **A pilot HVAC client's details:** business name, your work email (dashboard login — any email
  works now), the ElevenLabs phone number + timezone + business hours, optional transfer number
  + service area, and a **service + price list** (the one piece that matters — 4–6 services with
  price model, price/fee, and duration). I can seed this via SQL, or you sign up in the app.
- **A confirmation-email sender:** an API key for a lightweight email service (e.g. Resend/SES),
  or say "defer email" and the MVP just books + logs without emailing until Phase 2.
- **Where to embed the web widget** (which site) and whether you want a dedicated demo number.

Web widget plan: confirmed. Persona: "Lumi" for the demo, per-client for production — settled.

Say go and I'll build Phase 1 the way I built the phone MVP — migration, edge function, tools,
tests, all verified locally before anything is live.

---

Sources: ElevenLabs web widget — https://elevenlabs.io/docs/eleven-agents/customization/widget ;
Google Calendar API freebusy (Phase 2 sync reference) —
https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
