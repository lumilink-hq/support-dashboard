# Scope — Appointment Scheduling (primary) + Knowledge Base (secondary)

_Lumilink · design scope, not built yet. Decisions captured: scheduling **first**; the
caller books **appointments with the business**; calendar backend and KB approach = "you
advise" (recommendations below)._

---

## 0. The positioning shift to name first

Appointment booking "with the business" means Lumilink is no longer only an e-commerce
order-support tool — it's serving **appointment-based businesses** (clinics, salons, home
services, consultants, etc.). That's a real product decision worth making on purpose,
because it splits clients into two archetypes that share the same plumbing:

- **E-commerce support client** (today): has a store, order lookups, flag rules. Bud Club.
- **Appointment client** (new): may have **no store at all** — order lookup / abnormal-status
  rules simply don't apply to them.

The good news: the schema already tolerates a store-less client (`store_platform` is
nullable), and both archetypes still share `conversations`, `messages`, the dashboard, the
review queue, and one agent. So this is additive, not a fork. But some order-centric flows
(order number capture, `evaluate_flag`) are meaningless for a pure appointment client, and
the agent prompt/tools must branch on what the client is configured for. **Practical
consequence for the pilot:** Bud Club can't pilot scheduling — it's an e-commerce store. We
need an appointment-based pilot client (real or a test one) to prove this loop.

---

## 1. Scheduling — recommended backend: **Cal.com**

### Why Cal.com over the alternatives

An AI agent booking mid-conversation needs three things from a calendar: read real
availability, **create a booking programmatically**, and do it per-tenant. Weighed against
that:

- **Cal.com (recommended).** API-first and open-source. Its API v2 exposes availability
  (`/slots`) and **booking creation** (`/bookings`), plus a managed-users / platform layer
  for provisioning a scheduling account per client — which matches Lumilink's "onboard a
  client = config, not a build" principle. It owns the hard parts (recurring availability,
  timezones, buffers, double-booking prevention, reschedule/cancel) so we don't rebuild
  them. It's explicitly used for AI-agent booking.
- **Calendly (rejected).** Calendly's model requires a human to complete each booking via a
  scheduling page; its API can't autonomously create a confirmed booking in-conversation the
  way a voice agent needs. Good for links, wrong for an autonomous agent.
- **Google Calendar (fallback only).** Fine if a specific pilot client already lives in
  Google Calendar, but you'd build the availability/booking rules (free/busy + conflict
  handling + buffers + per-service logic) yourself, per-client OAuth. More glue, and you end
  up reimplementing what Cal.com gives you.
- **Internal Supabase tables (not recommended for MVP).** Owning availability yourself means
  building Calendly — recurring rules, timezones, staff/resources, a management UI. Large
  scope for no near-term payoff. Revisit only if you deliberately want scheduling as an
  owned core product later.

So: **Cal.com as the scheduling backend; Lumilink stores only a thin local record + config,
and calls Cal.com as a tool.** Same shape as the order flow, where WooCommerce owns the
orders and we cache/normalize.

### Data model — `0007_scheduling.sql` (additive)

Cal.com owns availability, so Lumilink only needs a **local log** (so bookings show in the
unified dashboard beside calls/emails) plus **per-client config**.

- New table `appointments`:
  `id, client_id, conversation_id (nullable), provider ('cal_com'|'google'|'internal'),
   external_ref (Cal.com booking uid — unique per client for idempotency), service/event_type,
   customer_name, customer_identifier, starts_at, ends_at, timezone,
   status ('booked'|'rescheduled'|'cancelled'|'completed'|'no_show'), meta jsonb,
   created_at, updated_at`. RLS tenant policy like the other tables.
- Client config (no DDL — in `clients.settings`):
  `settings.scheduling = { provider, cal_event_type_id, cal_username_or_managed_user_id,
   credentials_ref }`. Cal.com API key lives in **Vault** and is resolved exactly like the
  store creds (reuse the `get_client_integration_secrets` pattern).
- One service-role RPC `log_appointment(...)` (mirrors `ingest_call`/`log_agent_reply`):
  upserts the `appointments` row idempotently on `external_ref` and links the conversation.

### The agent tools + backend

A new edge function `scheduling` (one function, action-branched, or two small ones) that the
agent calls as **server tools** — the direct analog of `voice-order-lookup`:

- `check_availability(called_number|client_id, service, date_range)` → resolve client →
  Cal.com `/slots` → return a short, speakable list of open times.
- `book_appointment(client_id, service, slot, customer_name, customer_contact)` → Cal.com
  `/bookings` create → on success `log_appointment` + link the conversation → return a
  confirmation the agent reads back.
- (v2) `reschedule` / `cancel` — same pattern; Cal.com handles the calendar side.

Reuses what already exists: client resolution by dialed number, the Vault-secret pattern,
and conversation logging via `ingest_call` + the post-call `voice-call-logger`.

### How it slots into each channel

- **Voice:** the agent flow gains a branch — intent "book an appointment" → `check_availability`
  → offer 2–3 slots → `book_appointment` → confirm. Same system-prompt structure as the order
  path; add the two tools and the booking branch. Escalation unchanged (no availability, or
  caller wants a human → transfer/callback).
- **Email:** two options — full booking in-thread (same tools via the Zap), or the lighter v1
  of replying with the client's Cal.com booking link. Recommend **link-first for email v1**,
  full in-call booking for voice, since voice is where real-time booking earns its keep.

### Onboarding a scheduling client (repeatable)

1. `clients` row (may have **no** store). Set `settings.scheduling` (provider, event-type id).
2. Cal.com: either connect the client's existing Cal.com (API key + event-type id) or
   provision a managed user via Cal.com's platform API; store the key in Vault, set the ref.
3. Assign a phone number (voice) as before; business hours are informational (Cal.com owns
   real availability).
4. Go-live checklist: test call → "I'd like to book" → agent offers real open slots → books →
   the appointment appears in Cal.com **and** in the Lumilink dashboard on that conversation.

---

## 2. Knowledge base — recommended approach: **phased (native KB now, pgvector for both channels)**

The deciding factor is that Lumilink is **two-channel**, and the two KB options serve
different channels:

- **ElevenLabs native KB** (upload docs/URLs to the agent; it retrieves at call time) is
  near-zero build and great — **but voice-only**. The email agent (Zapier + Claude) can't use
  it. So on its own it creates a split where voice answers from the KB and email doesn't.
- **Custom RAG in Supabase (pgvector)** is one knowledge base serving **both** channels,
  multi-tenant by `client_id`, consistent with the proposal's "one shared data layer, both
  agents read from it." More build (chunking, embeddings, a `search_kb` tool), but it's the
  architecturally correct home.

Recommended path, mirroring how we did voice (fast pilot now, right architecture as it
scales):

1. **Now / voice pilot:** turn on **ElevenLabs native KB** — upload each client's policies /
   FAQ / product docs to their agent. Voice answers general questions immediately, ~no code.
   (Confirm KB/RAG is on your ElevenLabs plan tier.)
2. **Durable / cross-channel:** build **Supabase pgvector RAG** as the unified KB so email and
   voice answer from the same source:
   - `0008_knowledge_base.sql`: `documents (client_id, title, source_uri, ...)` and
     `doc_chunks (client_id, document_id, content, embedding vector(1536), meta)` with an
     ANN index (HNSW/IVFFlat) + RLS.
   - Ingestion: chunk + embed on upload (embedding API), store chunks.
   - Retrieval: `match_kb(client_id, query_embedding, k)` RPC + a `search_kb` server tool both
     agents call — embed the question, fetch top chunks, answer with guardrails ("don't invent;
     if it's not in the docs, say a teammate will follow up").

This is a smaller, self-contained scope than scheduling; I'd design it in full once scheduling
is underway.

---

## 3. Sequencing + what I need from you

Recommended order:

1. **Scheduling** — `0007_scheduling.sql` + the `scheduling` edge function (Cal.com) + the
   agent tools + booking branch in the prompt. Verified against a local Postgres + mock Cal.com,
   same as the phone MVP.
2. **Knowledge base** — native KB switched on for the voice pilot immediately; pgvector RAG
   designed and built as the cross-channel unified KB.

To start the scheduling build I need three things from you:

- **Confirm Cal.com** as the backend (vs. Google Calendar, if a pilot client already lives
  there).
- **A scheduling pilot client** — an appointment-based business (or a test Cal.com account),
  since Bud Club is e-commerce and can't exercise this.
- **The Cal.com setup model** — will each client connect their own Cal.com account, or do you
  run one central Cal.com and provision a managed user per client? (Affects onboarding + creds.)

Say go and I'll build scheduling the same way I built the phone MVP: migration + edge function
+ tools + tests, all verified locally before anything touches a live calendar.

---

Sources: Cal.com API v2 (slots + bookings + platform/managed users) —
https://cal.com/docs/api-reference/v2/introduction ; Cal.com AI-agent scheduling —
https://cal.com/docs/agents ; Calendly is not built for autonomous agents —
https://www.slotflow.dev/blog/calendly-not-built-for-ai-agents ; ElevenLabs agent knowledge
base + RAG — https://elevenlabs.io/docs/eleven-agents/customization/knowledge-base and
https://elevenlabs.io/docs/agents-platform/customization/knowledge-base/rag
