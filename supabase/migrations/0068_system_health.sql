-- =============================================================================
-- 0068_system_health.sql
-- A daily self-check, so a broken pipeline is reported instead of found weeks
-- later. Every failure this catches has already happened silently at least
-- once: a missing secret (ANTHROPIC_API_KEY, 2026-10-05: every draft and
-- article failing with nobody told), cron jobs that never ran (plan.md
-- "Scheduling gap", 2026-09-21), and an unfunded vendor account (DataForSEO
-- 402s, 2026-10-02).
--
-- Two halves:
--   * system_health_snapshot() — what SQL can see: extensions, Vault secrets,
--     cron jobs and their recent failures, jobs failing or stuck, and
--     locations whose drafting has paused because nobody is approving.
--   * the system-health edge function — what only the function runtime can
--     see (its env secrets, the DataForSEO balance), plus storing the run in
--     system_health_runs and sending the alert.
--
-- Operator-only: nothing here is tenant data, so nothing is granted to
-- authenticated or anon.
--
-- Test: scripts/test_system_health.sql.
-- Idempotent / safe to re-apply.
-- =============================================================================

create table if not exists system_health_runs (
  id           uuid        primary key default gen_random_uuid(),
  ran_at       timestamptz not null default now(),
  ok           boolean     not null,
  issues       jsonb       not null default '[]'::jsonb,
  alerted_via  text,       -- 'slack', 'email', 'slack+email', or null when nothing was sent
  alert_error  text
);
create index if not exists idx_system_health_runs_ran_at on system_health_runs (ran_at desc);

alter table system_health_runs enable row level security;
revoke all on system_health_runs from authenticated, anon;
grant select, insert, update on system_health_runs to service_role;

-- -----------------------------------------------------------------------------
-- The snapshot. Returns a jsonb array of issues, each
--   { "check": text, "severity": "critical" | "warning" | "info",
--     "subject": text, "detail": text }
-- "check" + "subject" is the stable key an operator can silence
-- (HEALTH_CHECK_IGNORE on the function).
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
    'seo_competitor_gaps_url', 'seo_link_opportunities_url',
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
    'seo-competitor-gaps-due', 'seo-link-opportunities-due',
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

-- -----------------------------------------------------------------------------
-- Dispatch, same shape as every other scheduled job: Vault URL + shared secret.
-- Deliberately NOT gated on job_attempts: this is one global run a day, and a
-- health check that backed itself off would go quiet exactly when it matters.
-- -----------------------------------------------------------------------------
create or replace function request_system_health_check()
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
    raise notice 'pg_net not installed — cannot request the health check';
    return null;
  end if;

  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'system_health_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'voice_tool_secret';
  if v_url is null or v_secret is null then
    raise notice 'system_health_url / voice_tool_secret not in Vault — cannot request the health check';
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 30000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      '{}'::jsonb;
  return v_req;
end;
$$;
revoke execute on function request_system_health_check() from public, authenticated, anon;
grant execute on function request_system_health_check() to service_role;

-- Daily at 15:00 UTC (08:00 Pacific in summer, 07:00 in winter).
do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — the daily health check is NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('system-health-daily');
  exception when others then null;
  end;
  perform cron.schedule('system-health-daily', '0 15 * * *', $cron$select request_system_health_check();$cron$);
end $$;
