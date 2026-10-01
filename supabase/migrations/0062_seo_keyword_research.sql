-- =============================================================================
-- 0062_seo_keyword_research.sql
-- Module 22 (plan.md, Phase 6c): keyword research and suggestions. Until now
-- a client typed its keywords from memory and never saw how often anyone
-- searches for them. This adds:
--
--   seo_keyword_metrics      — search volume, CPC, competition, keyword
--                              difficulty and intent for every keyword the
--                              client tracks (DataForSEO Labs keyword_overview).
--   seo_keyword_suggestions  — keywords worth tracking, from two sources:
--       'search_console' — searches the site already shows up for at an
--                          average position of 8 to 20 in the last complete
--                          month (module 21's seo_search_monthly_queries).
--                          No vendor call to find them, only to size them.
--       'related'        — DataForSEO Labs keyword_ideas seeded with the
--                          client's tracked keywords.
--
-- PER CLIENT, NOT PER LOCATION. Volume belongs to a search phrase, not to a
-- location, so metrics are keyed (client_id, keyword) and one run serves every
-- location. Suggestions are per client too; the portal adds one to whichever
-- location is on screen. Job: job_attempts with a NULL entity_id, monthly.
--
-- NEW KEYWORDS DON'T WAIT A MONTH. run_due_seo_keyword_research pulls a
-- client's next run forward when an active keyword has no metrics yet, or a
-- Search Console backfill finished after the last successful run, as long as
-- the job isn't backing off and didn't run in the last 6 hours.
--
-- Both tables are vendor-written: tenant SELECT only. Dismissing a suggestion
-- goes through dismiss_seo_keyword_suggestion() (SECURITY DEFINER, own client
-- only), so a tenant never holds UPDATE on the table and can't rewrite the
-- numbers on a suggestion.
--
-- COUNTRY-LEVEL DATA. Volumes are for the US (location_code 2840, English),
-- the same fallback rank tracking uses; local phrases ("plumber tulsa") carry
-- the city in the phrase itself. The columns record which market was asked.
--
-- Isolation and scheduling are tested by scripts/test_seo_keyword_research.sql.
-- Idempotent / safe to re-apply.
-- =============================================================================

create table if not exists seo_keyword_metrics (
  client_id           uuid        not null references clients(id) on delete cascade,
  keyword             text        not null,   -- lower-cased, single-spaced (cleanKeyword)
  search_volume       int,                    -- monthly average; null = no data for this phrase
  cpc                 numeric,                -- USD
  competition_level   text        check (competition_level in ('LOW', 'MEDIUM', 'HIGH')),
  keyword_difficulty  int         check (keyword_difficulty between 0 and 100),
  main_intent         text        check (main_intent in ('informational', 'navigational', 'commercial', 'transactional')),
  monthly_searches    jsonb       not null default '[]'::jsonb,  -- [{year, month, search_volume}], newest first
  location_code       int         not null,
  language_code       text        not null,
  fetched_at          timestamptz not null default now(),

  primary key (client_id, keyword)
);

create table if not exists seo_keyword_suggestions (
  id                  uuid        primary key default gen_random_uuid(),
  client_id           uuid        not null references clients(id) on delete cascade,
  keyword             text        not null check (length(keyword) between 2 and 80),
  source              text        not null check (source in ('search_console', 'related')),
  search_volume       int,
  cpc                 numeric,
  keyword_difficulty  int         check (keyword_difficulty between 0 and 100),
  main_intent         text        check (main_intent in ('informational', 'navigational', 'commercial', 'transactional')),
  -- source = 'search_console' only: the property and month the evidence is from.
  site_url            text,
  gsc_month           date,
  gsc_clicks          int,
  gsc_impressions     int,
  gsc_position        numeric,
  -- open: shown. dismissed: the client said no; kept so the next run doesn't
  -- suggest it again. (Tracking it is not a status: the portal hides a
  -- suggestion that's already tracked at the location on screen.)
  status              text        not null default 'open' check (status in ('open', 'dismissed')),
  dismissed_at        timestamptz,
  refreshed_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),

  unique (client_id, keyword)
);

create index if not exists idx_seo_keyword_suggestions_client_open
  on seo_keyword_suggestions(client_id) where status = 'open';

-- -----------------------------------------------------------------------------
-- RLS: tenant read-only on both (same block as 0061).
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['seo_keyword_metrics', 'seo_keyword_suggestions'] loop
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
-- Dismiss a suggestion. Only the caller's own client's open suggestions;
-- returns false when there was nothing to dismiss (not yours, gone, or already
-- dismissed) so the action can tell the user.
-- -----------------------------------------------------------------------------
create or replace function dismiss_seo_keyword_suggestion(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client uuid := current_client_id();
  v_count  int;
begin
  if v_client is null then
    return false;
  end if;
  update seo_keyword_suggestions
     set status = 'dismissed', dismissed_at = now()
   where id = p_id and client_id = v_client and status = 'open';
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke execute on function dismiss_seo_keyword_suggestion(uuid) from public, anon;
grant execute on function dismiss_seo_keyword_suggestion(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Scheduling — per client, monthly. A target is a client with an active
-- website location that has either an active keyword (to size and to seed
-- ideas from) or a Search Console property (to find striking-distance searches).
-- -----------------------------------------------------------------------------
create or replace view seo_keyword_research_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_keyword_research' and ja.entity_id is null
where exists (
  select 1 from seo_locations l
   where l.client_id = c.id and l.is_active and l.website_url is not null
     and (
       exists (select 1 from seo_keywords k where k.location_id = l.id and k.is_active)
       or nullif(btrim(l.search_console_site_url), '') is not null
     )
);

revoke all on seo_keyword_research_targets from authenticated, anon;
grant select on seo_keyword_research_targets to service_role;

create or replace function request_seo_keyword_research(p_client_id uuid)
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
    raise notice 'pg_net not installed — cannot request a keyword research run';
    return null;
  end if;

  if not start_job_attempt(p_client_id, 'seo_keyword_research', null) then
    return null;  -- not due yet, or already in flight
  end if;

  -- Vendor budget ('dataforseo') is reserved INSIDE the edge function, per call.

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_keyword_research_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_keyword_research_url / voice_tool_secret not in Vault — cannot request a keyword research run';
    perform complete_job_attempt(p_client_id, 'seo_keyword_research', false, 'missing_vault_secret',
                                  43200, 1440, null);
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 60000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('client_id', p_client_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = p_client_id and job_type = 'seo_keyword_research' and entity_id is null;

  return v_req;
end;
$$;

revoke execute on function request_seo_keyword_research(uuid) from public, authenticated;
grant execute on function request_seo_keyword_research(uuid) to service_role;

create or replace function run_due_seo_keyword_research(p_max_per_run int default 25)
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
  -- Pull forward: a newly tracked keyword has no metrics, or a Search Console
  -- backfill finished since the last good run. Never while backing off
  -- (attempt_count > 0) or within 6 hours of the last run, so a keyword
  -- DataForSEO has no data for can't make this run every tick.
  update job_attempts ja
     set next_run_at = now()
   where ja.job_type = 'seo_keyword_research'
     and ja.entity_id is null
     and ja.status = 'idle'
     and ja.attempt_count = 0
     and ja.next_run_at > now()
     and (ja.last_run_at is null or ja.last_run_at < now() - interval '6 hours')
     and (
       exists (
         select 1 from seo_keywords k
           join seo_locations l on l.id = k.location_id and l.is_active
          where k.client_id = ja.client_id and k.is_active
            -- The function writes a row for every phrase it asks about, even
            -- when DataForSEO has no data (null volume), so a missing row
            -- really means "never asked".
            and not exists (
              select 1 from seo_keyword_metrics m
               where m.client_id = k.client_id and m.keyword = k.keyword
            )
       )
       or exists (
         select 1 from seo_search_properties p
          where p.client_id = ja.client_id
            and p.backfilled_at is not null
            and p.backfilled_at > coalesce(ja.last_success_at, '-infinity'::timestamptz)
       )
     );
  get diagnostics v_pulled = row_count;

  for v_row in
    select client_id from seo_keyword_research_targets
     where is_due
     order by next_run_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_keyword_research(v_row.client_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'pulled_forward', v_pulled, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_keyword_research(int) from public, authenticated;
grant execute on function run_due_seo_keyword_research(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic keyword research NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-keyword-research-due');
  exception when others then null;
  end;
  -- Hourly at :55 (crawl :00, technical audit :20, rank submit :40, backlinks
  -- :50). Each client normally runs once every 30 days; the hourly tick is what
  -- lets a newly added keyword get its volume within the hour.
  perform cron.schedule('seo-keyword-research-due', '55 * * * *',
    $cron$select run_due_seo_keyword_research();$cron$);
end;
$$;

-- SETUP AFTER APPLYING (once per project):
--   1. DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are already set (module 7).
--   2. select vault.create_secret(
--        'https://<ref>.functions.supabase.co/seo-keyword-research',
--        'seo_keyword_research_url', '');
--   3. supabase functions deploy seo-keyword-research --no-verify-jwt
-- Then verify with:  select * from seo_keyword_research_targets;
--                    select run_due_seo_keyword_research();

-- End of 0062.
