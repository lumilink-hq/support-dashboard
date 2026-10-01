-- =============================================================================
-- 0061_seo_search_console.sql
-- Module 21 (plan.md, Phase 6b): Search Console traffic. A daily pull of the
-- Search Analytics API per Search Console PROPERTY, so the portal and the
-- monthly report can show clicks, impressions, CTR, ranking-keyword counts,
-- top pages and traffic value.
--
-- PER PROPERTY, NOT PER LOCATION. A property is seo_locations.
-- search_console_site_url (module 17; nothing derives it). Several locations
-- often share one site, so every table here is keyed on (client_id, site_url)
-- and one pull serves all of them. The job itself is per client (job_attempts
-- entity_id NULL, like module 20): one Google connection per client, and the
-- function loops over that client's distinct properties.
--
-- TABLES (all vendor-written: tenant read-only, service_role writes)
--   seo_search_properties    — sync state per property: status, last date with
--                              final data, whether the 16-month backfill is done.
--   seo_search_daily         — true daily totals (device 'all') plus the
--                              per-device split. Totals come from a date-only
--                              query, never from summing query rows, because
--                              Search Console omits anonymised queries from
--                              query-level rows.
--   seo_search_monthly_pages / seo_search_monthly_queries
--                            — the top 500 pages / queries per month. Page URLs
--                              are normalised before storing (lib.ts), so one
--                              article is one row.
--   seo_search_keyword_counts — per month, how many distinct queries showed the
--                              site at all / on page one / in the top 3,
--                              counted over ALL query rows before trimming.
--   seo_client_settings      — the value per click used for "traffic value".
--                              Set by LumiLink staff, so tenant read-only.
--   seo_milestones           — operator-entered chart markers ("site migration").
--
-- VIEW seo_search_console_targets (scheduling) — rule 4: security_invoker plus
-- an explicit revoke. Isolation and scheduling are tested by
-- scripts/test_seo_search_console.sql.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

create table if not exists seo_search_properties (
  client_id        uuid        not null references clients(id) on delete cascade,
  site_url         text        not null,
  -- pending: never pulled. ok: last pull worked. not_connected: no Google
  -- connection with the Search Console scope. no_access: Google refused this
  -- property for the connected account (not verified / not an owner). error:
  -- anything else (last_error says what).
  status           text        not null default 'pending'
                   check (status in ('pending', 'ok', 'not_connected', 'no_access', 'error')),
  data_through     date,        -- the last day with final data we hold
  backfilled_at    timestamptz, -- the 16-month backfill of daily totals finished
  -- Months whose page / query rollups still need building. The edge runtime's
  -- CPU limit allows only a couple of months per call (each is tens of
  -- thousands of query rows), so a backfill drains this over several calls,
  -- newest month first, rescheduling itself every 15 minutes until empty.
  months_pending   date[]      not null default '{}',
  last_synced_at   timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  primary key (client_id, site_url)
);

create table if not exists seo_search_daily (
  client_id    uuid    not null references clients(id) on delete cascade,
  site_url     text    not null,
  date         date    not null,
  device       text    not null default 'all' check (device in ('all', 'desktop', 'mobile', 'tablet')),
  clicks       int     not null default 0,
  impressions  int     not null default 0,
  ctr          numeric,
  position     numeric,

  primary key (client_id, site_url, date, device)
);

create table if not exists seo_search_monthly_pages (
  client_id    uuid    not null references clients(id) on delete cascade,
  site_url     text    not null,
  month        date    not null check (extract(day from month) = 1),
  page         text    not null,  -- normalised URL
  clicks       int     not null default 0,
  impressions  int     not null default 0,
  position     numeric,           -- impression-weighted across the merged variants

  primary key (client_id, site_url, month, page)
);

create table if not exists seo_search_monthly_queries (
  client_id    uuid    not null references clients(id) on delete cascade,
  site_url     text    not null,
  month        date    not null check (extract(day from month) = 1),
  query        text    not null,
  clicks       int     not null default 0,
  impressions  int     not null default 0,
  position     numeric,

  primary key (client_id, site_url, month, query)
);

create table if not exists seo_search_keyword_counts (
  client_id    uuid    not null references clients(id) on delete cascade,
  site_url     text    not null,
  month        date    not null check (extract(day from month) = 1),
  total        int     not null default 0,
  page_one     int     not null default 0,  -- average position <= 10
  top_three    int     not null default 0,  -- average position <= 3
  -- false while the month is still running (or its last days aren't final):
  -- partial months are shown separately and never compared as if complete.
  is_complete  boolean not null default false,
  days_covered int     not null default 0,

  primary key (client_id, site_url, month)
);

create table if not exists seo_client_settings (
  client_id                 uuid        primary key references clients(id) on delete cascade,
  -- Traffic value = clicks x this. A replacement value, not revenue. $2 is the
  -- rate PACKS's previous agency report used, so their numbers carry over.
  value_per_click_cents     int         not null default 200 check (value_per_click_cents between 0 and 100000),
  updated_at                timestamptz not null default now()
);

create table if not exists seo_milestones (
  id           uuid        primary key default gen_random_uuid(),
  client_id    uuid        not null references clients(id) on delete cascade,
  occurred_on  date        not null,
  label        text        not null check (length(btrim(label)) between 2 and 80),
  created_at   timestamptz not null default now()
);

create index if not exists idx_seo_search_daily_client_date on seo_search_daily(client_id, date desc);
create index if not exists idx_seo_milestones_client on seo_milestones(client_id, occurred_on);

drop trigger if exists trg_seo_search_properties_updated_at on seo_search_properties;
create trigger trg_seo_search_properties_updated_at
  before update on seo_search_properties
  for each row execute function set_updated_at();

drop trigger if exists trg_seo_client_settings_updated_at on seo_client_settings;
create trigger trg_seo_client_settings_updated_at
  before update on seo_client_settings
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS: every table is tenant read-only. 0001's default privileges give
-- `authenticated` full CRUD on new tables, so the write grants are revoked
-- outright as well (same defense in depth as 0042 / 0053).
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'seo_search_properties', 'seo_search_daily', 'seo_search_monthly_pages',
    'seo_search_monthly_queries', 'seo_search_keyword_counts',
    'seo_client_settings', 'seo_milestones'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_tenant_select', t);
    execute format('create policy %I on %I for select using (client_id = current_client_id())', t || '_tenant_select', t);
    execute format('revoke all on %I from anon', t);
    execute format('revoke insert, update, delete on %I from authenticated', t);
    execute format('grant select on %I to authenticated, service_role', t);
    execute format('grant insert, update, delete on %I to service_role', t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Scheduling — per client, daily, on job_attempts with a NULL entity_id. Due
-- when the client has at least one active location with a Search Console
-- property set. Whether Google is connected is the function's call: it records
-- 'not_connected' on the property (so the portal can say so) rather than this
-- view silently never running.
-- -----------------------------------------------------------------------------
create or replace view seo_search_console_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_search_console' and ja.entity_id is null
where exists (
  select 1 from seo_locations l
   where l.client_id = c.id and l.is_active and nullif(btrim(l.search_console_site_url), '') is not null
);

revoke all on seo_search_console_targets from authenticated, anon;
grant select on seo_search_console_targets to service_role;

create or replace function request_seo_search_console(p_client_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url    text;
  v_secret text;
  v_req    bigint;
begin
  if to_regproc('net.http_post') is null then
    raise notice 'pg_net not installed — cannot request a Search Console pull';
    return null;
  end if;

  if not start_job_attempt(p_client_id, 'seo_search_console', null) then
    return null;  -- not due yet, or already in flight
  end if;

  -- Vendor budget ('google', 0048) is reserved INSIDE the edge function, per
  -- Search Analytics call, not per dispatch.

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_search_console_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_search_console_url / voice_tool_secret not in Vault — cannot request a Search Console pull';
    perform complete_job_attempt(p_client_id, 'seo_search_console', false, 'missing_vault_secret',
                                  1440, 1440, null);
    return null;
  end if;

  -- 150 s: the first run backfills 16 months (a few dozen API calls).
  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 150000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('client_id', p_client_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = p_client_id and job_type = 'seo_search_console' and entity_id is null;

  return v_req;
end;
$$;

revoke execute on function request_seo_search_console(uuid) from public, authenticated;
grant execute on function request_seo_search_console(uuid) to service_role;

create or replace function run_due_seo_search_console(p_max_per_run int default 25)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row       record;
  v_requested int := 0;
  v_skipped   int := 0;
begin
  for v_row in
    select client_id from seo_search_console_targets
     where is_due
     order by next_run_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_search_console(v_row.client_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_search_console(int) from public, authenticated;
grant execute on function run_due_seo_search_console(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic Search Console pull NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-search-console-due');
  exception when others then null;
  end;
  -- Every 15 minutes (at :05, :20, :35, :50). A client normally runs once a
  -- day (next_run_at); the short tick only matters while a backfill's monthly
  -- rollups are queued, when the function reschedules itself 15 minutes out.
  perform cron.schedule('seo-search-console-due', '5,20,35,50 * * * *',
    $cron$select run_due_seo_search_console();$cron$);
end;
$$;

-- SETUP AFTER APPLYING (once per project):
--   1. The Search Console API is enabled in the Google Cloud project (module 2).
--   2. select vault.create_secret(
--        'https://<ref>.functions.supabase.co/seo-search-console',
--        'seo_search_console_url', '');
--   3. supabase functions deploy seo-search-console --no-verify-jwt
--   4. Per client, optionally: insert into seo_client_settings (client_id, value_per_click_cents)
--      values ('<uuid>', 200) on conflict (client_id) do update set value_per_click_cents = excluded.value_per_click_cents;
-- Then verify with:  select * from seo_search_console_targets;
--                    select run_due_seo_search_console();

-- End of 0061.
