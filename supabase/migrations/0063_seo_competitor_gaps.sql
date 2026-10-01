-- =============================================================================
-- 0063_seo_competitor_gaps.sql
-- Module 23 (plan.md, Phase 6c): competitor keyword gap. For each location and
-- each of its active competitors, the searches the competitor ranks for in
-- Google's top 20 that the location's website doesn't show up for at all
-- (DataForSEO Labs domain_intersection with intersections=false), monthly.
--
-- WHY. Module 16 picks article topics from seo_keyword_gaps (0056), which only
-- scores keywords the client already tracks, so it could never find a topic
-- nobody entered. seo-content now also draws on this module's gaps, under
-- tighter rules (see seo-content/lib.ts competitorGapScore) and still behind
-- the uniqueness checks and a human approval.
--
-- TABLES (vendor-written, tenant read-only)
--   seo_competitor_keyword_gaps — one row per (location, competitor, phrase),
--                                 replaced wholesale per pair on every fetch.
--   seo_competitor_gap_fetches  — when each (location, competitor) pair was
--                                 last fetched and how many rows came back, so
--                                 "fetched, found nothing" differs from "never
--                                 fetched" (the pull-forward relies on that).
--   seo_competitor_gap_dismissals — phrases the client said no to, per client.
--                                 Written only by dismiss_seo_competitor_gap().
--
-- VIEW seo_competitor_gaps — one row per (location, phrase) across that
-- location's ACTIVE competitors, minus phrases the location already tracks and
-- phrases the client dismissed. Tenant-readable (security_invoker, so RLS on
-- the base tables applies). The portal and seo-content both read it.
--
-- Scheduling: per LOCATION (competitors are per location), monthly, hourly
-- cron at :58. A location is pulled forward when it has an active competitor
-- that has never been fetched (a competitor just added).
--
-- Isolation and scheduling: scripts/test_seo_competitor_gaps.sql.
-- Idempotent / safe to re-apply.
-- =============================================================================

create table if not exists seo_competitor_keyword_gaps (
  id                   uuid        primary key default gen_random_uuid(),
  client_id            uuid        not null references clients(id) on delete cascade,
  location_id          uuid        not null references seo_locations(id) on delete cascade,
  competitor_id        uuid        not null references seo_competitors(id) on delete cascade,
  keyword              text        not null check (length(keyword) between 2 and 80),
  competitor_position  int         not null check (competitor_position between 1 and 100),
  competitor_url       text,
  search_volume        int,
  cpc                  numeric,
  keyword_difficulty   int         check (keyword_difficulty between 0 and 100),
  main_intent          text        check (main_intent in ('informational', 'navigational', 'commercial', 'transactional')),
  fetched_at           timestamptz not null default now(),

  unique (location_id, competitor_id, keyword)
);

create index if not exists idx_seo_competitor_keyword_gaps_location on seo_competitor_keyword_gaps(location_id);
create index if not exists idx_seo_competitor_keyword_gaps_client on seo_competitor_keyword_gaps(client_id);

create table if not exists seo_competitor_gap_fetches (
  client_id      uuid        not null references clients(id) on delete cascade,
  location_id    uuid        not null references seo_locations(id) on delete cascade,
  competitor_id  uuid        not null references seo_competitors(id) on delete cascade,
  target_domain  text        not null,  -- the location's site, as sent
  competitor_domain text     not null,  -- the competitor, as sent
  fetched_at     timestamptz not null default now(),
  item_count     int         not null default 0,
  -- true when the rows were copied from a sibling location's fetch rather than
  -- bought; only real fetches are copied, so copies can't chain stale data.
  copied         boolean     not null default false,

  primary key (location_id, competitor_id)
);

alter table seo_competitor_gap_fetches add column if not exists copied boolean not null default false;

create table if not exists seo_competitor_gap_dismissals (
  client_id     uuid        not null references clients(id) on delete cascade,
  keyword       text        not null,
  dismissed_at  timestamptz not null default now(),

  primary key (client_id, keyword)
);

-- -----------------------------------------------------------------------------
-- RLS: tenant read-only on all three (same block as 0061 / 0062).
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['seo_competitor_keyword_gaps', 'seo_competitor_gap_fetches', 'seo_competitor_gap_dismissals'] loop
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
-- Reporting view. Rule 4: security_invoker plus an explicit revoke, then a
-- deliberate grant to authenticated (RLS on the base tables scopes it).
-- -----------------------------------------------------------------------------
create or replace view seo_competitor_gaps with (security_invoker = true) as
select
  g.client_id,
  g.location_id,
  g.keyword,
  count(distinct g.competitor_id)::int                       as competitors_ranking,
  min(g.competitor_position)                                 as best_competitor_position,
  array_agg(c.domain || ' #' || g.competitor_position order by g.competitor_position, c.domain) as competitor_positions,
  max(g.search_volume)                                       as search_volume,
  max(g.cpc)                                                 as cpc,
  max(g.keyword_difficulty)                                  as keyword_difficulty,
  (array_agg(g.main_intent order by g.competitor_position))[1] as main_intent,
  max(g.fetched_at)                                          as fetched_at
from seo_competitor_keyword_gaps g
join seo_competitors c on c.id = g.competitor_id and c.is_active
join seo_locations l on l.id = g.location_id and l.is_active
where not exists (
        select 1 from seo_keywords k
         where k.location_id = g.location_id and k.is_active and k.keyword = g.keyword
      )
  and not exists (
        select 1 from seo_competitor_gap_dismissals d
         where d.client_id = g.client_id and d.keyword = g.keyword
      )
group by g.client_id, g.location_id, g.keyword;

revoke all on seo_competitor_gaps from authenticated, anon;
grant select on seo_competitor_gaps to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Dismiss a gap phrase for the caller's client (every location). Idempotent;
-- returns false only when there is no caller client or the phrase is blank.
-- -----------------------------------------------------------------------------
create or replace function dismiss_seo_competitor_gap(p_keyword text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client  uuid := current_client_id();
  v_keyword text := lower(btrim(regexp_replace(coalesce(p_keyword, ''), '\s+', ' ', 'g')));
begin
  if v_client is null or length(v_keyword) < 2 or length(v_keyword) > 80 then
    return false;
  end if;
  insert into seo_competitor_gap_dismissals (client_id, keyword)
  values (v_client, v_keyword)
  on conflict (client_id, keyword) do nothing;
  return true;
end;
$$;

revoke execute on function dismiss_seo_competitor_gap(text) from public, anon;
grant execute on function dismiss_seo_competitor_gap(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Scheduling — per location, monthly.
-- -----------------------------------------------------------------------------
create or replace view seo_competitor_gap_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from seo_locations l
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_competitor_gaps' and ja.entity_id = l.id
where l.is_active
  and l.website_url is not null
  and exists (select 1 from seo_competitors c where c.location_id = l.id and c.is_active);

revoke all on seo_competitor_gap_targets from authenticated, anon;
grant select on seo_competitor_gap_targets to service_role;

create or replace function request_seo_competitor_gaps(p_location_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client_id uuid;
  v_url    text;
  v_secret text;
  v_req    bigint;
begin
  select client_id into v_client_id from seo_locations where id = p_location_id;
  if v_client_id is null then
    return null;
  end if;

  if to_regproc('net.http_post') is null then
    raise notice 'pg_net not installed — cannot request a competitor gap pull';
    return null;
  end if;

  if not start_job_attempt(v_client_id, 'seo_competitor_gaps', p_location_id) then
    return null;  -- not due yet, or already in flight
  end if;

  -- Vendor budget ('dataforseo') is reserved INSIDE the edge function, per call
  -- (one per competitor).

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_competitor_gaps_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_competitor_gaps_url / voice_tool_secret not in Vault — cannot request a competitor gap pull';
    perform complete_job_attempt(v_client_id, 'seo_competitor_gaps', false, 'missing_vault_secret',
                                  43200, 1440, p_location_id);
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 60000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('location_id', p_location_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = v_client_id and job_type = 'seo_competitor_gaps' and entity_id = p_location_id;

  return v_req;
end;
$$;

revoke execute on function request_seo_competitor_gaps(uuid) from public, authenticated;
grant execute on function request_seo_competitor_gaps(uuid) to service_role;

create or replace function run_due_seo_competitor_gaps(p_max_per_run int default 25)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row       record;
  v_requested int := 0;
  v_skipped   int := 0;
  v_pulled    int := 0;
begin
  -- Pull forward a location with an active competitor that has never been
  -- fetched (just added). Never while backing off or within 6 hours of the
  -- last run. The function records a fetch row even when nothing comes back,
  -- so this can't fire every tick.
  update job_attempts ja
     set next_run_at = now()
   where ja.job_type = 'seo_competitor_gaps'
     and ja.entity_id is not null
     and ja.status = 'idle'
     and ja.attempt_count = 0
     and ja.next_run_at > now()
     and (ja.last_run_at is null or ja.last_run_at < now() - interval '6 hours')
     and exists (
       select 1 from seo_competitors c
        where c.location_id = ja.entity_id and c.is_active
          and not exists (
            select 1 from seo_competitor_gap_fetches f
             where f.location_id = c.location_id and f.competitor_id = c.id
          )
     );
  get diagnostics v_pulled = row_count;

  for v_row in
    select location_id from seo_competitor_gap_targets
     where is_due
     order by next_run_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_competitor_gaps(v_row.location_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'pulled_forward', v_pulled, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_competitor_gaps(int) from public, authenticated;
grant execute on function run_due_seo_competitor_gaps(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic competitor gap pull NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-competitor-gaps-due');
  exception when others then null;
  end;
  -- Hourly at :58 (keyword research is :55). Each location normally runs once
  -- every 30 days; the hourly tick lets a new competitor's gaps show up fast.
  perform cron.schedule('seo-competitor-gaps-due', '58 * * * *',
    $cron$select run_due_seo_competitor_gaps();$cron$);
end;
$$;

-- SETUP AFTER APPLYING (once per project):
--   1. DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are already set (module 7).
--   2. select vault.create_secret(
--        'https://<ref>.supabase.co/functions/v1/seo-competitor-gaps',
--        'seo_competitor_gaps_url', '');
--   3. supabase functions deploy seo-competitor-gaps --no-verify-jwt
--   4. Redeploy seo-content (it now reads seo_competitor_gaps).
-- Then verify with:  select * from seo_competitor_gap_targets;
--                    select run_due_seo_competitor_gaps();

-- End of 0063.
