-- =============================================================================
-- 0055_seo_site_adapter.sql
-- Module 5 (plan.md): the website adapter layer. Publishes approved seo_actions
-- to the client's Shopify store, rolls them back, falls back to guided manual
-- steps where the API can't do it, and heartbeats the connection.
--
-- 1. seo_site_connections (tenant-readable metadata) + seo_site_credentials
--    (service-role only, a Vault secret NAME). The same split 0046 uses for
--    Google, so a tenant-readable table never carries a secret pointer.
--    Operator-provisioned, like clients.store_credentials_ref: create the Vault
--    secret, insert the connection. The SEO credential is deliberately NOT the
--    voice/order token: that one is read-only by design (the runbook says the
--    bot must never be able to write), so SEO gets its own write-scoped app.
--
-- 2. seo_actions publish state: new statuses (publishing, rollback_requested,
--    rolling_back, manual_required) and apply_mode / resource_ref /
--    publish_result / manual_instructions.
--      publish_result records the store's ACTUAL prior state, written BEFORE the
--      store is touched. seo_actions.previous_value is what the crawl saw (the
--      rendered <title>, theme suffix and all), which is not what an override
--      field held, so it can't be the rollback source. And because the store
--      write is an upsert, a retry after a crash would otherwise read the value
--      it had already written and record THAT as "previous".
--
-- 3. Claim/rollback/manual RPCs. Rollback and "I applied this by hand" are
--    tenant-initiated but the tenant can't UPDATE those rows (0042/0054), so
--    they go through narrow SECURITY DEFINER functions.
--
-- 4. Scheduling: one cron tick a few minutes apart dispatches per-location
--    'seo_publish' (work waiting) and 'seo_site_check' (daily heartbeat) jobs.
--
-- 5. seo_draft_targets is redefined (from 0054) and uq_seo_actions_live widened
--    so a draft that is publishing, waiting on a manual step, or was published
--    in the last 14 days is not drafted again.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Connections
-- -----------------------------------------------------------------------------
create table if not exists seo_site_connections (
  id              uuid        primary key default gen_random_uuid(),
  client_id       uuid        not null references clients(id) on delete cascade,
  location_id     uuid        not null unique references seo_locations(id) on delete cascade,

  platform        text        not null default 'shopify' check (platform in ('shopify')),
  shop_domain     text        not null,          -- the *.myshopify.com host
  primary_domain  text,                          -- learned by the heartbeat; the storefront's public host

  -- unchecked: never checked. healthy: reachable with the write scopes we need.
  -- degraded: reachable but a needed scope is missing (some fields go manual).
  -- revoked: the token was rejected. error: transient (network, 5xx, throttle).
  status          text        not null default 'unchecked'
                  check (status in ('unchecked', 'healthy', 'degraded', 'revoked', 'error')),
  granted_scopes  text[]      not null default '{}',
  last_checked_at timestamptz,
  last_healthy_at timestamptz,
  last_error      text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  check (shop_domain ~* '^[a-z0-9][a-z0-9-]*\.myshopify\.com$')
);

create index if not exists idx_seo_site_connections_client on seo_site_connections(client_id);

drop trigger if exists trg_seo_site_connections_updated_at on seo_site_connections;
create trigger trg_seo_site_connections_updated_at
  before update on seo_site_connections
  for each row execute function set_updated_at();

create table if not exists seo_site_credentials (
  connection_id   uuid        primary key references seo_site_connections(id) on delete cascade,
  credentials_ref text        not null,         -- a vault.secrets NAME; the secret is JSON {"access_token": "..."}
  created_at      timestamptz not null default now()
);

alter table seo_site_connections enable row level security;
alter table seo_site_credentials enable row level security;

drop policy if exists seo_site_connections_tenant_select on seo_site_connections;
create policy seo_site_connections_tenant_select on seo_site_connections
  for select using (client_id = current_client_id());

revoke insert, update, delete on seo_site_connections from authenticated, anon;
grant select on seo_site_connections to authenticated;
grant select, insert, update, delete on seo_site_connections to service_role;

revoke all on seo_site_credentials from authenticated, anon;
grant select, insert, update, delete on seo_site_credentials to service_role;

-- Resolve a location's connection and decrypt its credential. service_role only.
create or replace function get_seo_site_credentials(p_location_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_conn seo_site_connections%rowtype;
  v_ref  text;
begin
  select * into v_conn from seo_site_connections where location_id = p_location_id;
  if not found then
    return null;
  end if;
  select credentials_ref into v_ref from seo_site_credentials where connection_id = v_conn.id;

  return jsonb_build_object(
    'connection_id',  v_conn.id,
    'shop_domain',    v_conn.shop_domain,
    'primary_domain', v_conn.primary_domain,
    'status',         v_conn.status,
    'granted_scopes', to_jsonb(v_conn.granted_scopes),
    'credentials',    (select decrypted_secret from vault.decrypted_secrets where name = v_ref)
  );
end;
$$;

revoke execute on function get_seo_site_credentials(uuid) from public, authenticated;
grant execute on function get_seo_site_credentials(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 2. seo_actions publish state
-- -----------------------------------------------------------------------------
alter table seo_actions
  add column if not exists apply_mode          text check (apply_mode in ('api', 'manual')),
  add column if not exists resource_ref        jsonb,
  add column if not exists publish_result      jsonb,
  add column if not exists manual_instructions jsonb;

alter table seo_actions drop constraint if exists seo_actions_status_check;
alter table seo_actions add constraint seo_actions_status_check
  check (status in ('draft', 'pending_approval', 'approved', 'rejected',
                    'publishing', 'published', 'rollback_requested', 'rolling_back',
                    'rolled_back', 'manual_required', 'failed', 'escalated'));

drop index if exists uq_seo_actions_live;
create unique index uq_seo_actions_live
  on seo_actions (location_id, coalesce(target_url, ''), target_field)
  where target_field is not null
    and status in ('draft', 'pending_approval', 'approved', 'publishing', 'manual_required');

-- -----------------------------------------------------------------------------
-- 3. RPCs
-- -----------------------------------------------------------------------------

-- Atomically move a waiting action into its in-flight state. p_kind 'publish'
-- claims an approved action; 'rollback' claims a rollback_requested one. An
-- action stuck in its in-flight state for 15 minutes (the function died) can be
-- claimed again; the publish path is written to be safe to repeat (see header).
create or replace function claim_seo_action(p_action_id uuid, p_kind text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_n int;
begin
  if p_kind = 'publish' then
    update seo_actions set status = 'publishing'
     where id = p_action_id
       and (status = 'approved'
            or (status = 'publishing' and updated_at < now() - interval '15 minutes'));
  elsif p_kind = 'rollback' then
    update seo_actions set status = 'rolling_back'
     where id = p_action_id
       and (status = 'rollback_requested'
            or (status = 'rolling_back' and updated_at < now() - interval '15 minutes'));
  else
    raise exception 'unknown claim kind %', p_kind;
  end if;
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

revoke execute on function claim_seo_action(uuid, text) from public, authenticated;
grant execute on function claim_seo_action(uuid, text) to service_role;

-- A tenant asks for a published, API-applied change to be undone. The backend
-- job does the undo; this only records the request.
create or replace function request_seo_rollback(p_action_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row seo_actions%rowtype;
begin
  select * into v_row from seo_actions where id = p_action_id;
  -- Same answer for "not yours" and "doesn't exist" so it can't probe tenants.
  if not found or v_row.client_id is distinct from current_client_id() then
    return 'not_found';
  end if;
  if v_row.status <> 'published' or v_row.apply_mode is distinct from 'api' then
    return 'not_rollbackable';
  end if;
  update seo_actions set status = 'rollback_requested' where id = p_action_id;
  return 'ok';
end;
$$;

revoke execute on function request_seo_rollback(uuid) from public, anon;
grant execute on function request_seo_rollback(uuid) to authenticated, service_role;

-- A tenant says they applied a manual_required change by hand. This records a
-- claim, not proof: the next crawl is what confirms the finding is gone.
create or replace function confirm_seo_manual_apply(p_action_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row seo_actions%rowtype;
begin
  select * into v_row from seo_actions where id = p_action_id;
  if not found or v_row.client_id is distinct from current_client_id() then
    return 'not_found';
  end if;
  if v_row.status <> 'manual_required' then
    return 'not_pending_manual';
  end if;
  update seo_actions
     set status = 'published',
         apply_mode = 'manual',
         published_at = now(),
         publish_result = coalesce(publish_result, '{}'::jsonb)
                          || jsonb_build_object('confirmed_manually_by', auth.uid(), 'verified', false)
   where id = p_action_id;
  return 'ok';
end;
$$;

revoke execute on function confirm_seo_manual_apply(uuid) from public, anon;
grant execute on function confirm_seo_manual_apply(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Scheduling
-- -----------------------------------------------------------------------------
-- 'publish' targets start from LOCATIONS, not connections: a location with no
-- connection (a non-Shopify site, or one not set up yet) still has approved
-- drafts, and those must be turned into manual steps rather than sit forever.
create or replace view seo_site_job_targets with (security_invoker = true) as
select l.id as location_id, l.client_id, 'publish'::text as task
  from seo_locations l
 where l.is_active
   and exists (
   select 1 from seo_actions a
    where a.location_id = l.id
      and (a.status in ('approved', 'rollback_requested')
           or (a.status in ('publishing', 'rolling_back') and a.updated_at < now() - interval '15 minutes'))
 )
union all
select c.location_id, c.client_id, 'check'::text
  from seo_site_connections c
 where c.last_checked_at is null or c.last_checked_at < now() - interval '1 day';

revoke all on seo_site_job_targets from authenticated, anon;
grant select on seo_site_job_targets to service_role;

create or replace function request_seo_site_job(p_location_id uuid, p_task text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client_id uuid;
  v_type   text := case p_task when 'publish' then 'seo_publish' when 'check' then 'seo_site_check' end;
  v_base   int  := case p_task when 'publish' then 5 else 1440 end;
  v_url    text;
  v_secret text;
  v_req    bigint;
begin
  if v_type is null then
    raise exception 'unknown task %', p_task;
  end if;
  select client_id into v_client_id from seo_locations where id = p_location_id;
  if v_client_id is null then
    return null;
  end if;

  if to_regproc('net.http_post') is null then
    raise notice 'pg_net not installed — cannot request a site job';
    return null;
  end if;

  if not start_job_attempt(v_client_id, v_type, p_location_id) then
    return null;
  end if;

  -- Shopify's own throttling is handled inside the function (backoff on
  -- THROTTLED); one location's writes are far below any bucket, so no
  -- vendor_budgets reservation here.
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'seo_publish_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_publish_url / voice_tool_secret not in Vault — cannot request a site job';
    perform complete_job_attempt(v_client_id, v_type, false, 'missing_vault_secret', v_base, 1440, p_location_id);
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 120000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('location_id', p_location_id::text, 'task', p_task);

  update job_attempts set dispatched_request_id = v_req
   where client_id = v_client_id and job_type = v_type and entity_id = p_location_id;

  return v_req;
end;
$$;

revoke execute on function request_seo_site_job(uuid, text) from public, authenticated;
grant execute on function request_seo_site_job(uuid, text) to service_role;

create or replace function run_due_seo_site_jobs(p_max_per_run int default 50)
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
    select location_id, task from seo_site_job_targets limit greatest(p_max_per_run, 1)
  loop
    if request_seo_site_job(v_row.location_id, v_row.task) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;
  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_site_jobs(int) from public, authenticated;
grant execute on function run_due_seo_site_jobs(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic SEO publishing NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-site-jobs-due');
  exception when others then null;
  end;
  -- Every 5 minutes. With the job's 5-minute base interval an approval is
  -- published within roughly 10 minutes; that is deliberate, not a queue.
  perform cron.schedule('seo-site-jobs-due', '*/5 * * * *', $cron$select run_due_seo_site_jobs();$cron$);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. seo_draft_targets, redefined from 0054: also treat an action that is
--    publishing / waiting on a manual step as covering its finding, and a
--    published one for 14 days (Shopify and the crawl can lag the write).
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
         'missing_local_business_schema'
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

-- End of 0055.
