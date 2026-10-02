-- =============================================================================
-- 0064_seo_site_audit.sql
-- Module 24 (plan.md, Phase 6c): a deeper site audit. seo-crawl now crawls
-- from the sitemap (plus links) up to a per-client page limit instead of the
-- homepage + 19 links, and adds site-wide rules: broken internal and outbound
-- links, internal links that redirect, duplicate titles and meta
-- descriptions, canonical problems, noindex pages in the sitemap, sitemap URLs
-- that don't answer 200, orphan and weakly linked pages.
--
-- RESUMABLE. A 100-page crawl with a polite gap between requests doesn't fit
-- one edge-function call, so a crawl is now a RUN that advances in steps:
--   pages → links → done
-- Each call does ~40 seconds of work, saves its place in seo_crawl_runs, and
-- (if unfinished) settles the job a couple of minutes out instead of a week.
-- The cron tick for seo-crawl-due becomes every 5 minutes to pick that up; a
-- location with no run in progress is still only due weekly (next_run_at).
-- Findings are written once, when the run finishes, with the same
-- delete-then-insert as before, so a half-done crawl never replaces a complete
-- set of findings with a partial one.
--
-- TABLES (vendor-written, tenant read-only)
--   seo_crawl_runs        — one row per location: the current or last run,
--                           its phase, queue, counts and limit.
--   seo_crawl_pages       — what each crawled page said (status, redirects,
--                           title, description, canonicals, noindex, links,
--                           its own page findings), per run.
--   seo_crawl_link_checks — status of linked URLs that weren't crawled as
--                           pages (internal beyond the limit, and outbound).
-- Rows from older runs are deleted when a run finishes.
--
-- seo_client_settings.crawl_page_limit (0061's staff-set, tenant read-only
-- table): pages per location per crawl, default 100, 20 to 500.
--
-- seo_draft_targets (0055) redefined: duplicate_title and
-- duplicate_meta_description are now draftable (module 8 writes copy specific
-- to the page). Keep in step with seo-draft/lib.ts DRAFTABLE.
--
-- Isolation and scheduling: scripts/test_seo_site_audit.sql.
-- Idempotent / safe to re-apply.
-- =============================================================================

alter table seo_client_settings
  add column if not exists crawl_page_limit int not null default 100;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'seo_client_settings_crawl_page_limit_check') then
    alter table seo_client_settings
      add constraint seo_client_settings_crawl_page_limit_check check (crawl_page_limit between 20 and 500);
  end if;
end;
$$;

comment on column seo_client_settings.crawl_page_limit is
  'Pages seo-crawl audits per location per run (module 24). Set by LumiLink staff. '
  'A client with no settings row gets the default, 100.';

create table if not exists seo_crawl_runs (
  location_id        uuid        primary key references seo_locations(id) on delete cascade,
  client_id          uuid        not null references clients(id) on delete cascade,
  run_id             uuid        not null default gen_random_uuid(),
  phase              text        not null default 'pages' check (phase in ('pages', 'links', 'done')),
  site_host          text        not null,
  root_url           text        not null,
  page_limit         int         not null check (page_limit between 1 and 500),
  queue              text[]      not null default '{}',  -- pages still to fetch
  link_queue         text[]      not null default '{}',  -- linked URLs still to check
  sitemap_found      boolean     not null default false,
  sitemap_url_count  int         not null default 0,
  sitemap_urls       text[]      not null default '{}',  -- normalised, capped (site.ts MAX_SITEMAP_URLS)
  pages_crawled      int         not null default 0,
  truncated          boolean     not null default false,
  rendered_root      boolean     not null default false, -- root audited via render-service
  started_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  finished_at        timestamptz
);

create table if not exists seo_crawl_pages (
  location_id       uuid        not null references seo_locations(id) on delete cascade,
  client_id         uuid        not null references clients(id) on delete cascade,
  run_id            uuid        not null,
  url               text        not null,
  status_code       int         not null,           -- 0 = no answer
  final_url         text,
  redirect_hops     int         not null default 0,
  in_sitemap        boolean     not null default false,
  is_root           boolean     not null default false,
  title             text,
  meta_description  text,
  canonicals        text[]      not null default '{}',
  noindex           boolean     not null default false,
  word_count        int,
  internal_links    text[]      not null default '{}',
  outbound_links    text[]      not null default '{}',
  page_findings     jsonb       not null default '[]'::jsonb,
  crawled_at        timestamptz not null default now(),

  primary key (location_id, run_id, url)
);

create table if not exists seo_crawl_link_checks (
  location_id    uuid        not null references seo_locations(id) on delete cascade,
  client_id      uuid        not null references clients(id) on delete cascade,
  run_id         uuid        not null,
  url            text        not null,
  status_code    int         not null,              -- 0 = no answer
  final_url      text,
  redirect_hops  int         not null default 0,
  error          text,                              -- 'dns', 'timeout', 'network'
  checked_at     timestamptz not null default now(),

  primary key (location_id, run_id, url)
);

drop trigger if exists trg_seo_crawl_runs_updated_at on seo_crawl_runs;
create trigger trg_seo_crawl_runs_updated_at
  before update on seo_crawl_runs
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS: tenant read-only (same block as 0061 / 0062 / 0063).
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['seo_crawl_runs', 'seo_crawl_pages', 'seo_crawl_link_checks'] loop
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
-- request_seo_crawl (0049), redefined: the only change is the HTTP timeout,
-- 60 s → 150 s, since one step of a run works for up to ~45 seconds plus the
-- fetch it's in the middle of. Same claim, same secrets, same backoff.
-- -----------------------------------------------------------------------------
create or replace function request_seo_crawl(p_location_id uuid)
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
    raise notice 'pg_net not installed — cannot request a crawl';
    return null;
  end if;

  if not start_job_attempt(v_client_id, 'seo_crawl', p_location_id) then
    return null;  -- not due yet, or already in flight
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_crawl_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_crawl_url / voice_tool_secret not in Vault — cannot request a crawl';
    perform complete_job_attempt(v_client_id, 'seo_crawl', false, 'missing_vault_secret',
                                  10080, 1440, p_location_id);
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
   where client_id = v_client_id and job_type = 'seo_crawl' and entity_id = p_location_id;

  return v_req;
end;
$$;

revoke execute on function request_seo_crawl(uuid) from public, authenticated;
grant execute on function request_seo_crawl(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- seo_draft_targets (0055), redefined: two more draftable finding types.
-- -----------------------------------------------------------------------------
create or replace view seo_draft_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from seo_locations l
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_draft' and ja.entity_id = l.id
where l.is_active
  and exists (
    select 1
      from seo_findings f
     where f.location_id = l.id
       and f.status = 'open'
       and f.module = 'crawl'
       and f.finding_type in (
         'missing_title', 'title_length',
         'missing_meta_description', 'meta_description_length',
         'missing_h1',
         'missing_local_business_schema',
         'duplicate_title', 'duplicate_meta_description'
       )
       and not exists (
         select 1
           from seo_actions a
          where a.location_id = f.location_id
            and coalesce(a.target_url, '') = coalesce(f.target_url, '')
            and a.finding_type = f.finding_type
            and (
              a.status in ('draft', 'pending_approval', 'approved', 'publishing', 'manual_required')
              or (a.status = 'published' and a.updated_at > now() - interval '14 days')
              or (a.status = 'rejected'  and a.updated_at > now() - interval '30 days')
            )
       )
  );

revoke all on seo_draft_targets from authenticated, anon;
grant select on seo_draft_targets to service_role;

-- -----------------------------------------------------------------------------
-- Cron: every 5 minutes, so an unfinished run continues promptly. A location
-- with no run in progress is only due weekly, so this doesn't crawl more.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — seo-crawl-due NOT rescheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-crawl-due');
  exception when others then null;
  end;
  perform cron.schedule('seo-crawl-due', '*/5 * * * *', $cron$select run_due_seo_crawls();$cron$);
end;
$$;

-- SETUP AFTER APPLYING:
--   1. supabase functions deploy seo-crawl --no-verify-jwt
--   2. supabase functions deploy seo-draft --no-verify-jwt   (two new draftable types)
--   3. Optionally, per client: insert into seo_client_settings (client_id, crawl_page_limit)
--      values ('<uuid>', 250) on conflict (client_id) do update set crawl_page_limit = excluded.crawl_page_limit;
-- Then verify with:  select * from seo_crawl_runs;   (after the next crawl tick)

-- End of 0064.
