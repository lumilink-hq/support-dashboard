# Onboarding a real client

How to take a new HVAC/service company live on LumiLink. There are two layers: the
**per-client config** (done for every client) and three **platform gaps** to close so that
config is all it takes.

## The architecture you already have

Because the agent resolves the client from the **dialed number** (`resolve_client_by_number`
on `system__called_number`), **one shared agent can serve every client** — a call to client
A's number books into client A, a call to client B's number books into client B, with no
per-client agent. Tools and the post-call webhook are workspace-level, so they apply to all
clients automatically. The single thing that isn't multi-tenant yet is the **prompt**, which
hardcodes Comfort Air's name + services. That's what the conversation-initiation webhook
(gap #1 below) fixes.

## Per-client onboarding steps

For each new client:

1. **Workspace + login.** The owner signs up at `/signup` (business name + email) — the
   provisioning trigger creates their `clients` row + an admin user, so they can log into the
   dashboard. (Or seed the client by SQL like `seed_hvac_client.sql`.)
2. **Services + pricing.** In the dashboard **Services** page, add their catalog (fixed vs
   call-out+quote, price, duration, emergency-eligible). This is the list the agent quotes from.
3. **Scheduling config.** Set `settings.scheduling` — timezone, weekly `hours`, slot
   granularity, min-notice, service area. *Currently SQL only (see gap #2).*
4. **Phone number.** Buy a Twilio number for the client, import it into ElevenLabs, and set it
   on the client row (`clients.phone_number`, E.164) via the **Settings → Voice & phone**
   section. Optionally set a transfer number.
5. **Attach the number to the shared agent.** The number just needs to point at the one agent
   that has the tools + prompt + post-call webhook. No new agent per client.
6. **Test call.** Dial the client's number, book a job, confirm it lands in their dashboard.

If gap #1 isn't built yet, step 5 becomes "duplicate the agent and hardcode this client's
name/services in the prompt" — works immediately but is one agent per client, which doesn't
scale. Building gap #1 makes step 5 truly config-only.

## The three gaps to close for smooth production

1. **Conversation-initiation webhook (the linchpin for multi-client).** A small edge function
   ElevenLabs calls when a call starts: it resolves the client by dialed number and returns
   that client's `business_name`, `service_list`, `service_area`, and persona as
   `dynamic_variables`. The prompt then uses `{{business_name}}` etc. instead of hardcoded
   Comfort Air. Build this once → onboarding a client is purely the config steps above, one
   shared agent for everyone.
2. **Scheduling-config UI.** Today the Services editor exists, but the weekly hours / timezone
   / service area (`settings.scheduling`) are only settable by SQL. A Settings section for
   these makes onboarding fully self-serve in the dashboard.
3. **Confirmation email.** Bookings currently record + log but don't email the customer. Before
   real customers rely on it, wire a send (Resend/SES) from the `book` path — a single call in
   the scheduling function.

Optional / later: **external calendar sync** (Google/Cal.com) if a client wants bookings in the
calendar they already use rather than only the dashboard; per-technician dispatch; reminders +
deposits; the knowledge base.

**Web widget (demo/marketing site).** The in-browser "Talk to Lumi" widget is currently disabled
on `/demo` because a browser call has no dialed number, so the shared (dynamic `called_number`)
agent can't resolve a client and `check_availability` fails. To re-enable it, point the widget at
a **dedicated demo agent** whose tools send a **constant** `called_number` (`+12135332469`) — that
agent serves only the sandbox client, so hardcoding is correct there and it doesn't touch the
shared multi-client phone agent. Alternatively, once the conversation-init webhook (gap #1) exists,
the widget's agent can carry a fixed client id for the demo.

## Recommended order

Build **#1 (conversation-init webhook)** first — it's what turns "onboarding" from "clone an
agent and edit a prompt" into "add a client row, services, hours, and a number." Then **#3
(confirmation email)** so customers get a booking confirmation, and **#2 (scheduling UI)** so
the whole flow is dashboard-only. After those three, onboarding a client is a ~15-minute config
task with no code or SQL.

## Automated voice provisioning (`provision-feature`)

Once a client's `voice` entitlement is granted (paid, or flipped on manually), the
`provision-feature` worker stands the feature up automatically: it ensures the client has a
phone number and imports+assigns it to the one shared ElevenLabs agent, then flips the
entitlement to `active` so the dashboard page unlocks itself. No store credentials are required
for a scheduling client (that gate only applies when `store_platform` is set for order lookup).

Run it either on a one-minute Supabase cron, or fire-and-forget from the billing webhook after a
grant. It drains the whole queue and is idempotent, so double-triggering is harmless. Anything it
can't finish (no number and auto-purchase off, missing API creds, no numbers available) parks the
task as `needs_human` with a reason — the entitlement stays `pending` ("setting up…") rather than
half-activating.

Env to set (secrets):

- `PROVISION_MODE` — `mock` (default; makes **no** external calls, just exercises the queue) or
  `live` to actually buy/import numbers. Leave it on `mock` until the rest is set.
- `AUTO_PURCHASE_NUMBERS` — `1` to buy a number when the client has none; `0` (default) to
  require a bring-your-own number set in Settings / on the client row.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — used both to purchase numbers and as the creds
  ElevenLabs stores when importing. `TWILIO_AREA_CODE` (optional) — default area code for
  purchases; a per-client `settings.scheduling.area_code` overrides it.
- `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` — the API key and the id of the **shared** agent
  every number is assigned to.

Deploy: `supabase functions deploy provision-feature --no-verify-jwt` and set the secrets above.
Smoke test in `mock` mode first (grant a client `voice` with a `phone_number` already set → the
worker should activate it without any external call). Then set `PROVISION_MODE=live`.

NOTE: the ElevenLabs import body uses the `sid` / `token` / `provider:"twilio"` field names
(ElevenLabs `POST /v1/convai/phone-numbers`, assign via `PATCH …/{id} { agent_id }`). If ElevenLabs
changes that schema, `twilioImportBody()` in the function is the one place to adjust.
