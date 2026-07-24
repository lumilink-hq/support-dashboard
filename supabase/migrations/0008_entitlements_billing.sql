-- =============================================================================
-- 0008_entitlements_billing.sql
-- Self-serve upsell + plan entitlements for the two-avenue product (email, voice).
--
-- The idea (from J's boss): dashboard pages for a plan the client does NOT have
-- are locked and show an upsell prompt. Clicking it sends them to a hosted
-- checkout; on payment we (as automatically as possible) turn the feature on.
--
-- Design rules (consistent with 0001–0007):
--   * Every tenant row carries client_id; RLS scopes it to the caller's tenant.
--   * The dashboard reads entitlements with the end-user JWT (RLS applies) but
--     CANNOT write them — granting/revoking is service-role only, driven by the
--     payment processor's webhook. A client can never self-grant a plan.
--   * The payment PROCESSOR IS NOT DECIDED YET. Nothing here names Stripe/Square
--     in a load-bearing way: the webhook normalizes any provider into a canonical
--     event, and price/plan -> feature mapping lives in DATA (billing_price_map),
--     so wiring a processor later is config, not a migration.
--   * Evolving sets (status, provisioning state) are TEXT + CHECK so adding a
--     value later is an ALTER of the constraint, not a type migration.
--
-- Lifecycle / UI state mapping the dashboard should render per feature:
--   entitlements row missing        -> LOCKED  (show upsell prompt + CTA)
--   status = 'pending'              -> SETUP   ("payment received, setting up…")
--   status = 'active'               -> UNLOCKED
--   status = 'past_due'             -> UNLOCKED + billing warning banner
--   status = 'canceled'            -> LOCKED  (show upsell prompt again)
--
-- Idempotent / safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- feature_t — the sellable capabilities. Today these mirror the two channels;
-- kept as its own enum (not channel_t) so we can sell non-channel features later
-- (e.g. 'analytics') without overloading the conversation channel.
-- -----------------------------------------------------------------------------
do $$ begin
  create type feature_t as enum ('email', 'voice');
exception when duplicate_object then null; end $$;

-- =============================================================================
-- billing_price_map — maps a processor's price/plan identifier to a feature.
-- This is what keeps the webhook processor-agnostic and code-free: when you pick
-- Stripe/Square and create a price, you INSERT one row here instead of editing
-- the function. (processor, external_price_id) is unique.
-- Seed rows are added once the processor + price IDs exist.
-- =============================================================================
create table if not exists billing_price_map (
  id                uuid       primary key default gen_random_uuid(),
  processor         text       not null,                 -- 'stripe' | 'square' | ...
  external_price_id text       not null,                 -- processor's price/plan id
  feature           feature_t  not null,
  -- Optional display price for the upsell prompt (source of truth is the
  -- processor; this is just what the locked page shows).
  display_amount    numeric(12,2),
  display_currency  text       not null default 'usd',
  display_interval  text       not null default 'month',
  is_active         boolean    not null default true,
  created_at        timestamptz not null default now(),
  unique (processor, external_price_id)
);

-- =============================================================================
-- entitlements — one row per (client, feature) the client has engaged with.
-- Absence of a row == locked. This is the table the dashboard reads to decide
-- lock vs unlock, and the table the webhook writes.
-- =============================================================================
create table if not exists entitlements (
  id                       uuid       primary key default gen_random_uuid(),
  client_id                uuid       not null references clients(id) on delete cascade,
  feature                  feature_t  not null,

  status                   text       not null default 'pending'
                           check (status in ('pending','active','past_due','canceled')),

  -- How it was granted: 'checkout' (paid via processor), 'manual' (we flipped it
  -- on for onboarding/comp), 'trial'.
  source                   text       not null default 'checkout'
                           check (source in ('checkout','manual','trial')),

  -- Processor linkage (nullable until a processor is wired). No secrets here —
  -- just the external subscription id so renewals/cancels can find the row.
  processor                text,
  external_subscription_ref text,
  current_period_end       timestamptz,                  -- for renewal / past_due grace

  started_at               timestamptz not null default now(),
  activated_at             timestamptz,                  -- when provisioning finished
  canceled_at              timestamptz,
  meta                     jsonb      not null default '{}'::jsonb,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  unique (client_id, feature)
);

create index if not exists idx_entitlements_client on entitlements(client_id);
create index if not exists idx_entitlements_client_active
  on entitlements(client_id) where status in ('active','past_due');
create index if not exists idx_entitlements_sub_ref
  on entitlements(processor, external_subscription_ref);

create trigger trg_entitlements_updated_at
  before update on entitlements
  for each row execute function set_updated_at();

-- =============================================================================
-- provisioning_tasks — the "as automatic as possible" queue. A grant enqueues
-- one; the provisioner worker (supabase/functions/provision-feature) drains it,
-- does the feature-specific auto steps (buy Twilio number + configure ElevenLabs
-- for voice; wire the Gmail/orchestration for email), then activates the
-- entitlement — or parks it as 'needs_human' when a client-supplied credential
-- is missing. Service-role only; the dashboard reads STATUS off entitlements.
-- =============================================================================
create table if not exists provisioning_tasks (
  id           uuid       primary key default gen_random_uuid(),
  client_id    uuid       not null references clients(id) on delete cascade,
  feature      feature_t  not null,
  status       text       not null default 'queued'
               check (status in ('queued','running','active','needs_human','failed')),
  attempts     int        not null default 0,
  last_error   text,
  detail       jsonb      not null default '{}'::jsonb,   -- e.g. which step blocked
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- At most one open task per (client, feature): keeps the queue idempotent so a
-- duplicate webhook / renewal can't stack up provisioning jobs.
create unique index if not exists uq_provisioning_open
  on provisioning_tasks(client_id, feature)
  where status in ('queued','running','needs_human');

create trigger trg_provisioning_tasks_updated_at
  before update on provisioning_tasks
  for each row execute function set_updated_at();

-- =============================================================================
-- billing_events — raw processor events, for IDEMPOTENCY + audit. The webhook
-- inserts one per event before acting; (processor, external_event_id) is unique
-- so a re-delivered event is a no-op. Never store card data here — only the
-- processor's own event payload, which contains none.
-- =============================================================================
create table if not exists billing_events (
  id                 uuid       primary key default gen_random_uuid(),
  processor          text       not null,
  external_event_id  text       not null,
  event_type         text       not null,                -- canonical: see apply_billing_event
  client_id          uuid       references clients(id) on delete set null,
  feature            feature_t,
  payload            jsonb      not null default '{}'::jsonb,
  result             text,                               -- 'applied'|'duplicate'|'unmapped'|'ignored'
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  unique (processor, external_event_id)
);

create index if not exists idx_billing_events_client on billing_events(client_id, received_at);

-- =============================================================================
-- Row-Level Security
-- entitlements: readable by the owning tenant (dashboard needs it to lock/unlock)
-- but NOT writable by them — no insert/update/delete policy, mirroring how
-- `clients` is select+update-only. The service role bypasses RLS and does all
-- writes via the RPCs below.
-- provisioning_tasks / billing_events / billing_price_map: no policies at all →
-- with RLS enabled, the `authenticated` role sees nothing; only the service role
-- (which bypasses RLS) touches them.
-- =============================================================================
alter table entitlements       enable row level security;
alter table provisioning_tasks enable row level security;
alter table billing_events     enable row level security;
alter table billing_price_map  enable row level security;

create policy entitlements_select on entitlements
  for select using (client_id = current_client_id());

-- =============================================================================
-- has_feature — the one predicate the dashboard / agents call to gate access.
-- Returns true when the client holds a usable entitlement (active or past_due;
-- past_due is still in grace and stays unlocked with a warning). SECURITY DEFINER
-- + fixed search_path so it can be called from RLS-heavy contexts safely.
-- Defaults to the caller's own tenant when p_client_id is omitted.
-- =============================================================================
create or replace function has_feature(p_feature feature_t, p_client_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from entitlements e
    where e.client_id = coalesce(p_client_id, current_client_id())
      and e.feature   = p_feature
      and e.status in ('active','past_due')
  );
$$;

-- -----------------------------------------------------------------------------
-- enqueue_provisioning — insert a queued task unless one is already open for
-- this (client, feature). Relies on the partial unique index for the race.
-- -----------------------------------------------------------------------------
create or replace function enqueue_provisioning(p_client_id uuid, p_feature feature_t)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into provisioning_tasks (client_id, feature, status)
  values (p_client_id, p_feature, 'queued')
  on conflict do nothing;   -- uq_provisioning_open guards duplicates
end;
$$;

-- =============================================================================
-- apply_billing_event — the single entry point the webhook calls after it has
-- verified the signature and normalized the processor payload into canonical
-- fields. Does idempotency, then routes on event_type. Returns a small JSON
-- status the webhook can log/return.
--
-- Canonical event_type values the webhook must map INTO:
--   'subscription_activated' | 'subscription_renewed'  -> grant / keep usable
--   'payment_failed'                                   -> past_due (stays unlocked, grace)
--   'subscription_canceled'                            -> canceled (locks)
-- Anything else is recorded and ignored.
--
-- p_client_id + p_feature come from the checkout metadata or billing_price_map;
-- if either is null the event is stored as 'unmapped' for a human to reconcile.
-- =============================================================================
create or replace function apply_billing_event(
  p_processor          text,
  p_external_event_id  text,
  p_event_type         text,
  p_client_id          uuid,
  p_feature            feature_t,
  p_subscription_ref   text          default null,
  p_current_period_end timestamptz   default null,
  p_payload            jsonb         default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_new    boolean;
  v_result    text;
  v_existing  entitlements%rowtype;
begin
  -- 1) Idempotency: first writer wins; a re-delivered event does nothing.
  insert into billing_events (processor, external_event_id, event_type, client_id, feature, payload)
  values (p_processor, p_external_event_id, p_event_type, p_client_id, p_feature, coalesce(p_payload, '{}'::jsonb))
  on conflict (processor, external_event_id) do nothing;
  get diagnostics v_is_new = row_count;
  if v_is_new = 0 then
    return jsonb_build_object('status','duplicate','event_id',p_external_event_id);
  end if;

  -- 2) Must know who + what. If not, park for manual reconciliation.
  if p_client_id is null or p_feature is null then
    v_result := 'unmapped';
    update billing_events
       set result = v_result, processed_at = now()
     where processor = p_processor and external_event_id = p_external_event_id;
    return jsonb_build_object('status', v_result, 'event_id', p_external_event_id);
  end if;

  -- 3) Route.
  if p_event_type in ('subscription_activated','subscription_renewed') then
    select * into v_existing from entitlements
      where client_id = p_client_id and feature = p_feature;

    if not found then
      -- New grant: create as 'pending' and kick off provisioning.
      insert into entitlements (client_id, feature, status, source, processor,
                                external_subscription_ref, current_period_end)
      values (p_client_id, p_feature, 'pending', 'checkout', p_processor,
              p_subscription_ref, p_current_period_end);
      perform enqueue_provisioning(p_client_id, p_feature);
    elsif v_existing.status = 'active' then
      -- Renewal of a live feature: just extend the period, don't re-provision.
      update entitlements
         set current_period_end = coalesce(p_current_period_end, current_period_end),
             external_subscription_ref = coalesce(p_subscription_ref, external_subscription_ref),
             processor = coalesce(processor, p_processor)
       where id = v_existing.id;
    else
      -- Was canceled/past_due/pending and is now paid again: move to pending and
      -- (re)provision. enqueue is a no-op if a task is already open.
      update entitlements
         set status = 'pending', source = 'checkout', processor = coalesce(processor, p_processor),
             external_subscription_ref = coalesce(p_subscription_ref, external_subscription_ref),
             current_period_end = coalesce(p_current_period_end, current_period_end),
             canceled_at = null
       where id = v_existing.id;
      perform enqueue_provisioning(p_client_id, p_feature);
    end if;
    v_result := 'applied';

  elsif p_event_type = 'payment_failed' then
    update entitlements
       set status = 'past_due'
     where client_id = p_client_id and feature = p_feature
       and status in ('active','pending','past_due');
    v_result := 'applied';

  elsif p_event_type = 'subscription_canceled' then
    update entitlements
       set status = 'canceled', canceled_at = now()
     where client_id = p_client_id and feature = p_feature;
    v_result := 'applied';

  else
    v_result := 'ignored';
  end if;

  update billing_events
     set result = v_result, processed_at = now()
   where processor = p_processor and external_event_id = p_external_event_id;

  return jsonb_build_object('status', v_result, 'client_id', p_client_id, 'feature', p_feature);
end;
$$;

-- =============================================================================
-- activate_entitlement / fail_provisioning — called by the provisioner worker
-- once it has (or has failed to) stand up the feature's infrastructure.
-- =============================================================================
create or replace function activate_entitlement(p_client_id uuid, p_feature feature_t)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update entitlements
     set status = 'active', activated_at = now()
   where client_id = p_client_id and feature = p_feature
     and status <> 'canceled';               -- don't resurrect a canceled plan

  update provisioning_tasks
     set status = 'active'
   where client_id = p_client_id and feature = p_feature
     and status in ('queued','running','needs_human');
end;
$$;

create or replace function fail_provisioning(
  p_client_id uuid,
  p_feature   feature_t,
  p_reason    text,
  p_needs_human boolean default true
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update provisioning_tasks
     set status     = case when p_needs_human then 'needs_human' else 'failed' end,
         attempts   = attempts + 1,
         last_error = p_reason,
         detail     = detail || jsonb_build_object('last_reason', p_reason)
   where client_id = p_client_id and feature = p_feature
     and status in ('queued','running');
  -- Entitlement stays 'pending' → dashboard keeps showing "setting up", not a
  -- broken half-live page.
end;
$$;

-- =============================================================================
-- Grants — RLS (above) governs which ROWS authenticated can see; these are the
-- table-level grants. 0001's default privileges already cover new tables, but we
-- re-assert idempotently to be explicit.
-- =============================================================================
grant select on billing_price_map, entitlements, provisioning_tasks, billing_events
  to service_role;
grant insert, update, delete on billing_price_map, entitlements, provisioning_tasks, billing_events
  to service_role;
grant select on entitlements to authenticated;   -- RLS still scopes to own tenant
