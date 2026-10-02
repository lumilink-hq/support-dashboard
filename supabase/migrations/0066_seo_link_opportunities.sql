-- =============================================================================
-- 0066_seo_link_opportunities.sql
-- Module 26 (plan.md, Phase 6c): link opportunities, monthly per location,
-- from DataForSEO's Backlinks API ($0.024 a request + $0.000036 a row,
-- checked 2026-10-02):
--
--   LINK GAP  — sites that link to two or more of the location's competitors
--               but not to its site. backlinks/domain_intersection/live with
--               the competitors two at a time as `targets` and the site as
--               `exclude_targets` (at most 10 pairs for 5 competitors).
--   BROKEN    — live links from other sites that point at a page on the
--               client's site that now answers 4xx/5xx (backlinks/live,
--               is_broken = true). A redirect from that page recovers every
--               one of them, so each broken page becomes a FINDING (module
--               'backlinks', new here) rather than a list entry.
--   LOST      — links that were removed (backlinks/live, status 'lost'), one
--               per referring site: an outreach list.
--
-- Nothing here places or buys a link (module 19 stays parked): it lists sites
-- for a person to contact.
--
-- TABLES (vendor-written, tenant read-only)
--   seo_link_opportunities — gap and lost rows, replaced per location on each
--                            run.
--   seo_link_dismissals    — referring sites the client said no to (per
--                            client, every location, both kinds). Written only
--                            by dismiss_seo_link_opportunity().
-- VIEW seo_link_opportunities_open — minus dismissed sites; security_invoker.
--
-- Isolation and scheduling: scripts/test_seo_link_opportunities.sql.
-- Idempotent / safe to re-apply.
-- =============================================================================

-- seo_findings gains a 'backlinks' module for broken pages that other sites
-- link to. (0042's free-text finding_type needs no change.)
alter table seo_findings drop constraint if exists seo_findings_module_check;
alter table seo_findings add constraint seo_findings_module_check
  check (module in ('crawl', 'technical', 'gbp_profile', 'citations', 'backlinks'));

create table if not exists seo_link_opportunities (
  id                uuid        primary key default gen_random_uuid(),
  client_id         uuid        not null references clients(id) on delete cascade,
  location_id       uuid        not null references seo_locations(id) on delete cascade,
  kind              text        not null check (kind in ('gap', 'lost')),
  referring_domain  text        not null,
  url_from          text        not null default '',   -- lost: the page the link was on
  url_to            text,                              -- lost: the page it pointed at
  competitors       text[]      not null default '{}', -- gap: competitors it links to
  domain_rank       int,                               -- DataForSEO rank, 0 to 1,000
  backlinks         int,                               -- gap: links to the competitors
  anchor            text,
  dofollow          boolean,
  lost_date         date,
  fetched_at        timestamptz not null default now(),

  unique (location_id, kind, referring_domain, url_from)
);

create index if not exists idx_seo_link_opportunities_location on seo_link_opportunities(location_id, kind);
create index if not exists idx_seo_link_opportunities_client on seo_link_opportunities(client_id);

create table if not exists seo_link_dismissals (
  client_id         uuid        not null references clients(id) on delete cascade,
  referring_domain  text        not null,
  dismissed_at      timestamptz not null default now(),

  primary key (client_id, referring_domain)
);

do $$
declare
  t text;
begin
  foreach t in array array['seo_link_opportunities', 'seo_link_dismissals'] loop
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

create or replace view seo_link_opportunities_open with (security_invoker = true) as
select o.*
  from seo_link_opportunities o
 where not exists (
         select 1 from seo_link_dismissals d
          where d.client_id = o.client_id and d.referring_domain = o.referring_domain
       );

revoke all on seo_link_opportunities_open from authenticated, anon;
grant select on seo_link_opportunities_open to authenticated, service_role;

create or replace function dismiss_seo_link_opportunity(p_domain text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client uuid := current_client_id();
  v_domain text := lower(btrim(coalesce(p_domain, '')));
begin
  if v_client is null or v_domain !~ '^[a-z0-9.-]+\.[a-z]{2,}$' then
    return false;
  end if;
  insert into seo_link_dismissals (client_id, referring_domain)
  values (v_client, v_domain)
  on conflict (client_id, referring_domain) do nothing;
  return true;
end;
$$;

revoke execute on function dismiss_seo_link_opportunity(text) from public, anon;
grant execute on function dismiss_seo_link_opportunity(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Scheduling — per location, monthly, hourly tick at :48.
-- -----------------------------------------------------------------------------
create or replace view seo_link_opportunity_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from seo_locations l
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_link_opportunities' and ja.entity_id = l.id
where l.is_active
  and l.website_url is not null;

revoke all on seo_link_opportunity_targets from authenticated, anon;
grant select on seo_link_opportunity_targets to service_role;

create or replace function request_seo_link_opportunities(p_location_id uuid)
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
    raise notice 'pg_net not installed — cannot request link opportunities';
    return null;
  end if;

  if not start_job_attempt(v_client_id, 'seo_link_opportunities', p_location_id) then
    return null;  -- not due yet, or already in flight
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_link_opportunities_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_link_opportunities_url / voice_tool_secret not in Vault — cannot request link opportunities';
    perform complete_job_attempt(v_client_id, 'seo_link_opportunities', false, 'missing_vault_secret',
                                  43200, 1440, p_location_id);
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 120000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('location_id', p_location_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = v_client_id and job_type = 'seo_link_opportunities' and entity_id = p_location_id;

  return v_req;
end;
$$;

revoke execute on function request_seo_link_opportunities(uuid) from public, authenticated;
grant execute on function request_seo_link_opportunities(uuid) to service_role;

create or replace function run_due_seo_link_opportunities(p_max_per_run int default 25)
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
    select location_id from seo_link_opportunity_targets
     where is_due
     order by next_run_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_link_opportunities(v_row.location_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_link_opportunities(int) from public, authenticated;
grant execute on function run_due_seo_link_opportunities(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic link opportunities NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-link-opportunities-due');
  exception when others then null;
  end;
  perform cron.schedule('seo-link-opportunities-due', '48 * * * *',
    $cron$select run_due_seo_link_opportunities();$cron$);
end;
$$;

-- SETUP AFTER APPLYING (once per project):
--   1. DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are already set (module 7).
--   2. select vault.create_secret(
--        'https://<ref>.supabase.co/functions/v1/seo-link-opportunities',
--        'seo_link_opportunities_url', '');
--   3. supabase functions deploy seo-link-opportunities --no-verify-jwt
-- Then verify with:  select * from seo_link_opportunity_targets;
--                    select run_due_seo_link_opportunities();

-- End of 0066.
