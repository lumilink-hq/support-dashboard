-- =============================================================================
-- 0001_init_schema.sql
-- Multi-tenant AI customer support — shared schema for Email (live) + Voice (additive).
--
-- Design rules:
--   * Every tenant-scoped row carries client_id; RLS enforces isolation.
--   * The dashboard reads with the end-user's JWT (RLS applies).
--   * The orchestration layer (Zap / future workers) writes with the service role,
--     which BYPASSES RLS by design. Never expose the service key to the browser.
--   * Voice is built into the shape now (channel, audio_url, phone_number, caller
--     reasons) so enabling it later is config + code, not a migration.
--   * Store/shipping data is normalized into stable columns modeled on WooCommerce
--     + ShipStation first; full payloads live in raw_* JSONB so new providers or
--     fields (Shopify, etc.) need no migration.
--
-- Idempotent where practical so it can be re-applied in a fresh environment.
-- =============================================================================

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- -----------------------------------------------------------------------------
-- Enumerated types (closed sets). Adding a value later: ALTER TYPE ... ADD VALUE.
-- Evolving sets (statuses, flag reasons) use TEXT + CHECK instead, which is
-- cheaper to change.
-- -----------------------------------------------------------------------------
do $$ begin
  create type channel_t as enum ('email', 'voice');
exception when duplicate_object then null; end $$;

do $$ begin
  create type message_role_t as enum ('customer', 'agent', 'human');
exception when duplicate_object then null; end $$;

do $$ begin
  create type store_platform_t as enum ('woocommerce', 'shopify');
exception when duplicate_object then null; end $$;

do $$ begin
  create type user_role_t as enum ('admin', 'agent', 'viewer');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- updated_at trigger helper
-- -----------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- clients — one row per business/website/tenant. New client = new row.
-- =============================================================================
create table if not exists clients (
  id                       uuid primary key default gen_random_uuid(),
  name                     text        not null,
  slug                     text        not null unique,           -- url-safe handle
  is_active                boolean     not null default true,

  -- Store integration (WooCommerce now; Shopify additive via store_platform).
  store_platform           store_platform_t,                      -- null until configured
  store_base_url           text,                                  -- e.g. https://shop.example.com
  -- Secrets are NEVER stored here. These point at a secret manager / Supabase Vault
  -- entry. The orchestration layer resolves the ref at runtime.
  store_credentials_ref    text,
  shipstation_credentials_ref text,

  -- Channel addresses.
  support_email            text,                                  -- Gmail address the email agent watches
  phone_number             text,                                  -- inbound voice line (additive)

  -- Per-client config, kept as JSONB so onboarding can map a form straight in.
  brand_tone_config        jsonb       not null default '{}'::jsonb,
  -- Abnormal-status rules are per-client and still TBD. Shape intentionally open,
  -- e.g. {"abnormal_statuses": ["on-hold","failed"], "stale_after_hours": 24}.
  abnormal_status_rules    jsonb       not null default '{}'::jsonb,
  business_hours           jsonb       not null default '{}'::jsonb,
  settings                 jsonb       not null default '{}'::jsonb,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create trigger trg_clients_updated_at
  before update on clients
  for each row execute function set_updated_at();

-- =============================================================================
-- users — dashboard logins, scoped to exactly one client.
-- PK mirrors auth.users(id) so the JWT subject maps directly to a row.
-- =============================================================================
create table if not exists users (
  id          uuid primary key references auth.users(id) on delete cascade,
  client_id   uuid        not null references clients(id) on delete cascade,
  email       text        not null,
  full_name   text,
  role        user_role_t not null default 'agent',
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists idx_users_client on users(client_id);

-- -----------------------------------------------------------------------------
-- current_client_id() — the tenant of the calling user.
-- SECURITY DEFINER + a stable search_path so policies on other tables can call it
-- without triggering recursive RLS on `users`.
-- -----------------------------------------------------------------------------
create or replace function current_client_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select client_id from public.users where id = auth.uid();
$$;

-- =============================================================================
-- conversations — one thread per channel. Same shape for email + voice.
-- =============================================================================
create table if not exists conversations (
  id                uuid       primary key default gen_random_uuid(),
  client_id         uuid       not null references clients(id) on delete cascade,
  channel           channel_t  not null,

  -- Customer identity: email address (email) or phone number (voice).
  customer_identifier text,
  customer_name       text,

  subject           text,                                         -- email subject; null for voice
  -- Lifecycle. TEXT+CHECK (not enum) so we can add states without a type migration.
  status            text       not null default 'open'
                    check (status in ('open','awaiting_customer','flagged','resolved','closed')),
  flagged           boolean    not null default false,
  flag_reason       text,
  assignee          uuid       references users(id) on delete set null,

  -- Order under discussion (unified order number), once known.
  order_number      text,

  -- External system handle: Gmail thread id (email) or Twilio call SID (voice).
  external_ref      text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_message_at   timestamptz
);

create index if not exists idx_conv_client_status  on conversations(client_id, status);
create index if not exists idx_conv_client_channel on conversations(client_id, channel);
create index if not exists idx_conv_client_flagged on conversations(client_id) where flagged;
create index if not exists idx_conv_external_ref   on conversations(client_id, external_ref);
create index if not exists idx_conv_order_number   on conversations(client_id, order_number);

create trigger trg_conversations_updated_at
  before update on conversations
  for each row execute function set_updated_at();

-- =============================================================================
-- messages — turns within a conversation. client_id denormalized for RLS + scale.
-- =============================================================================
create table if not exists messages (
  id              uuid           primary key default gen_random_uuid(),
  conversation_id uuid           not null references conversations(id) on delete cascade,
  client_id       uuid           not null references clients(id) on delete cascade,
  role            message_role_t not null,
  body            text,                                           -- transcript / email text
  audio_url       text,                                           -- voice recording (additive)

  -- Provenance for agent turns: which model produced it, token/cost telemetry.
  model           text,
  meta            jsonb          not null default '{}'::jsonb,
  external_ref    text,                                           -- Gmail message id, etc.

  created_at      timestamptz    not null default now()
);

create index if not exists idx_msg_conversation on messages(conversation_id, created_at);
create index if not exists idx_msg_client       on messages(client_id, created_at);

-- =============================================================================
-- orders_cache — normalized snapshot, keyed by client_id + unified order number.
-- Stable columns modeled on WooCommerce + ShipStation; raw_* holds full payloads
-- so adding Shopify or new fields needs no migration.
-- =============================================================================
create table if not exists orders_cache (
  id                  uuid       primary key default gen_random_uuid(),
  client_id           uuid       not null references clients(id) on delete cascade,
  order_number        text       not null,                        -- unified order number
  store_platform      store_platform_t,

  -- Store-side (normalized).
  store_status        text,                                       -- raw store status string
  is_abnormal         boolean,                                    -- cached eval of abnormal_status_rules
  customer_name       text,
  customer_email      text,
  currency            text,
  order_total         numeric(12,2),
  order_placed_at     timestamptz,                                -- drives the >24h flag rule
  line_items          jsonb      not null default '[]'::jsonb,

  -- Shipping-side (normalized from ShipStation).
  tracking_number     text,
  carrier             text,
  shipping_status     text,
  shipped_at          timestamptz,
  estimated_delivery  timestamptz,

  -- Full fidelity for anything not promoted to a column.
  raw_store           jsonb      not null default '{}'::jsonb,
  raw_shipping        jsonb      not null default '{}'::jsonb,

  fetched_at          timestamptz not null default now(),         -- staleness marker
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (client_id, order_number)
);

create index if not exists idx_orders_client_fetched on orders_cache(client_id, fetched_at);

create trigger trg_orders_cache_updated_at
  before update on orders_cache
  for each row execute function set_updated_at();

-- =============================================================================
-- review_queue — items needing a human. One per flag event.
-- =============================================================================
create table if not exists review_queue (
  id              uuid       primary key default gen_random_uuid(),
  client_id       uuid       not null references clients(id) on delete cascade,
  conversation_id uuid       references conversations(id) on delete cascade,
  -- Reason. TEXT+CHECK so new triggers (incl. voice) don't need a type migration.
  reason          text       not null
                  check (reason in ('order_over_24h','abnormal_status','caller_request','no_order_id','other')),
  details         text,
  status          text       not null default 'pending'
                  check (status in ('pending','resolved','dismissed')),
  assignee        uuid       references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

create index if not exists idx_review_client_status on review_queue(client_id, status);
create index if not exists idx_review_conversation  on review_queue(conversation_id);

-- =============================================================================
-- Row-Level Security
-- Tenant rule: a row is visible/writable to a user iff its client_id matches the
-- user's client. Service role bypasses RLS, so the orchestration layer is
-- unaffected. clients/users get their own tailored policies.
-- =============================================================================
alter table clients       enable row level security;
alter table users         enable row level security;
alter table conversations enable row level security;
alter table messages      enable row level security;
alter table orders_cache  enable row level security;
alter table review_queue  enable row level security;

-- clients: a user can see and update only their own client row.
create policy clients_select on clients
  for select using (id = current_client_id());
create policy clients_update on clients
  for update using (id = current_client_id())
  with check (id = current_client_id());

-- users: can see co-tenants; can update only their own profile row.
create policy users_select on users
  for select using (client_id = current_client_id());
create policy users_update_self on users
  for update using (id = auth.uid())
  with check (id = auth.uid());

-- Generic tenant tables: full CRUD scoped to the caller's client.
create policy conversations_tenant on conversations
  for all using (client_id = current_client_id())
  with check (client_id = current_client_id());

create policy messages_tenant on messages
  for all using (client_id = current_client_id())
  with check (client_id = current_client_id());

create policy orders_cache_tenant on orders_cache
  for all using (client_id = current_client_id())
  with check (client_id = current_client_id());

create policy review_queue_tenant on review_queue
  for all using (client_id = current_client_id())
  with check (client_id = current_client_id());

-- =============================================================================
-- Grants
-- RLS decides which ROWS a role may see; table GRANTs decide whether the role
-- may touch the table at all. Tables created by raw SQL migrations do NOT
-- reliably inherit Supabase's anon/authenticated grants, so without these the
-- `authenticated` role gets "permission denied for table ...". RLS (above) still
-- governs row visibility, so granting here does not widen row access.
-- =============================================================================
grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on all tables in schema public
  to authenticated, service_role;
grant select on all tables in schema public to anon;

-- Same privileges for any tables added later in this schema.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public
  grant select on tables to anon;
