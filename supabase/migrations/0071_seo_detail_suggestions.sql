-- =============================================================================
-- 0071_seo_detail_suggestions.sql — module 30 (plan.md): suggest each
-- location's article details (module 28's intake, seo_location_details) from
-- its own website, for a person to tick and confirm.
--
--   1. seo_crawl_pages keeps the readable text and JSON-LD of store pages, the
--      homepage and likely fact pages (about, locations, FAQ…; seo-crawl's
--      keepPageText). Other pages store null.
--   2. seo_detail_suggestions: one row per location, field and value, with the
--      page and the quote it came from. 'open' until a person accepts it (it
--      goes into the details they save) or dismisses it (it is never
--      suggested again). Tenants read their own; status changes only through
--      decide_seo_detail_suggestions().
--   3. Scheduling: per website primary (module 29), due once its crawl has
--      finished since the last successful run.
--
-- Nothing here writes seo_location_details: saving the details is still the
-- client vouching for them (0067's trigger records who).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Page text kept by the crawl
-- -----------------------------------------------------------------------------
alter table seo_crawl_pages
  add column if not exists page_text text check (page_text is null or length(page_text) <= 20000),
  -- jsonb renders with more spaces than JSON.stringify, hence the margin
  -- over seo-crawl's 20,000-character PAGE_TEXT_MAX.
  add column if not exists json_ld   jsonb check (json_ld is null or length(json_ld::text) <= 40000);

-- -----------------------------------------------------------------------------
-- 2. Suggestions
-- -----------------------------------------------------------------------------
create table if not exists seo_detail_suggestions (
  id           uuid        primary key default gen_random_uuid(),
  client_id    uuid        not null references clients(id) on delete cascade,
  location_id  uuid        not null references seo_locations(id) on delete cascade,
  field        text        not null check (field in (
                 'service_areas', 'landmarks', 'services', 'certifications', 'awards',
                 'year_founded', 'licensed', 'insured', 'bonded', 'family_owned',
                 'locally_owned', 'free_estimates', 'guarantee')),
  value        text        not null check (length(btrim(value)) between 1 and 120),
  value_key    text        generated always as (lower(btrim(value))) stored,
  quote        text        not null check (length(quote) between 1 and 300),
  source_url   text        not null check (length(source_url) <= 2000),
  method       text        not null check (method in ('pattern', 'structured', 'model')),
  status       text        not null default 'open' check (status in ('open', 'accepted', 'dismissed')),
  found_at     timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid        references users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create unique index if not exists uq_seo_detail_suggestions
  on seo_detail_suggestions (location_id, field, value_key);
create index if not exists idx_seo_detail_suggestions_client on seo_detail_suggestions (client_id, status);

alter table seo_detail_suggestions enable row level security;
drop policy if exists seo_detail_suggestions_tenant_select on seo_detail_suggestions;
create policy seo_detail_suggestions_tenant_select on seo_detail_suggestions
  for select using (client_id = current_client_id());
revoke all on seo_detail_suggestions from anon;
revoke insert, update, delete on seo_detail_suggestions from authenticated;
grant select on seo_detail_suggestions to authenticated, service_role;
grant insert, update, delete on seo_detail_suggestions to service_role;

-- Accept or dismiss a location's open suggestions. Only the caller's own
-- client's, only open ones, and only on a location of that client; anything
-- else is ignored. Returns how many changed.
create or replace function decide_seo_detail_suggestions(p_location_id uuid, p_ids uuid[], p_status text)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client uuid := current_client_id();
  v_n      int;
begin
  if v_client is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_status not in ('accepted', 'dismissed') then
    raise exception 'status must be accepted or dismissed' using errcode = '22023';
  end if;
  update seo_detail_suggestions s
     set status = p_status, decided_at = now(), decided_by = auth.uid()
   where s.id = any(coalesce(p_ids, '{}'))
     and s.location_id = p_location_id
     and s.client_id = v_client
     and s.status = 'open'
     and exists (select 1 from seo_locations l where l.id = p_location_id and l.client_id = v_client);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function decide_seo_detail_suggestions(uuid, uuid[], text) from public, anon;
grant execute on function decide_seo_detail_suggestions(uuid, uuid[], text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Scheduling: a website's primary, once its crawl has finished since the
--    last successful run. Checked twice an hour.
-- -----------------------------------------------------------------------------
create or replace view seo_detail_suggestion_targets with (security_invoker = true) as
select
  s.location_id,
  s.client_id,
  r.finished_at as crawl_finished_at,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now())
    and (ja.last_success_at is null or ja.last_success_at < r.finished_at) as is_due
from seo_site_locations s
join seo_crawl_runs r on r.location_id = s.location_id and r.phase = 'done' and r.finished_at is not null
left join job_attempts ja
  on ja.client_id = s.client_id and ja.job_type = 'seo_detail_suggestions' and ja.entity_id = s.location_id
where s.is_primary;

revoke all on seo_detail_suggestion_targets from authenticated, anon;
grant select on seo_detail_suggestion_targets to service_role;

create or replace function request_seo_detail_suggestions(p_location_id uuid)
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
    raise notice 'pg_net not installed — cannot request detail suggestions';
    return null;
  end if;

  if not start_job_attempt(v_client_id, 'seo_detail_suggestions', p_location_id) then
    return null;  -- not due yet, or already in flight
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_detail_suggestions_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_detail_suggestions_url / voice_tool_secret not in Vault — cannot request detail suggestions';
    perform complete_job_attempt(v_client_id, 'seo_detail_suggestions', false, 'missing_vault_secret',
                                  1440, 1440, p_location_id);
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 150000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('location_id', p_location_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = v_client_id and job_type = 'seo_detail_suggestions' and entity_id = p_location_id;

  return v_req;
end;
$$;

revoke execute on function request_seo_detail_suggestions(uuid) from public, authenticated;
grant execute on function request_seo_detail_suggestions(uuid) to service_role;

create or replace function run_due_seo_detail_suggestions(p_max_per_run int default 10)
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
    select location_id from seo_detail_suggestion_targets
     where is_due
     order by crawl_finished_at asc
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_detail_suggestions(v_row.location_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_detail_suggestions(int) from public, authenticated;
grant execute on function run_due_seo_detail_suggestions(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — detail suggestions NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-detail-suggestions-due');
  exception when others then null;
  end;
  perform cron.schedule('seo-detail-suggestions-due', '12,42 * * * *',
    $cron$select run_due_seo_detail_suggestions();$cron$);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. system_health_snapshot (0068), redefined to know the new Vault secret
--    and cron job. Unchanged otherwise.
-- -----------------------------------------------------------------------------
create or replace function system_health_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_issues  jsonb := '[]'::jsonb;
  v_name    text;
  v_row     record;
  v_has_cron boolean := to_regclass('cron.job') is not null;
  -- Every Vault secret a dispatch function reads (grep "where name =" in
  -- supabase/migrations). Add a row here when a new scheduled job adds one.
  v_vault   text[] := array[
    'voice_tool_secret',
    'google_token_refresh_url', 'product_sync_url',
    'seo_crawl_url', 'seo_technical_audit_url', 'seo_rank_tracking_url',
    'seo_backlinks_url', 'seo_ai_visibility_url', 'seo_ai_responses_url',
    'seo_draft_url', 'seo_publish_url', 'seo_content_url', 'seo_report_url',
    'seo_geocode_url', 'seo_search_console_url', 'seo_keyword_research_url',
    'seo_competitor_gaps_url', 'seo_link_opportunities_url', 'seo_detail_suggestions_url',
    'system_health_url'
  ];
  -- Every cron job a migration schedules.
  v_cron    text[] := array[
    'product-sync-due', 'google-oauth-token-refresh-due',
    'seo-crawl-due', 'seo-site-jobs-due', 'seo-technical-audit-due',
    'seo-rank-submit-due', 'seo-rank-collect-due', 'seo-backlinks-due',
    'seo-ai-visibility-due', 'seo-ai-responses-due', 'seo-draft-due',
    'seo-content-due', 'seo-report-due', 'seo-geocode-due',
    'seo-search-console-due', 'seo-keyword-research-due',
    'seo-competitor-gaps-due', 'seo-link-opportunities-due', 'seo-detail-suggestions-due',
    'system-health-daily'
  ];
begin
  -- 1. Extensions. Without these nothing scheduled runs at all.
  if not v_has_cron then
    v_issues := v_issues || jsonb_build_object('check', 'extension', 'severity', 'critical',
      'subject', 'pg_cron', 'detail', 'pg_cron is not installed: no scheduled job runs.');
  end if;
  if to_regproc('net.http_post') is null then
    v_issues := v_issues || jsonb_build_object('check', 'extension', 'severity', 'critical',
      'subject', 'pg_net', 'detail', 'pg_net is not installed: no job can call its edge function.');
  end if;

  -- 2. Vault secrets the dispatch functions read.
  foreach v_name in array v_vault loop
    if not exists (select 1 from vault.decrypted_secrets where name = v_name) then
      v_issues := v_issues || jsonb_build_object('check', 'vault_secret', 'severity', 'critical',
        'subject', v_name, 'detail', format('Vault secret %s is missing: its scheduled job settles as failed without calling anything.', v_name));
    end if;
  end loop;

  -- 3. Cron jobs: present and active, and no failed runs in the last day.
  -- Dynamic SQL because cron.* doesn't exist when pg_cron isn't installed.
  if v_has_cron then
    foreach v_name in array v_cron loop
      execute 'select active from cron.job where jobname = $1' into v_row using v_name;
      if v_row is null then
        v_issues := v_issues || jsonb_build_object('check', 'cron_job', 'severity', 'critical',
          'subject', v_name, 'detail', format('Cron job %s is not scheduled.', v_name));
      elsif not v_row.active then
        v_issues := v_issues || jsonb_build_object('check', 'cron_job', 'severity', 'warning',
          'subject', v_name, 'detail', format('Cron job %s is scheduled but inactive.', v_name));
      end if;
      v_row := null;
    end loop;

    for v_row in execute $q$
      select j.jobname, count(*) as failures, max(d.return_message) as sample
        from cron.job_run_details d
        join cron.job j on j.jobid = d.jobid
       where d.status = 'failed' and d.start_time > now() - interval '24 hours'
       group by j.jobname
    $q$ loop
      v_issues := v_issues || jsonb_build_object('check', 'cron_failures', 'severity', 'warning',
        'subject', v_row.jobname,
        'detail', format('%s failed run(s) in the last 24h; latest: %s', v_row.failures, left(coalesce(v_row.sample, ''), 200)));
    end loop;
  end if;

  -- 4. Jobs failing (5+ attempts in a row) or stuck (running > 30 min),
  -- grouped per job type so one bad vendor isn't 40 lines.
  for v_row in
    select job_type, health, count(*) as n, max(last_error) as sample
      from job_attempts_health
     where health in ('failing', 'stuck')
     group by job_type, health
  loop
    v_issues := v_issues || jsonb_build_object('check', 'job_' || v_row.health, 'severity', 'warning',
      'subject', v_row.job_type,
      'detail', format('%s %s job(s) %s; latest error: %s', v_row.n, v_row.job_type, v_row.health,
                       left(coalesce(v_row.sample, 'none recorded'), 200)));
  end loop;

  -- 5. Drafting paused: seo-draft stops writing page fixes for a location once
  -- 10 are waiting on a person (seo-draft/lib.ts MAX_WAITING_DRAFTS). Nothing
  -- else tells anyone the client has stopped approving. Keep 10 in step with
  -- that constant.
  for v_row in
    select c.name as client_name, l.name as location_name, count(*) as waiting
      from seo_actions a
      join seo_locations l on l.id = a.location_id
      join clients c on c.id = a.client_id
     where a.action_type = 'onpage_fix'
       and a.status in ('draft', 'pending_approval', 'manual_required')
     group by c.name, l.name
    having count(*) >= 10
  loop
    v_issues := v_issues || jsonb_build_object('check', 'drafting_paused', 'severity', 'warning',
      'subject', v_row.client_name || ' / ' || v_row.location_name,
      'detail', format('%s page fixes waiting on a person, so drafting is paused for this location.', v_row.waiting));
  end loop;

  return v_issues;
end;
$$;
revoke execute on function system_health_snapshot() from public, authenticated, anon;
grant execute on function system_health_snapshot() to service_role;

-- SETUP AFTER APPLYING:
--   1. select vault.create_secret(
--        'https://<ref>.supabase.co/functions/v1/seo-detail-suggestions',
--        'seo_detail_suggestions_url', '');
--   2. supabase functions deploy seo-detail-suggestions --no-verify-jwt
--   3. supabase functions deploy seo-crawl --no-verify-jwt   (keeps page text; needs this migration first)
-- Then verify with:  select * from seo_detail_suggestion_targets;
--                    select run_due_seo_detail_suggestions();

-- End of 0071.
