# Email Agent — Zap ↔ Supabase Build Reference

How the email Zap wires together, step by step, with the exact Supabase calls. One
multi-tenant Zap handles every client; the client is resolved per email from a
plus-addressed alias. The Zap acts as a backend service, so **every Supabase call uses
the `service_role` key and bypasses RLS** — that key lives only in Zapier.

Prereqs: migrations `0001` + `0002` applied, and each client's WooCommerce + ShipStation
creds stored in Supabase Vault (see *Onboarding a client* at the end).

---

## Connections & constants

Store these in Zapier (account-level, not per-client):

- `SUPABASE_URL` — `https://<ref>.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — service role JWT
- Anthropic API key
- Gmail connection for the central processing inbox

Per-client store/shipping creds are **not** stored in Zapier — they're resolved at
runtime from Vault (Step 2).

### Two call shapes you'll reuse

**PostgREST (tables):**

```
GET/POST {SUPABASE_URL}/rest/v1/<table>?<filters>
  apikey: {SERVICE_ROLE_KEY}
  Authorization: Bearer {SERVICE_ROLE_KEY}
  Content-Type: application/json
```

**RPC (functions):** body keys must match the SQL argument names exactly (the `p_`
names).

```
POST {SUPABASE_URL}/rest/v1/rpc/<function>
  (same headers)
  { "p_arg": value, ... }
```

In Zapier these are "Webhooks by Zapier → Custom Request" (or Code steps). Each is one
task — the running tally is at the end.

---

## The Zap, step by step

### 0. Trigger — Gmail "New Email" (processing inbox)

Catch-all/plus-addressed inbox. Capture: `from`, `to` (the `proc+<slug>@…` address),
`subject`, body (plain text), **Gmail message id**, **Gmail thread id**.

### 1. Resolve the client from the `+<slug>` tag

Parse `+<slug>` out of the recipient (Formatter/Code), then:

```
GET {SUPABASE_URL}/rest/v1/clients
    ?slug=eq.{slug}
    &select=id,name,store_platform,store_base_url,abnormal_status_rules,brand_tone_config,settings,support_email
```

No row → stop (unknown alias). Otherwise carry `client_id` + config forward.

### 2. Resolve integration secrets (Vault)

```
POST {SUPABASE_URL}/rest/v1/rpc/get_client_integration_secrets
{ "p_client_id": "{client_id}" }
```

Returns `{ "woocommerce": "<json>", "shipstation": "<json>" }`. JSON-parse each to get
the WooCommerce consumer key/secret + base URL and the ShipStation api key/secret.

### 3. Extract the order number — **Haiku 4.5**

Anthropic Messages call, `model: claude-haiku-4-5`, system prompt asking for the order
number as strict JSON (`{"order_number": "..."} | {"order_number": null}`). Cache the
system prompt.

- **No order number found** → reply asking for it, then log and stop:
  1. `ingest_email` (Step 4) with `p_order_number: null`.
  2. Send the "what's your order number?" reply via Gmail.
  3. `log_agent_reply` with `p_new_status: "awaiting_customer"`.

### 4. Ingest the inbound email (log + upsert conversation)

```
POST {SUPABASE_URL}/rest/v1/rpc/ingest_email
{
  "p_client_id": "{client_id}",
  "p_thread_ref": "{gmail_thread_id}",
  "p_message_ref": "{gmail_message_id}",
  "p_customer_identifier": "{from_email}",
  "p_customer_name": "{from_name}",
  "p_subject": "{subject}",
  "p_body": "{body_plain}",
  "p_order_number": "{order_number}",
  "p_role": "customer"
}
```

Returns the **conversation id** (uuid). Idempotent: a re-fired trigger with the same
`p_message_ref` won't double-log.

### 5. Fetch the order — WooCommerce

Branch on `clients.settings.order_number_scheme`:

- `"id"` (default): `GET {store_base_url}/wp-json/wc/v3/orders/{order_number}`
- `"meta:<key>"`: `GET {store_base_url}/wp-json/wc/v3/orders?meta_key={key}&meta_value={order_number}` → take the first result.

Auth: WooCommerce consumer key/secret from Step 2 (HTTP Basic over HTTPS, or
`?consumer_key=…&consumer_secret=…`). A 404 / empty result is the **order-not-found**
path — don't fabricate an answer; reply asking the customer to confirm, and/or flag.

Pull from the response: status, `date_created`, total, currency, line items, billing
name/email.

> ⚠️ Confirm per store: core WooCommerce REST doesn't always filter arbitrary
> `meta_key`/`meta_value` unless the sequential-number plugin registers it. If a store's
> plugin doesn't, fall back to the `search` param.

### 6. Fetch shipping — ShipStation

```
GET https://ssapi.shipstation.com/shipments?orderNumber={order_number}
  Authorization: Basic base64(api_key:api_secret)
```

Take the matching shipment for tracking number / carrier / ship date. (Order *status*
is on `/orders?orderNumber=`; tracking is on `/shipments`.)

> ⚠️ Confirm the exact endpoint + field names against current ShipStation docs before
> relying on them — don't hardcode field paths from memory.

### 7. Normalize + cache the order

Map WooCommerce + ShipStation into the `orders_cache` shape, then upsert:

```
POST {SUPABASE_URL}/rest/v1/orders_cache?on_conflict=client_id,order_number
  Prefer: resolution=merge-duplicates
{
  "client_id": "{client_id}",
  "order_number": "{order_number}",
  "store_platform": "{platform}",
  "store_status": "{status}",
  "customer_name": "...", "customer_email": "...",
  "currency": "USD", "order_total": 142.00,
  "order_placed_at": "{date_created ISO}",
  "line_items": [ ... ],
  "tracking_number": "...", "carrier": "...", "shipping_status": "...",
  "shipped_at": "...", "estimated_delivery": "...",
  "raw_store": { ... }, "raw_shipping": { ... },
  "fetched_at": "{now}"
}
```

### 8. Evaluate the flag rule

```
POST {SUPABASE_URL}/rest/v1/rpc/evaluate_flag
{
  "p_client_id": "{client_id}",
  "p_store_status": "{normalized status}",
  "p_order_placed_at": "{order_placed_at ISO}"
}
```

Returns `{ "flagged": bool, "reason": "abnormal_status" | "order_over_24h" | null }`.

### 9. If flagged → enqueue for a human (Zapier Path/Filter on `flagged == true`)

```
POST {SUPABASE_URL}/rest/v1/rpc/apply_flag
{
  "p_conversation_id": "{conversation_id}",
  "p_reason": "{reason}",
  "p_details": "Order #{order_number} flagged: {reason}."
}
```

Marks the conversation flagged and adds one (deduped) review-queue item.

### 10. Draft the reply — **Sonnet 4.6**

Anthropic Messages call, `model: claude-sonnet-4-6`. System = brand/tone + policy
(cached). User content = normalized order context + the thread, **plus a `flagged` /
`flag_reason` signal**:

- flagged → a conservative **holding reply** (acknowledge, a teammate will follow up; no
  commitments).
- not flagged → the full answer (status, tracking, etc.).

Cache the system prompt, brand rules, and order context.

### 11. Send — Gmail "Reply to Email"

Reply on the original thread id. Capture the **sent Gmail message id**.

### 12. Log the outbound reply

```
POST {SUPABASE_URL}/rest/v1/rpc/log_agent_reply
{
  "p_conversation_id": "{conversation_id}",
  "p_body": "{reply text}",
  "p_model": "claude-sonnet-4-6",
  "p_message_ref": "{sent_gmail_message_id}",
  "p_new_status": "{flagged | awaiting_customer | resolved}"
}
```

Idempotent on `p_message_ref`; advances the conversation status.

---

## Task count & cost

Per email, the happy path is roughly: trigger (free) + client lookup + secrets +
Haiku + ingest + Woo fetch + ShipStation + cache + evaluate + draft + send + log ≈
**11 billed actions** (one more on a flag). That's above the 4–5 baseline — the RPCs
already collapse what would otherwise be several writes into single calls. The two
levers as volume climbs: prompt caching on the Claude steps, and moving the
orchestration off Zapier (Make/n8n) once task counts dominate the bill.

## Idempotency & errors

- `ingest_email` and `log_agent_reply` dedupe on `external_ref` (Gmail message id), so
  reruns are safe.
- WooCommerce/ShipStation failures or rate limits must **never** produce a confident
  wrong answer — route to `review_queue` (or send a holding reply) and retry with
  backoff. Never log secrets.

## Onboarding a client (config, not deployment)

1. Insert the `clients` row (Tally/Typeform → row, or by hand): name, slug,
   `store_platform`, `store_base_url`, `support_email`, `abnormal_status_rules`,
   `brand_tone_config`, business hours, and `settings.order_number_scheme`.
2. Create the Vault secrets and point the row's refs at them:
   ```sql
   select vault.create_secret('{"consumer_key":"…","consumer_secret":"…","base_url":"…"}',
                              '<slug>_woocommerce');
   select vault.create_secret('{"api_key":"…","api_secret":"…"}', '<slug>_shipstation');
   update clients set store_credentials_ref = '<slug>_woocommerce',
                      shipstation_credentials_ref = '<slug>_shipstation'
   where slug = '<slug>';
   ```
3. Have the client forward their support mail to `proc+<slug>@<your-domain>`.

No Zap changes — the same Zap now serves the new client.

## To confirm before go-live

- WooCommerce meta-key filtering support for each store's plugin (else use `search`).
- ShipStation tracking endpoint + exact field names.
- Whether `order_number_scheme` is `"id"` or `"meta:<key>"` per store.
