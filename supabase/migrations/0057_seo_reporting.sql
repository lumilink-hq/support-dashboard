-- =============================================================================
-- 0057_seo_reporting.sql — Phase 6 (plan.md): the reporting layer behind
-- module 10 (client portal) and module 13 (monthly report).
--
--   1. seo_rank_trend    per location, per check date: how the tracked keywords
--                        are doing (the ranking line chart).
--   2. seo_geo_radius    per location: the realistic radius it can win in the
--                        local pack, derived from the latest geo grid. ONE
--                        definition, read by both the portal and the report, so
--                        the two can never state different radii.
--   3. seo_reports       one generated monthly report per client (content is the
--                        single source for both the portal page and the PDF).
--   4. Storage bucket seo-reports (PRIVATE) + a tenant-read policy.
--   5. Scheduling        seo_report_targets, request_seo_report,
--                        run_due_seo_reports, cron seo-report-due.
--
-- RULE 4 (plan.md §1). Both views are security_invoker with an explicit revoke
-- before a deliberate grant. Migration 0001's default privileges grant every new
-- view to `authenticated`, and a July 2026 usage view leaked across tenants
-- exactly that way. scripts/test_seo_reporting.sql is the isolation test and
-- lists how to see it fail.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. seo_rank_trend
--
-- Organic and local-pack only: a geo grid row is one cell of a 5x5 sweep, not a
-- keyword's position, so averaging cells into a "rank" would mean nothing.
-- position IS NULL means "not found within the tracked depth"; those rows count
-- towards keywords_checked but not keywords_ranked and are left out of the
-- average (a missing position isn't position 101).
-- -----------------------------------------------------------------------------
create or replace view seo_rank_trend with (security_invoker = true) as
select
  r.client_id,
  r.location_id,
  r.rank_type,
  r.check_date,
  count(*)                                        as keywords_checked,
  count(*) filter (where r.position is not null)  as keywords_ranked,
  count(*) filter (where r.position <= 3)         as top3_count,
  count(*) filter (where r.position <= 10)        as top10_count,
  round(avg(r.position)::numeric, 1)              as avg_position
from seo_rankings r
where r.rank_type in ('organic', 'local_pack')
group by r.client_id, r.location_id, r.rank_type, r.check_date;

revoke all on seo_rank_trend from authenticated, anon;
grant select on seo_rank_trend to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. seo_geo_radius
--
-- The grid is 5x5 with the business at the centre (3,3); a cell's "ring" is its
-- Chebyshev distance from that centre (0, 1 or 2). Cells are 2 km apart
-- (GEO_GRID_SPACING_KM in the seo-rank-tracking function: keep the two in step),
-- so ring 1 is about 2 km out and ring 2 about 4 km.
--
-- A cell is WON when the business is in the local pack there (position 1 to 3).
-- The winnable radius is the outermost ring for which that ring AND every ring
-- inside it are won in at least half of their cells, across the latest sweep of
-- each geo-grid keyword:
--   NULL            not winning even at the business address (ring 0 under half)
--   0               wins at the address only
--   2               wins out to about 2 km
--   4               wins across the whole grid, about 4 km
-- A location with no geo-grid rows at all has NO ROW here; a consumer must treat
-- that as "not measured" (no coordinates, no geo-grid keyword, or no sweep yet),
-- never as zero.
-- -----------------------------------------------------------------------------
create or replace view seo_geo_radius with (security_invoker = true) as
with latest as (
  select client_id, location_id, keyword_id, max(check_date) as check_date
    from seo_rankings
   where rank_type = 'geo_grid'
   group by client_id, location_id, keyword_id
),
cells as (
  select r.client_id, r.location_id, r.keyword_id, r.check_date,
         greatest(abs(r.grid_row - 3), abs(r.grid_col - 3))  as ring,
         (r.position is not null and r.position <= 3)        as in_pack
    from seo_rankings r
    join latest l
      on l.keyword_id = r.keyword_id and l.check_date = r.check_date
   where r.rank_type = 'geo_grid'
),
shares as (
  select client_id, location_id,
         count(distinct keyword_id)                              as keywords_checked,
         max(check_date)                                         as last_check_date,
         avg(in_pack::int) filter (where ring = 0)               as share_ring0,
         avg(in_pack::int) filter (where ring = 1)               as share_ring1,
         avg(in_pack::int) filter (where ring = 2)               as share_ring2
    from cells
   group by client_id, location_id
)
select
  client_id,
  location_id,
  keywords_checked,
  last_check_date,
  round(share_ring0, 2) as share_ring0,
  round(share_ring1, 2) as share_ring1,
  round(share_ring2, 2) as share_ring2,
  2 as grid_spacing_km,
  case
    when coalesce(share_ring0, 0) < 0.5 then null
    when coalesce(share_ring1, 0) < 0.5 then 0
    when coalesce(share_ring2, 0) < 0.5 then 2
    else 4
  end as winnable_radius_km
from shares;

revoke all on seo_geo_radius from authenticated, anon;
grant select on seo_geo_radius to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. seo_reports
--
-- One row per client per calendar month (UTC). `content` is the whole report as
-- data: the portal page renders it and the PDF is drawn from it, so they cannot
-- disagree. Written only by the seo-report function (service role); a tenant can
-- read its own rows and nothing else.
-- -----------------------------------------------------------------------------
create table if not exists seo_reports (
  id            uuid        primary key default gen_random_uuid(),
  client_id     uuid        not null references clients(id) on delete cascade,

  period_start  date        not null,          -- first day of the reported month
  period_end    date        not null,          -- last day of the reported month
  content       jsonb       not null,
  pdf_path      text,                          -- object path inside the seo-reports bucket

  email_status  text        not null default 'pending'
                check (email_status in ('pending', 'sent', 'skipped_no_sender',
                                         'skipped_no_recipient', 'failed')),
  email_error   text,
  emailed_at    timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (client_id, period_start),
  check (period_start = date_trunc('month', period_start)::date),
  check (period_end >= period_start)
);

create index if not exists idx_seo_reports_client_period
  on seo_reports (client_id, period_start desc);

alter table seo_reports enable row level security;

drop policy if exists seo_reports_tenant_select on seo_reports;
create policy seo_reports_tenant_select on seo_reports
  for select using (client_id = current_client_id());

-- Table privileges are separate from RLS, and 0001's default privileges hand
-- every new table to `authenticated`: revoke, then grant read only.
revoke all on seo_reports from authenticated, anon;
grant select on seo_reports to authenticated;
grant select, insert, update, delete on seo_reports to service_role;

-- -----------------------------------------------------------------------------
-- 4. Storage bucket: private, tenant-readable by folder
--
-- Objects live at <client_id>/<yyyy-mm>.pdf. The policy lets a signed-in tenant
-- read only its own folder, so the portal can mint a short-lived signed URL under
-- the user's own session and never needs the service key.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present — create the PRIVATE bucket seo-reports by hand';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('seo-reports', 'seo-reports', false)
  on conflict (id) do update set public = false;

  begin
    drop policy if exists seo_reports_tenant_read on storage.objects;
    create policy seo_reports_tenant_read on storage.objects
      for select to authenticated
      using (
        bucket_id = 'seo-reports'
        and (storage.foldername(name))[1] = current_client_id()::text
      );
  exception when insufficient_privilege then
    raise notice 'could not create the storage policy seo_reports_tenant_read (not the owner of storage.objects); create it in the dashboard: select on bucket seo-reports where (storage.foldername(name))[1] = current_client_id()::text';
  end;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Scheduling: monthly, per client
--
-- The report for a month is due once that month has ended and no report row
-- exists for it. Cron ticks hourly on days 1 to 5 only, so a failed run retries
-- with backoff for five days and then stops rather than nagging all month. The
-- job's own base interval is 27 days (not 30) so February can't push a March
-- report past the window.
-- -----------------------------------------------------------------------------
create or replace view seo_report_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  (
    (ja.next_run_at is null or ja.next_run_at <= now())
    -- No report for the month yet, or one whose email hasn't gone out (never
    -- tried, or failed): re-running is safe, the function keeps a 'sent' report
    -- from sending twice. 'skipped_*' is final: retrying can't change it until
    -- someone configures a sender or adds a user, and the report is in the portal.
    and not exists (
      select 1 from seo_reports r
       where r.client_id = c.id
         and r.period_start = (date_trunc('month', now() at time zone 'utc') - interval '1 month')::date
         and r.email_status not in ('pending', 'failed')
    )
  ) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_report' and ja.entity_id is null
where exists (select 1 from entitlements e where e.client_id = c.id and e.feature = 'seo' and e.status = 'active')
  and exists (select 1 from seo_locations l where l.client_id = c.id and l.is_active);

revoke all on seo_report_targets from authenticated, anon;
grant select on seo_report_targets to service_role;

create or replace function request_seo_report(p_client_id uuid)
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
    raise notice 'pg_net not installed — cannot request a monthly report';
    return null;
  end if;

  if not start_job_attempt(p_client_id, 'seo_report', null) then
    return null;  -- not due yet, or already in flight
  end if;

  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'seo_report_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_report_url / voice_tool_secret not in Vault — cannot request a monthly report';
    perform complete_job_attempt(p_client_id, 'seo_report', false, 'missing_vault_secret', 38880, 1440, null);
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 120000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('client_id', p_client_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = p_client_id and job_type = 'seo_report' and entity_id is null;

  return v_req;
end;
$$;

revoke execute on function request_seo_report(uuid) from public, authenticated;
grant execute on function request_seo_report(uuid) to service_role;

create or replace function run_due_seo_reports(p_max_per_run int default 10)
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
    select client_id from seo_report_targets
     where is_due
     order by next_run_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_report(v_row.client_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;
  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_reports(int) from public, authenticated;
grant execute on function run_due_seo_reports(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — the monthly report is NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-report-due');
  exception when others then null;
  end;
  -- Hourly, days 1 to 5 of each month (UTC).
  perform cron.schedule('seo-report-due', '25 * 1-5 * *', $cron$select run_due_seo_reports();$cron$);
end;
$$;

comment on view seo_geo_radius is
  'The single definition of a location''s winnable local-pack radius. No row = not measured. '
  'security_invoker=true is load-bearing: see scripts/test_seo_reporting.sql.';
comment on view seo_rank_trend is
  'security_invoker=true is load-bearing: see scripts/test_seo_reporting.sql.';
comment on table seo_reports is
  'Monthly report (module 13). content jsonb feeds both the portal page and the PDF. Service-write only.';

-- End of 0057.
