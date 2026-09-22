-- =============================================================================
-- 0053_seo_ai_visibility.sql
-- Module 20 (plan.md): AI search visibility — weekly, per CLIENT (not per
-- location, per the scope's own cost model): for each of the client's priority
-- queries and each AI platform, how many AI answers cite the client's domain,
-- from DataForSEO's LLM Mentions API.
--
-- TWO NEW TABLES, NEITHER IN 0042.
--   seo_ai_queries   — the client's priority queries. Self-service, tenant CRUD
--                      (same shape as seo_keywords). Kept separate from
--                      seo_keywords on purpose: those are local-rank keywords
--                      that get 30-per-location geo tracking; these are topics
--                      to look for in AI answers, per client.
--   seo_ai_mentions  — one row per (query, platform, check_date). Vendor-
--                      collected, tenant read-only, service_role writes.
--
-- WHAT "CITED" MEANS HERE. LLM Mentions is a dataset of AI answers DataForSEO
-- has collected, not a way to run a custom prompt live. The check asks it for
-- answers whose QUESTION contains the priority query and whose SOURCES include
-- the client's domain; cited_count is how many it has. So a priority query
-- should be a topic phrase that real prompts contain, not a full sentence.
--
-- COST IS PER REQUEST, NOT JUST PER ROW. DataForSEO charges $0.10 per request
-- plus $0.001 per row returned. The scope's cost model priced this at rows
-- only. One request per (query, platform), weekly, is roughly 4.3 x
-- queries x platforms requests a month: 10 queries x 2 platforms is about $8.60
-- a client-month, versus the scope's $0.19 to $0.86. Still small against a
-- $1,500/location price, but the model is off and plan.md says so.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

create table if not exists seo_ai_queries (
  id          uuid        primary key default gen_random_uuid(),
  client_id   uuid        not null references clients(id) on delete cascade,
  query       text        not null check (length(btrim(query)) between 2 and 250),
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),

  unique (client_id, query)
);

create index if not exists idx_seo_ai_queries_client on seo_ai_queries(client_id);

create table if not exists seo_ai_mentions (
  id             uuid        primary key default gen_random_uuid(),
  client_id      uuid        not null references clients(id) on delete cascade,
  query_id       uuid        not null references seo_ai_queries(id) on delete cascade,

  platform       text        not null,   -- DataForSEO's value: 'google' (AI Overviews), 'chat_gpt', ...
  domain         text        not null,   -- the client domain that was looked for
  cited_count    int         not null default 0,
  top_sources    jsonb       not null default '[]'::jsonb,
  raw            jsonb       not null default '{}'::jsonb,
  check_date     date        not null default current_date,
  created_at     timestamptz not null default now(),

  unique (query_id, platform, check_date)
);

create index if not exists idx_seo_ai_mentions_client on seo_ai_mentions(client_id);
create index if not exists idx_seo_ai_mentions_client_date on seo_ai_mentions(client_id, check_date desc);

alter table seo_ai_queries  enable row level security;
alter table seo_ai_mentions enable row level security;

drop policy if exists seo_ai_queries_tenant on seo_ai_queries;
create policy seo_ai_queries_tenant on seo_ai_queries
  for all using (client_id = current_client_id())
  with check (client_id = current_client_id());

drop policy if exists seo_ai_mentions_tenant_select on seo_ai_mentions;
create policy seo_ai_mentions_tenant_select on seo_ai_mentions
  for select using (client_id = current_client_id());

-- Same defense in depth as 0042: 0001's default privileges give
-- `authenticated` full CRUD on new tables, so the vendor-written table has its
-- write grants revoked outright.
revoke insert, update, delete on seo_ai_mentions from authenticated, anon;
grant select on seo_ai_mentions to authenticated, service_role;
grant insert, update, delete on seo_ai_mentions to service_role;

-- -----------------------------------------------------------------------------
-- Scheduling — per client, weekly, on job_attempts with a NULL entity_id (the
-- job is not tied to one location). Same shape as the other SEO jobs.
-- -----------------------------------------------------------------------------
create or replace view seo_ai_visibility_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_ai_visibility' and ja.entity_id is null
where exists (select 1 from seo_ai_queries q where q.client_id = c.id and q.is_active)
  and exists (
    select 1 from seo_locations l
     where l.client_id = c.id and l.is_active and l.website_url is not null
  );

revoke all on seo_ai_visibility_targets from authenticated, anon;
grant select on seo_ai_visibility_targets to service_role;

create or replace function request_seo_ai_visibility(p_client_id uuid)
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
    raise notice 'pg_net not installed — cannot request an AI visibility pull';
    return null;
  end if;

  if not start_job_attempt(p_client_id, 'seo_ai_visibility', null) then
    return null;  -- not due yet, or already in flight
  end if;

  -- Vendor budget is reserved INSIDE the edge function, per DataForSEO call
  -- (queries x platforms of them), not per dispatch.

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_ai_visibility_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_ai_visibility_url / voice_tool_secret not in Vault — cannot request an AI visibility pull';
    perform complete_job_attempt(p_client_id, 'seo_ai_visibility', false, 'missing_vault_secret',
                                  10080, 1440, null);
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
   where client_id = p_client_id and job_type = 'seo_ai_visibility' and entity_id is null;

  return v_req;
end;
$$;

revoke execute on function request_seo_ai_visibility(uuid) from public, authenticated;
grant execute on function request_seo_ai_visibility(uuid) to service_role;

create or replace function run_due_seo_ai_visibility(p_max_per_run int default 25)
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
    select client_id from seo_ai_visibility_targets
     where is_due
     order by next_run_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_ai_visibility(v_row.client_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_ai_visibility(int) from public, authenticated;
grant execute on function run_due_seo_ai_visibility(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic AI visibility pull NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-ai-visibility-due');
  exception when others then null;
  end;
  -- Hourly tick at :30 (crawl :00, technical audit :20, rank submit :40,
  -- backlinks :50); each client only actually runs once a week.
  perform cron.schedule('seo-ai-visibility-due', '30 * * * *',
    $cron$select run_due_seo_ai_visibility();$cron$);
end;
$$;

-- SETUP AFTER APPLYING (once per project):
--   1. DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are already set (module 7).
--   2. select vault.create_secret(
--        'https://<ref>.functions.supabase.co/seo-ai-visibility',
--        'seo_ai_visibility_url', '');
--   3. Deploy with --no-verify-jwt.
-- Then verify with:  select * from seo_ai_visibility_targets;
--                    select run_due_seo_ai_visibility();

-- End of 0053.
