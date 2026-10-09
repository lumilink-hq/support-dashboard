-- =============================================================================
-- 0073_seo_job_status_and_run_now.sql
-- /seo?tab=settings: when each SEO job last ran and when it runs next, and a
-- "Run now" button for the jobs a client would reasonably want sooner.
--
-- WHY. job_attempts is service-role only (0048, rule 4), so until now the only
-- way to see whether a crawl, draft or article run had happened was the SQL
-- editor, and the only way to run one early was an UPDATE of next_run_at
-- (both done for LumiLink's own workspace on 2026-10-08).
--
-- RUN NOW DOES NOT DISPATCH. It moves the job's next_run_at to now() and the
-- job's own cron tick (every 5 minutes for the crawl, hourly for the rest)
-- picks it up. Every existing guard still applies: start_job_attempt's
-- one-in-flight rule, backoff after failures, the site-wide jobs running on a
-- website's primary location only (0070), seo-content's one-article-a-week
-- idempotency key, and vendor budgets (0048).
--
-- COOLDOWNS. Each job may be run early at most once per cooldown, measured
-- from its last run (scheduled or not), so a client can't spend vendor budget
-- by clicking. The list below is the whole allowlist; anything else is refused.
--
--   job                     scope        cooldown  why that long
--   seo_crawl               site-wide    6 h       a crawl takes minutes; findings refresh
--   seo_technical_audit     site-wide    6 h       PageSpeed + URL Inspection quotas
--   seo_draft               location     1 h       only drafts what the audit found
--   seo_content             client       24 h      Anthropic + Replicate per article
--   seo_competitor_gaps     location     24 h      DataForSEO, cents per competitor
--   seo_link_opportunities  site-wide    24 h      DataForSEO, < $1 a run
--   seo_rank_submit         location     24 h      DataForSEO SERP tasks per keyword
--   seo_ai_visibility       client       24 h      DataForSEO LLM Mentions, the dearest
--   seo_keyword_research    client       24 h      DataForSEO keyword data
--   seo_search_console      client       1 h       Google API, free but rate-limited
--
-- Test: scripts/test_seo_run_now.sql. Idempotent / safe to re-apply.
-- =============================================================================

create or replace function seo_run_now_jobs()
returns table (job_type text, scope text, cooldown interval)
language sql
immutable
as $$
  values
    ('seo_crawl',              'site',     interval '6 hours'),
    ('seo_technical_audit',    'site',     interval '6 hours'),
    ('seo_draft',              'location', interval '1 hour'),
    ('seo_content',            'client',   interval '24 hours'),
    ('seo_competitor_gaps',    'location', interval '24 hours'),
    ('seo_link_opportunities', 'site',     interval '24 hours'),
    ('seo_rank_submit',        'location', interval '24 hours'),
    ('seo_ai_visibility',      'client',   interval '24 hours'),
    ('seo_keyword_research',   'client',   interval '24 hours'),
    ('seo_search_console',     'client',   interval '1 hour')
$$;

-- -----------------------------------------------------------------------------
-- seo_job_status — the caller's jobs for one location, plus its client-wide
-- jobs. Site-wide jobs are read from the website's primary location, where
-- they run. Returns nothing for a location that isn't the caller's.
-- -----------------------------------------------------------------------------
create or replace function seo_job_status(p_location_id uuid)
returns table (
  job_type        text,
  scope           text,
  status          text,
  attempt_count   int,
  last_run_at     timestamptz,
  last_success_at timestamptz,
  next_run_at     timestamptz,
  last_error      text,
  cooldown_until  timestamptz
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_client  uuid := current_client_id();
  v_primary uuid;
begin
  if v_client is null or not exists (
    select 1 from seo_locations where id = p_location_id and client_id = v_client
  ) then
    return;
  end if;

  select s.primary_location_id into v_primary
    from seo_site_locations s
   where s.location_id = p_location_id;
  v_primary := coalesce(v_primary, p_location_id);

  return query
  select
    j.job_type,
    j.scope,
    ja.status,
    ja.attempt_count,
    ja.last_run_at,
    ja.last_success_at,
    ja.next_run_at,
    left(ja.last_error, 300),
    ja.last_run_at + j.cooldown
  from seo_run_now_jobs() j
  left join job_attempts ja
    on ja.client_id = v_client
   and ja.job_type = j.job_type
   and ja.entity_id is not distinct from (
         case j.scope when 'client' then null when 'site' then v_primary else p_location_id end
       );
end;
$$;

revoke execute on function seo_job_status(uuid) from public, anon;
grant execute on function seo_job_status(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- request_seo_run_now — move one job to the front of its queue.
-- Returns: 'ok' | 'already_due' | 'running' | 'cooldown' | 'unknown_job' | 'not_found'
-- -----------------------------------------------------------------------------
create or replace function request_seo_run_now(p_location_id uuid, p_job_type text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client  uuid := current_client_id();
  v_job     record;
  v_entity  uuid;
  v_primary uuid;
  v_row     record;
begin
  if v_client is null or not exists (
    select 1 from seo_locations where id = p_location_id and client_id = v_client and is_active
  ) then
    return 'not_found';
  end if;

  select * into v_job from seo_run_now_jobs() j where j.job_type = p_job_type;
  if not found then
    return 'unknown_job';
  end if;

  if v_job.scope = 'client' then
    v_entity := null;
  elsif v_job.scope = 'site' then
    select s.primary_location_id into v_primary from seo_site_locations s where s.location_id = p_location_id;
    v_entity := coalesce(v_primary, p_location_id);
  else
    v_entity := p_location_id;
  end if;

  select * into v_row
    from job_attempts ja
   where ja.client_id = v_client and ja.job_type = p_job_type
     and ja.entity_id is not distinct from v_entity
   for update;

  -- Never run: the job's targets view already treats it as due.
  if not found or v_row.next_run_at is null or v_row.next_run_at <= now() then
    return 'already_due';
  end if;
  if v_row.status = 'running' and v_row.dispatched_at > now() - interval '30 minutes' then
    return 'running';
  end if;
  if v_row.last_run_at is not null and v_row.last_run_at > now() - v_job.cooldown then
    return 'cooldown';
  end if;

  update job_attempts
     set next_run_at = now()
   where client_id = v_client and job_type = p_job_type
     and entity_id is not distinct from v_entity;
  return 'ok';
end;
$$;

revoke execute on function request_seo_run_now(uuid, text) from public, anon;
grant execute on function request_seo_run_now(uuid, text) to authenticated, service_role;

-- End of 0073.
