-- =============================================================================
-- 0007_scheduling.sql
-- Scheduling MVP (HVAC service assistant). Additive. Source of truth for
-- availability + bookings is THIS database (the app renders its own calendar);
-- external calendar sync (Google/Cal.com) is a later, additive step, so the
-- appointment carries a nullable provider/calendar_event_ref for that future.
--
-- Adds:
--   * services         — per-client price list the agent quotes from.
--   * appointments     — the booked job, with revenue fields + a no-overlap
--                        exclusion constraint (single-calendar double-book guard).
--   * conversations.booking_outcome — lead capture (booked / lead_only / ...).
--   * book_appointment / capture_lead RPCs (service_role, like 0002/0006).
--
-- Idempotent where practical.
-- =============================================================================

create extension if not exists btree_gist;  -- gist over (uuid =, tstzrange &&)

-- =============================================================================
-- services — one row per bookable service per client. price_type drives revenue:
--   'fixed' -> price is the whole ticket; 'quote' -> callout_fee is known at
--   booking, the real job value is estimated/finalized later.
-- =============================================================================
create table if not exists services (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references clients(id) on delete cascade,
  name                 text not null,
  category             text,
  price_type           text not null default 'fixed'
                       check (price_type in ('fixed','quote')),
  price                numeric(12,2),          -- fixed mode: the ticket price
  callout_fee          numeric(12,2),          -- quote mode: trip/diagnostic fee
  default_duration_min int  not null default 60,
  emergency_eligible   boolean not null default false,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_services_client on services(client_id) where active;

create trigger trg_services_updated_at
  before update on services
  for each row execute function set_updated_at();

-- =============================================================================
-- appointments — the booked job. client_id scopes RLS; conversation_id links the
-- call. Revenue is modeled so the dashboard can sum committed vs estimated vs
-- realized. provider/calendar_event_ref stay 'none'/null until an external
-- calendar sync is connected (Phase 2).
-- =============================================================================
create table if not exists appointments (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references clients(id) on delete cascade,
  conversation_id   uuid references conversations(id) on delete set null,
  service_id        uuid references services(id) on delete set null,
  service_name      text,                                    -- snapshot

  customer_name     text,
  customer_email    text,
  customer_phone    text,
  service_address   text,                                    -- job site (HVAC = on-site)
  is_emergency      boolean not null default false,

  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  timezone          text,

  status            text not null default 'booked'
                    check (status in ('booked','confirmed','rescheduled','cancelled','completed','no_show')),
  source            text not null default 'voice'
                    check (source in ('voice','web','phone','manual')),

  -- External calendar (Phase 2). Null in the Supabase-native MVP.
  provider          text not null default 'none'
                    check (provider in ('none','google','cal_com')),
  calendar_event_ref text,
  assigned_tech_id  uuid,                                    -- future technicians table

  -- Revenue.
  currency          text not null default 'USD',
  price_type        text check (price_type in ('fixed','quote')),
  committed_amount  numeric(12,2),   -- fixed price, or the callout fee at booking
  estimated_value   numeric(12,2),   -- quote pipeline (set later)
  final_value       numeric(12,2),   -- after the visit
  deposit_amount    numeric(12,2),
  revenue_status    text not null default 'committed'
                    check (revenue_status in ('committed','estimated','realized')),

  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  check (ends_at > starts_at)
);

create index if not exists idx_appt_client_start  on appointments(client_id, starts_at);
create index if not exists idx_appt_client_status on appointments(client_id, status);
create index if not exists idx_appt_conversation  on appointments(conversation_id);

create trigger trg_appointments_updated_at
  before update on appointments
  for each row execute function set_updated_at();

-- No two live appointments for the same client may overlap (single-calendar MVP;
-- becomes per-tech when assigned_tech_id is added to the key). Cancelled/no-show
-- rows are excluded so a freed slot can be rebooked.
do $$ begin
  alter table appointments add constraint appt_no_overlap
    exclude using gist (
      client_id with =,
      tstzrange(starts_at, ends_at) with &&
    ) where (status not in ('cancelled','no_show'));
exception when duplicate_object then null; end $$;

-- =============================================================================
-- Lead capture: what a call resulted in. Null for pre-scheduling rows.
-- =============================================================================
alter table conversations add column if not exists booking_outcome text
  check (booking_outcome in ('booked','lead_only','info','transferred'));

-- =============================================================================
-- RLS — tenant-scoped, same rule as every other table.
-- =============================================================================
alter table services     enable row level security;
alter table appointments enable row level security;

drop policy if exists services_tenant on services;
create policy services_tenant on services
  for all using (client_id = current_client_id())
  with check (client_id = current_client_id());

drop policy if exists appointments_tenant on appointments;
create policy appointments_tenant on appointments
  for all using (client_id = current_client_id())
  with check (client_id = current_client_id());

grant select, insert, update, delete on services, appointments
  to authenticated, service_role;
grant select on services, appointments to anon;

-- =============================================================================
-- book_appointment — atomic booking. Derives the revenue snapshot from the
-- service, inserts the appointment (the exclusion constraint prevents a
-- double-book under races), and marks the conversation 'booked'. Returns a
-- jsonb result the edge function relays to the agent.
--   { "ok": true,  "appointment_id": "...", "service_name": "...",
--     "committed_amount": 99.00, "starts_at": "..." }
--   { "ok": false, "reason": "slot_unavailable" }
-- =============================================================================
create or replace function book_appointment(
  p_client_id       uuid,
  p_service_id      uuid,
  p_service_name    text,
  p_conversation_id uuid,
  p_customer_name   text,
  p_customer_email  text,
  p_customer_phone  text,
  p_service_address text,
  p_is_emergency    boolean,
  p_starts_at       timestamptz,
  p_ends_at         timestamptz,
  p_timezone        text,
  p_notes           text default null,
  p_source          text default 'voice'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price_type text;
  v_price      numeric(12,2);
  v_callout    numeric(12,2);
  v_name       text := p_service_name;
  v_committed  numeric(12,2);
  v_rev_status text := 'committed';
  v_id         uuid;
begin
  if p_service_id is not null then
    select price_type, price, callout_fee, name
      into v_price_type, v_price, v_callout, v_name
    from services where id = p_service_id and client_id = p_client_id;
  end if;

  -- Revenue snapshot.
  if v_price_type = 'quote' then
    v_committed  := v_callout;                       -- fee known now; job value TBD
    v_rev_status := case when v_callout is not null then 'committed' else 'estimated' end;
  elsif v_price_type = 'fixed' then
    v_committed  := v_price;
    v_rev_status := 'committed';
  end if;

  begin
    insert into appointments (
      client_id, conversation_id, service_id, service_name,
      customer_name, customer_email, customer_phone, service_address, is_emergency,
      starts_at, ends_at, timezone, source,
      price_type, committed_amount, revenue_status, notes
    ) values (
      p_client_id, p_conversation_id, p_service_id, coalesce(v_name, p_service_name),
      p_customer_name, p_customer_email, p_customer_phone, p_service_address,
      coalesce(p_is_emergency, false),
      p_starts_at, p_ends_at, p_timezone, coalesce(p_source, 'voice'),
      v_price_type, v_committed, v_rev_status, p_notes
    )
    returning id into v_id;
  exception
    when exclusion_violation or unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'slot_unavailable');
  end;

  if p_conversation_id is not null then
    update conversations
      set booking_outcome = 'booked', updated_at = now()
    where id = p_conversation_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'appointment_id', v_id,
    'service_name', coalesce(v_name, p_service_name),
    'committed_amount', v_committed,
    'starts_at', p_starts_at
  );
end;
$$;

-- =============================================================================
-- capture_lead — the caller didn't book. Mark the conversation a lead and make
-- sure we kept their contact so the shop can follow up (the transcript already
-- holds the detail via voice-call-logger).
-- =============================================================================
create or replace function capture_lead(
  p_conversation_id uuid,
  p_customer_name   text default null,
  p_customer_phone  text default null,
  p_outcome         text default 'lead_only'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update conversations
    set booking_outcome    = coalesce(p_outcome, 'lead_only'),
        customer_name       = coalesce(customer_name, p_customer_name),
        customer_identifier = coalesce(customer_identifier, p_customer_phone),
        updated_at          = now()
  where id = p_conversation_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Orchestration RPCs -> service_role only, like 0002/0006.
-- -----------------------------------------------------------------------------
revoke execute on function book_appointment(uuid,uuid,text,uuid,text,text,text,text,boolean,timestamptz,timestamptz,text,text,text) from public;
revoke execute on function capture_lead(uuid,text,text,text) from public;
grant  execute on function book_appointment(uuid,uuid,text,uuid,text,text,text,text,boolean,timestamptz,timestamptz,text,text,text) to service_role;
grant  execute on function capture_lead(uuid,text,text,text) to service_role;

-- End of 0007.
