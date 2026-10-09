-- =============================================================================
-- 0076_seo_gbp_sync.sql
-- Module 3 (plan.md, Phase 4): Google Business Profile read sync, plus the
-- finish of module 11 (mapping the profiles Google returns to seo_locations).
--
-- WHAT RUNS. One job per client ('seo_gbp_sync', job_attempts entity_id NULL,
-- like Search Console: one Google connection per client). Each run:
--   1. lists every Business Profile account the connected Google login can
--      see, and every location in them (Business Information API);
--   2. links unlinked profiles to seo_locations when the match is unambiguous
--      (lib.ts matchLocations); anything else waits for a person to pick in
--      /seo?tab=settings (link_seo_gbp_location below);
--   3. for each linked profile: daily performance metrics into
--      seo_metrics_daily (0042's table, unchanged), six months back on the
--      first run, the trailing days re-pulled after that;
--   4. reviews (Google My Business API v4) into seo_gbp_reviews;
--   5. a profile completeness audit into seo_findings (module 'gbp_profile').
--
-- TABLES (all vendor-written: tenant read-only, service_role writes)
--   seo_gbp_sync       — per client: did the account listing work, and why not.
--   seo_gbp_locations  — every profile Google returned, a snapshot of its
--                        fields, and which seo_location it is linked to.
--   seo_gbp_reviews    — one row per review, with the owner's reply if any.
--
-- LINKING is the one tenant write. link_seo_gbp_location is self-scoped
-- (current_client_id(), no client parameter), keeps the link one-to-one, and
-- mirrors the link onto seo_locations.gbp_* and google_place_id (0042 reserved
-- those columns for exactly this; unlinking clears them, since the place id's
-- unique index would otherwise refuse the profile's next location). Changing a link resets the profile's metric/review sync so the
-- new location gets its own backfill.
--
-- Rule 4: every view is security_invoker with an explicit revoke. Isolation,
-- linking and scheduling are tested by scripts/test_seo_gbp_sync.sql.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

create table if not exists seo_gbp_sync (
  client_id        uuid        primary key references clients(id) on delete cascade,
  -- pending: never run. ok: accounts and locations listed. not_connected: no
  -- Google connection, or it lacks business.manage. no_access: Google refused
  -- (API not enabled for the project, or the login manages no profiles).
  -- error: anything else (last_error says what).
  status           text        not null default 'pending'
                   check (status in ('pending', 'ok', 'not_connected', 'no_access', 'error')),
  accounts_count   int         not null default 0,
  locations_count  int         not null default 0,
  last_synced_at   timestamptz,
  last_error       text,
  updated_at       timestamptz not null default now()
);

create table if not exists seo_gbp_locations (
  client_id               uuid        not null references clients(id) on delete cascade,
  location_name           text        not null check (location_name ~ '^locations/[^/]+$'),
  account_name            text        not null check (account_name ~ '^accounts/[^/]+$'),

  -- Snapshot of the profile, refreshed every run.
  title                   text,
  store_code              text,
  address_text            text,       -- one line, for display and matching
  postal_code             text,
  phone                   text,
  website_uri             text,
  primary_category        text,       -- display name, e.g. "Cannabis store"
  additional_categories   text[]      not null default '{}',
  description             text,
  has_regular_hours       boolean     not null default false,
  open_status             text,       -- OPEN | CLOSED_PERMANENTLY | CLOSED_TEMPORARILY
  place_id                text,
  maps_uri                text,
  new_review_uri          text,
  has_voice_of_merchant   boolean,    -- false: Google doesn't treat the login as in control (unverified, suspended, ...)
  has_pending_edits       boolean,
  profile                 jsonb       not null default '{}'::jsonb, -- the raw Location, for the write path (module 4)

  -- Link to an seo_location (one-to-one; see uq_seo_gbp_locations_linked).
  linked_location_id      uuid        references seo_locations(id) on delete set null,
  link_source             text        check (link_source in ('auto', 'manual')),
  linked_at               timestamptz,

  -- Performance sync state.
  metrics_through         date,
  metrics_backfilled_at   timestamptz,
  metrics_error           text,

  -- Review sync state. reviews_status 'unavailable' = the v4 API isn't enabled
  -- for the project yet (or the profile isn't verified); not an error to retry
  -- hourly. reviews_page_token: where an unfinished first pull resumes.
  reviews_status          text        not null default 'pending'
                          check (reviews_status in ('pending', 'ok', 'unavailable', 'error')),
  average_rating          numeric(3,2),
  total_review_count      int,
  reviews_synced_at       timestamptz,
  reviews_backfilled_at   timestamptz,
  reviews_page_token      text,
  reviews_error           text,

  last_seen_at            timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  primary key (client_id, location_name)
);

create unique index if not exists uq_seo_gbp_locations_linked
  on seo_gbp_locations(linked_location_id) where linked_location_id is not null;

create table if not exists seo_gbp_reviews (
  client_id              uuid        not null references clients(id) on delete cascade,
  location_name          text        not null,
  review_id              text        not null,
  location_id            uuid        references seo_locations(id) on delete set null,
  reviewer_name          text,
  reviewer_is_anonymous  boolean     not null default false,
  star_rating            smallint    check (star_rating between 1 and 5),
  comment                text,
  created_at_google      timestamptz,
  updated_at_google      timestamptz,
  reply_comment          text,
  reply_updated_at       timestamptz,
  synced_at              timestamptz not null default now(),

  primary key (client_id, location_name, review_id)
);

create index if not exists idx_seo_gbp_reviews_location on seo_gbp_reviews(location_id, created_at_google desc);

drop trigger if exists trg_seo_gbp_sync_updated_at on seo_gbp_sync;
create trigger trg_seo_gbp_sync_updated_at
  before update on seo_gbp_sync
  for each row execute function set_updated_at();

drop trigger if exists trg_seo_gbp_locations_updated_at on seo_gbp_locations;
create trigger trg_seo_gbp_locations_updated_at
  before update on seo_gbp_locations
  for each row execute function set_updated_at();

do $$
declare
  t text;
begin
  foreach t in array array['seo_gbp_sync', 'seo_gbp_locations', 'seo_gbp_reviews'] loop
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
-- link_seo_gbp_location — the tenant's "this profile is that location".
-- p_location_id null unlinks. Returns 'ok' | 'not_found' | 'location_not_found'.
-- -----------------------------------------------------------------------------
create or replace function link_seo_gbp_location(p_location_name text, p_location_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client uuid := current_client_id();
  v_row    seo_gbp_locations%rowtype;
begin
  if v_client is null then
    return 'not_found';
  end if;

  select * into v_row from seo_gbp_locations
   where client_id = v_client and location_name = p_location_name
   for update;
  if not found then
    return 'not_found';
  end if;

  if p_location_id is not null and not exists (
    select 1 from seo_locations where id = p_location_id and client_id = v_client
  ) then
    return 'location_not_found';
  end if;

  if v_row.linked_location_id is not distinct from p_location_id then
    return 'ok';
  end if;

  -- Whatever profile held the target location lets go of it (one-to-one).
  if p_location_id is not null then
    update seo_gbp_locations
       set linked_location_id = null, link_source = null, linked_at = null
     where client_id = v_client and linked_location_id = p_location_id;
    update seo_locations
       set gbp_location_name = null, gbp_account_id = null, google_place_id = null, gbp_connected_at = null
     where client_id = v_client and id = p_location_id;
  end if;

  -- The location this profile used to feed forgets it.
  if v_row.linked_location_id is not null then
    update seo_locations
       set gbp_location_name = null, gbp_account_id = null, google_place_id = null, gbp_connected_at = null
     where client_id = v_client and id = v_row.linked_location_id;
  end if;

  update seo_gbp_locations
     set linked_location_id = p_location_id,
         link_source = case when p_location_id is null then null else 'manual' end,
         linked_at = case when p_location_id is null then null else now() end,
         -- A new location gets its own six-month backfill and review pull.
         metrics_through = null, metrics_backfilled_at = null, metrics_error = null,
         reviews_status = 'pending', reviews_backfilled_at = null, reviews_page_token = null,
         reviews_synced_at = null, reviews_error = null
   where client_id = v_client and location_name = p_location_name;

  update seo_gbp_reviews
     set location_id = p_location_id
   where client_id = v_client and location_name = p_location_name;

  if p_location_id is not null then
    update seo_locations
       set gbp_location_name = p_location_name,
           gbp_account_id = v_row.account_name,
           google_place_id = coalesce(v_row.place_id, google_place_id),
           gbp_connected_at = now()
     where client_id = v_client and id = p_location_id;

    -- Pull the new link's data soon rather than tomorrow.
    update job_attempts
       set next_run_at = least(coalesce(next_run_at, now()), now() + interval '15 minutes')
     where client_id = v_client and job_type = 'seo_gbp_sync' and entity_id is null
       and status <> 'running';
  end if;

  return 'ok';
end;
$$;

revoke execute on function link_seo_gbp_location(text, uuid) from public, anon;
grant execute on function link_seo_gbp_location(text, uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Scheduling — per client, daily. Due when the client has an active location
-- (whether Google is connected with business.manage is the function's call: it
-- records 'not_connected' so the portal can say so).
-- -----------------------------------------------------------------------------
create or replace view seo_gbp_sync_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_gbp_sync' and ja.entity_id is null
where exists (
  select 1 from seo_locations l where l.client_id = c.id and l.is_active
);

revoke all on seo_gbp_sync_targets from authenticated, anon;
grant select on seo_gbp_sync_targets to service_role;

create or replace function request_seo_gbp_sync(p_client_id uuid)
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
    raise notice 'pg_net not installed — cannot request a GBP sync';
    return null;
  end if;

  if not start_job_attempt(p_client_id, 'seo_gbp_sync', null) then
    return null;  -- not due yet, or already in flight
  end if;

  -- Vendor budget ('google', 0048) is reserved INSIDE the edge function, per call.

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_gbp_sync_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_gbp_sync_url / voice_tool_secret not in Vault — cannot request a GBP sync';
    perform complete_job_attempt(p_client_id, 'seo_gbp_sync', false, 'missing_vault_secret',
                                  1440, 1440, null);
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 150000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('client_id', p_client_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = p_client_id and job_type = 'seo_gbp_sync' and entity_id is null;

  return v_req;
end;
$$;

revoke execute on function request_seo_gbp_sync(uuid) from public, authenticated;
grant execute on function request_seo_gbp_sync(uuid) to service_role;

create or replace function run_due_seo_gbp_sync(p_max_per_run int default 25)
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
    select client_id from seo_gbp_sync_targets
     where is_due
     order by next_run_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_gbp_sync(v_row.client_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_gbp_sync(int) from public, authenticated;
grant execute on function run_due_seo_gbp_sync(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic GBP sync NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-gbp-sync-due');
  exception when others then null;
  end;
  -- Every 15 minutes (at :10, :25, :40, :55). A client normally runs once a
  -- day; the short tick matters while a first review pull is still paging,
  -- when the function reschedules itself 15 minutes out.
  perform cron.schedule('seo-gbp-sync-due', '10,25,40,55 * * * *',
    $cron$select run_due_seo_gbp_sync();$cron$);
end;
$$;

-- -----------------------------------------------------------------------------
-- "Run now" (0073): add the GBP sync to the allowlist. Same list as 0073 plus
-- one row; 0073's functions read it, so nothing else changes.
-- -----------------------------------------------------------------------------
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
    ('seo_search_console',     'client',   interval '1 hour'),
    ('seo_gbp_sync',           'client',   interval '1 hour')
$$;

-- SETUP AFTER APPLYING (once per project):
--   1. In the Google Cloud project that owns the OAuth client: My Business
--      Account Management, Business Information, Business Profile Performance
--      and Google My Business (v4, reviews) APIs enabled; business.manage on
--      the consent screen's Data Access list.
--   2. select vault.create_secret(
--        'https://<ref>.functions.supabase.co/seo-gbp-sync',
--        'seo_gbp_sync_url', '');
--   3. supabase functions deploy seo-gbp-sync --no-verify-jwt
--   4. Per client: Settings > Connect Business Profile (adds business.manage).
-- Then verify with:  select * from seo_gbp_sync_targets;
--                    select run_due_seo_gbp_sync();
--                    select * from seo_gbp_sync;  select * from seo_gbp_locations;

-- End of 0076.
