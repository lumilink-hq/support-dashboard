-- =============================================================================
-- 0012_voice_usage_caps.sql
-- Per-client voice spend metering + hard caps.
--
-- WHY: the ElevenLabs minute pool is shared across EVERY client on the
-- workspace. One runaway client, one prank caller sitting on the line, or one
-- outbound loop burns the minutes every other client — and every demo — depends
-- on. When the pool is exhausted, calls fail for everyone at once, with no
-- warning and no way to tell whose traffic did it. Nothing in the schema
-- measured voice usage before this migration.
--
-- WHAT: one row per completed call (voice_usage_events), effective caps read
-- from clients.settings.voice_caps layered over platform defaults, and two
-- service-role RPCs:
--   check_voice_allowance(client)            -> may this client take a call?
--   record_call_usage(client, sid, secs, $)  -> meter a finished call
--
-- The gate is enforced in four places (see docs/tsunami-voice-orders-plan.md §4d);
-- this migration is the data layer all four share.
--
-- Idempotency: record_call_usage dedupes on (client_id, call_sid) and REPORTS
-- the duplicate rather than swallowing it. A silently double-counted call would
-- trip a client's cap and take their phone line down for no reason — the same
-- class of bug as the log_agent_reply/external_ref collision that made agent
-- replies vanish from the dashboard.
--
-- Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Platform-level settings + kill switch (singleton row).
--    Not tenant data: RLS on with NO policy, so only service_role sees it.
-- -----------------------------------------------------------------------------
create table if not exists platform_settings (
  id                       int         primary key default 1 check (id = 1),
  -- Global kill switch: false stops AI calls for EVERY client immediately.
  voice_enabled            boolean     not null default true,
  -- The ElevenLabs plan's monthly minute pool, for the allocation view below.
  plan_minutes             int         not null default 1238,
  -- Applied to any client that hasn't set its own monthly_minutes cap. A new
  -- client must never default to "unlimited".
  default_monthly_minutes  int         not null default 200,
  -- Used to estimate cost when the caller doesn't supply one (ElevenLabs
  -- ~$0.08/min + Twilio ~$0.0085/min + LLM pass-through).
  default_cost_per_min_usd numeric(8,4) not null default 0.10,
  -- Share of the pool that must stay unallocated for demos/support.
  reserve_pct              numeric(5,2) not null default 20.00,
  default_max_call_secs    int         not null default 300,
  note                     text,
  updated_at               timestamptz not null default now()
);

insert into platform_settings (id) values (1) on conflict (id) do nothing;

drop trigger if exists trg_platform_settings_updated_at on platform_settings;
create trigger trg_platform_settings_updated_at
  before update on platform_settings
  for each row execute function set_updated_at();

alter table platform_settings enable row level security;

drop policy if exists platform_settings_read on platform_settings;
-- Readable by signed-in users (it holds no secrets — plan size, default caps,
-- the kill switch), because the usage view resolves defaults through it.
-- No insert/update/delete policy: writes stay owner/service_role only.
create policy platform_settings_read on platform_settings
  for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- 2. The meter. One row per completed call.
-- -----------------------------------------------------------------------------
create table if not exists voice_usage_events (
  id            uuid        primary key default gen_random_uuid(),
  client_id     uuid        not null references clients(id) on delete cascade,
  -- Twilio call SID (same value as conversations.external_ref for the call).
  call_sid      text        not null,
  started_at    timestamptz not null default now(),
  duration_secs int         not null default 0 check (duration_secs >= 0),
  est_cost_usd  numeric(10,4) not null default 0 check (est_cost_usd >= 0),
  -- Where the number came from: 'post_call' (ElevenLabs webhook) or 'manual'.
  source        text        not null default 'post_call',
  created_at    timestamptz not null default now()
);

-- The idempotency key. A re-fired post-call webhook must not double-count.
create unique index if not exists uq_voice_usage_call
  on voice_usage_events (client_id, call_sid);

-- Period rollups scan by client + time.
create index if not exists idx_voice_usage_period
  on voice_usage_events (client_id, started_at desc);

alter table voice_usage_events enable row level security;

drop policy if exists voice_usage_tenant on voice_usage_events;
-- Read-only for the tenant: the dashboard shows usage, but a client must never
-- be able to erase its own meter.
create policy voice_usage_tenant on voice_usage_events
  for select using (client_id = current_client_id());

-- -----------------------------------------------------------------------------
-- 3. Effective caps for a client = clients.settings.voice_caps over platform
--    defaults.
--
--    Semantics for each cap key:
--      absent / null -> inherit the platform default (monthly_minutes) or mean
--                       "no cap" (daily_minutes, monthly_cost_usd)
--      -1            -> explicitly unlimited (an opt-out you have to type)
--      >= 0          -> that value
--
--    SECURITY INVOKER on purpose. It reads `clients`, which is RLS-protected,
--    so a signed-in tenant can only ever resolve its OWN caps — that's what
--    lets the dashboard view call it safely. Inside the service_role RPCs below
--    it runs in their SECURITY DEFINER context and sees everything, as needed.
-- -----------------------------------------------------------------------------
create or replace function client_voice_caps(p_client_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_settings jsonb;
  v_caps     jsonb;
  v_plat     platform_settings%rowtype;
begin
  select settings into v_settings from clients where id = p_client_id;
  if not found then
    return null;
  end if;

  select * into v_plat from platform_settings where id = 1;

  v_caps := coalesce(v_settings -> 'voice_caps', '{}'::jsonb);

  return jsonb_build_object(
    'enabled',          coalesce((v_caps ->> 'enabled')::boolean, true),
    'monthly_minutes',  coalesce((v_caps ->> 'monthly_minutes')::numeric,
                                 v_plat.default_monthly_minutes),
    -- null here means "no daily cap", which is the common case.
    'daily_minutes',    (v_caps ->> 'daily_minutes')::numeric,
    'monthly_cost_usd', (v_caps ->> 'monthly_cost_usd')::numeric,
    'max_call_secs',    coalesce((v_caps ->> 'max_call_secs')::int,
                                 v_plat.default_max_call_secs),
    'cost_per_min_usd', coalesce((v_caps ->> 'cost_per_min_usd')::numeric,
                                 v_plat.default_cost_per_min_usd)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Timezone for period boundaries. A "monthly" cap should roll over on the
--    client's calendar month, not UTC's. An invalid tz string in config must
--    never throw inside the pre-call gate, so it's validated here.
-- -----------------------------------------------------------------------------
create or replace function client_timezone(p_client_id uuid)
returns text
language sql
stable
security invoker   -- same reasoning as client_voice_caps
set search_path = public
as $$
  select coalesce(
    (select tz from (
       select coalesce(
         c.business_hours ->> 'tz',
         c.settings -> 'scheduling' ->> 'timezone'
       ) as tz
       from clients c where c.id = p_client_id
     ) t
     where t.tz is not null
       and exists (select 1 from pg_timezone_names z where z.name = t.tz)),
    'UTC'
  );
$$;

-- -----------------------------------------------------------------------------
-- 5. check_voice_allowance — the pre-call gate.
--
--    Called by voice-personalization BEFORE the agent picks up. Returns
--    allowed=false with a machine-readable reason; the caller turns that into a
--    polite deflect + end_call (roughly 8 seconds of billed time instead of a
--    full conversation).
-- -----------------------------------------------------------------------------
create or replace function check_voice_allowance(p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_caps         jsonb;
  v_tz           text;
  v_plat         platform_settings%rowtype;
  v_active       boolean;
  v_month_start  timestamptz;
  v_day_start    timestamptz;
  v_min_month    numeric := 0;
  v_min_day      numeric := 0;
  v_cost_month   numeric := 0;
  v_cap_min      numeric;
  v_cap_day      numeric;
  v_cap_cost     numeric;
  v_pct          numeric := 0;
  v_reason       text    := 'ok';
  v_allowed      boolean := true;
begin
  select is_active into v_active from clients where id = p_client_id;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'unknown_client');
  end if;

  v_caps := client_voice_caps(p_client_id);
  v_tz   := client_timezone(p_client_id);
  select * into v_plat from platform_settings where id = 1;

  -- Period boundaries in the client's own timezone.
  v_month_start := (date_trunc('month', (now() at time zone v_tz)) at time zone v_tz);
  v_day_start   := (date_trunc('day',   (now() at time zone v_tz)) at time zone v_tz);

  select coalesce(sum(duration_secs), 0) / 60.0,
         coalesce(sum(est_cost_usd), 0)
    into v_min_month, v_cost_month
  from voice_usage_events
  where client_id = p_client_id and started_at >= v_month_start;

  select coalesce(sum(duration_secs), 0) / 60.0
    into v_min_day
  from voice_usage_events
  where client_id = p_client_id and started_at >= v_day_start;

  v_cap_min  := (v_caps ->> 'monthly_minutes')::numeric;
  v_cap_day  := (v_caps ->> 'daily_minutes')::numeric;
  v_cap_cost := (v_caps ->> 'monthly_cost_usd')::numeric;

  if v_cap_min is not null and v_cap_min > 0 then
    v_pct := round((v_min_month / v_cap_min) * 100, 1);
  end if;

  -- Reason precedence: the broadest/most deliberate switch wins, so an operator
  -- flipping the kill switch always sees 'global_pause' rather than a cap.
  if not coalesce(v_plat.voice_enabled, true) then
    v_allowed := false; v_reason := 'global_pause';
  elsif not coalesce(v_active, true) then
    v_allowed := false; v_reason := 'client_inactive';
  elsif not coalesce((v_caps ->> 'enabled')::boolean, true) then
    v_allowed := false; v_reason := 'client_disabled';
  elsif v_cap_min is not null and v_cap_min >= 0 and v_min_month >= v_cap_min then
    v_allowed := false; v_reason := 'over_monthly_minutes';
  elsif v_cap_cost is not null and v_cap_cost >= 0 and v_cost_month >= v_cap_cost then
    v_allowed := false; v_reason := 'over_monthly_cost';
  elsif v_cap_day is not null and v_cap_day >= 0 and v_min_day >= v_cap_day then
    v_allowed := false; v_reason := 'over_daily_minutes';
  end if;

  return jsonb_build_object(
    'allowed',            v_allowed,
    'reason',             v_reason,
    'minutes_used',       round(v_min_month, 2),
    'minutes_cap',        v_cap_min,
    'minutes_remaining',  case
                            when v_cap_min is null or v_cap_min < 0 then null
                            else greatest(round(v_cap_min - v_min_month, 2), 0)
                          end,
    'pct_used',           v_pct,
    'warn',               v_pct >= 80,
    'daily_minutes_used', round(v_min_day, 2),
    'daily_minutes_cap',  v_cap_day,
    'cost_used',          round(v_cost_month, 2),
    'cost_cap',           v_cap_cost,
    'max_call_secs',      (v_caps ->> 'max_call_secs')::int,
    'timezone',           v_tz,
    'period_start',       v_month_start
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. record_call_usage — the meter.
--
--    Called by voice-call-logger after each call. Idempotent on the call SID,
--    and it TELLS YOU whether it inserted: `recorded` false + `duplicate` true
--    means the webhook re-fired. Never let a double-count be invisible.
--
--    p_est_cost_usd is optional — when the caller doesn't know the real cost we
--    derive it from duration × the effective per-minute rate, so cost caps work
--    without ElevenLabs reporting a figure.
-- -----------------------------------------------------------------------------
create or replace function record_call_usage(
  p_client_id     uuid,
  p_call_sid      text,
  p_duration_secs int,
  p_est_cost_usd  numeric default null,
  p_started_at    timestamptz default null,
  p_source        text default 'post_call'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_caps        jsonb;
  v_tz          text;
  v_rate        numeric;
  v_secs        int;
  v_cost        numeric;
  v_started     timestamptz;
  v_id          uuid;
  v_month_start timestamptz;
  v_min_before  numeric := 0;
  v_min_after   numeric := 0;
  v_cap_min     numeric;
  v_pct_before  numeric := 0;
  v_pct_after   numeric := 0;
begin
  if p_client_id is null or coalesce(trim(p_call_sid), '') = '' then
    return jsonb_build_object(
      'recorded', false, 'duplicate', false, 'error', 'client_id and call_sid are required');
  end if;

  if not exists (select 1 from clients where id = p_client_id) then
    return jsonb_build_object(
      'recorded', false, 'duplicate', false, 'error', 'unknown_client');
  end if;

  v_caps    := client_voice_caps(p_client_id);
  v_tz      := client_timezone(p_client_id);
  v_rate    := (v_caps ->> 'cost_per_min_usd')::numeric;
  -- A negative duration is a bad payload, not negative usage.
  v_secs    := greatest(coalesce(p_duration_secs, 0), 0);
  v_cost    := coalesce(p_est_cost_usd, round((v_secs / 60.0) * v_rate, 4));
  v_started := coalesce(p_started_at, now());

  v_month_start := (date_trunc('month', (now() at time zone v_tz)) at time zone v_tz);

  select coalesce(sum(duration_secs), 0) / 60.0 into v_min_before
  from voice_usage_events
  where client_id = p_client_id and started_at >= v_month_start;

  insert into voice_usage_events
    (client_id, call_sid, started_at, duration_secs, est_cost_usd, source)
  values
    (p_client_id, trim(p_call_sid), v_started, v_secs, greatest(v_cost, 0), p_source)
  on conflict (client_id, call_sid) do nothing
  returning id into v_id;

  select coalesce(sum(duration_secs), 0) / 60.0 into v_min_after
  from voice_usage_events
  where client_id = p_client_id and started_at >= v_month_start;

  v_cap_min := (v_caps ->> 'monthly_minutes')::numeric;
  if v_cap_min is not null and v_cap_min > 0 then
    v_pct_before := round((v_min_before / v_cap_min) * 100, 1);
    v_pct_after  := round((v_min_after  / v_cap_min) * 100, 1);
  end if;

  return jsonb_build_object(
    'recorded',      v_id is not null,
    -- The whole point of this field: a re-fired webhook is visible, not silent.
    'duplicate',     v_id is null,
    'usage_id',      v_id,
    'call_sid',      trim(p_call_sid),
    'duration_secs', v_secs,
    'est_cost_usd',  round(greatest(v_cost, 0), 4),
    'minutes_used',  round(v_min_after, 2),
    'minutes_cap',   v_cap_min,
    'pct_used',      v_pct_after,
    'over_cap',      v_cap_min is not null and v_cap_min >= 0 and v_min_after >= v_cap_min,
    -- True only on the call that crosses 80%, so an alert fires once.
    'crossed_warning', v_pct_before < 80 and v_pct_after >= 80
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Dashboard views.
-- -----------------------------------------------------------------------------

-- Per-client usage for the current calendar month (in the client's timezone).
--
-- security_invoker is LOAD-BEARING. 0001 sets default privileges granting
-- authenticated select/insert/update/delete on every future table AND VIEW in
-- this schema, so this view is automatically tenant-readable. A normal view
-- executes with its OWNER's rights, which would bypass the RLS on
-- voice_usage_events and hand every tenant every other tenant's usage. With
-- security_invoker the underlying policies apply to the querying user instead.
create or replace view voice_usage_current with (security_invoker = true) as
select
  c.id   as client_id,
  c.name as client_name,
  c.slug,
  coalesce(u.calls, 0)                            as calls,
  round(coalesce(u.secs, 0) / 60.0, 2)            as minutes_used,
  round(coalesce(u.cost, 0), 2)                   as cost_used,
  (client_voice_caps(c.id) ->> 'monthly_minutes')::numeric as minutes_cap,
  case
    when coalesce(u.calls, 0) = 0 then null
    else round((u.secs / 60.0) / u.calls, 2)
  end                                             as avg_call_minutes
from clients c
left join lateral (
  select count(*)                     as calls,
         sum(v.duration_secs)::numeric as secs,
         sum(v.est_cost_usd)          as cost
  from voice_usage_events v
  where v.client_id = c.id
    and v.started_at >= (date_trunc('month',
          (now() at time zone client_timezone(c.id))) at time zone client_timezone(c.id))
) u on true;

-- Are we over-allocated against the plan? Sum of caps should stay at or under
-- (100 - reserve_pct)% of the pool, so a demo always has minutes available.
create or replace view voice_cap_allocation as
select
  p.plan_minutes,
  p.reserve_pct,
  round(p.plan_minutes * (100 - p.reserve_pct) / 100.0, 0) as allocatable_minutes,
  coalesce(sum(
    case
      when (client_voice_caps(c.id) ->> 'monthly_minutes')::numeric < 0 then null
      else (client_voice_caps(c.id) ->> 'monthly_minutes')::numeric
    end
  ), 0) as allocated_minutes,
  bool_or((client_voice_caps(c.id) ->> 'monthly_minutes')::numeric < 0) as has_unlimited_client,
  coalesce(sum(
    case
      when (client_voice_caps(c.id) ->> 'monthly_minutes')::numeric < 0 then null
      else (client_voice_caps(c.id) ->> 'monthly_minutes')::numeric
    end
  ), 0) > round(p.plan_minutes * (100 - p.reserve_pct) / 100.0, 0) as over_allocated
from platform_settings p
left join clients c on c.is_active
group by p.plan_minutes, p.reserve_pct;

-- -----------------------------------------------------------------------------
-- 8. Grants — orchestration RPCs are service_role only, same as 0002/0006.
-- -----------------------------------------------------------------------------
revoke execute on function client_voice_caps(uuid) from public;
revoke execute on function client_timezone(uuid) from public;
revoke execute on function check_voice_allowance(uuid) from public;
revoke execute on function record_call_usage(uuid, text, int, numeric, timestamptz, text) from public;

-- The two helpers are SECURITY INVOKER and read RLS-protected tables, so they
-- are safe for the dashboard to call directly.
grant execute on function client_voice_caps(uuid) to authenticated, service_role;
grant execute on function client_timezone(uuid) to authenticated, service_role;
-- The gate and the meter are service_role only.
grant execute on function check_voice_allowance(uuid) to service_role;
grant execute on function record_call_usage(uuid, text, int, numeric, timestamptz, text) to service_role;

-- The meter is tenant-READABLE (RLS scopes it) but never tenant-writable.
-- 0001's default privileges hand `authenticated` write grants on every new
-- table, so revoke them explicitly rather than relying on the absence of an RLS
-- policy alone — defense in depth against a future permissive policy.
revoke insert, update, delete on voice_usage_events from authenticated, anon;
grant select on voice_usage_events to authenticated, service_role;

grant select on voice_usage_current to authenticated, service_role;

-- Cross-tenant aggregate: operators only. Default privileges would otherwise
-- expose every client's cap to every signed-in user.
revoke all on voice_cap_allocation from authenticated, anon;
grant select on voice_cap_allocation to service_role;

-- platform_settings: readable via the RLS policy above, never writable.
revoke insert, update, delete on platform_settings from authenticated, anon;

comment on table voice_usage_events is
  'One row per completed voice call. Unique on (client_id, call_sid) — the '
  'idempotency key for re-fired post-call webhooks. Tenant-readable, never '
  'tenant-writable.';
comment on table platform_settings is
  'Singleton. voice_enabled=false is the global kill switch for ALL AI calls.';

-- End of 0012.
