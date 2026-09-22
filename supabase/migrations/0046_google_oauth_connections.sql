-- =============================================================================
-- 0046_google_oauth_connections.sql
-- Module 2 (plan.md): per-tenant Google OAuth, refresh tokens in Vault,
-- scheduled refresh, revoked-access handling.
--
-- TWO TABLES, DELIBERATELY SPLIT — the lesson from 0041/0043 applies here
-- directly. RLS is ROW-level; it cannot hide one column of a row a tenant is
-- otherwise allowed to read, and a column-level REVOKE is a no-op against
-- 0001's table-wide grant (0043's whole point). A Google refresh token is
-- equivalent to standing account access — there is no safe way to put it in
-- a tenant-readable table. So:
--
--   google_oauth_connections — status, granted scopes, connected email,
--     timestamps. Tenant-readable (RLS), so the dashboard can show "connected
--     as x@gmail.com" — carries no secret material at all.
--   google_oauth_tokens — refresh_token_secret_id (a Vault pointer, never the
--     token) + a short-lived cached access token. RLS enabled with NO POLICY
--     and an explicit revoke of the table grant (same belt-and-braces as
--     0012's voice_usage_events) — `authenticated` can never see this table,
--     full stop. Only SECURITY DEFINER functions (which run as the table
--     owner and bypass RLS, same as current_client_id() reading `users`) and
--     service_role touch it.
--
-- WRITE PATHS, mirroring the split:
--   * store_google_oauth_tokens / disconnect_google_oauth — callable by
--     `authenticated`, self-scoped via current_client_id() (no client_id
--     parameter — a tenant can only ever write its own row, structurally,
--     the same pattern has_feature/set_plan_tier_caps already use). Driven by
--     the Next.js OAuth callback route running under the signed-in user's own
--     session — NOT a service-role client. lib/supabase/service.ts's own
--     comment confines service-role usage to lib/services/billing.ts; this
--     migration's SECURITY DEFINER functions are how an authenticated caller
--     reaches Vault without a second service-role call site.
--   * get_google_refresh_token / update_google_access_token /
--     mark_google_oauth_error — service_role only, called by the scheduled
--     edge function (google-token-refresh), which has no signed-in user.
--
-- SCHEDULING mirrors 0023_scheduled_product_sync.sql's pg_cron -> pg_net ->
-- edge-function shape exactly, same rationale: per-client isolation (one
-- client's revoked grant doesn't block another's refresh) and edge functions
-- have a wall-clock limit a single looping function would eventually hit.
--
-- REQUIRES: pg_cron, pg_net, supabase_vault (all confirmed enabled on this
-- project before writing this migration). If pg_cron/pg_net are missing this
-- file still applies cleanly and just schedules nothing, same guard 0023 uses.
--
-- SETUP AFTER APPLYING (one Vault secret, once per project — voice_tool_secret
-- already exists from 0023 and is reused here rather than inventing a second
-- shared admin secret):
--   select vault.create_secret(
--     'https://<ref>.functions.supabase.co/google-token-refresh',
--     'google_token_refresh_url', '');
-- Then verify with:  select * from google_oauth_refresh_targets;
--                    select run_due_google_token_refreshes();
--
-- Idempotent / safe to re-apply.
-- =============================================================================

create table if not exists google_oauth_connections (
  client_id             uuid        primary key references clients(id) on delete cascade,
  google_account_email  text,
  -- Incremental auth (module 2): Search Console scope now, Business Profile
  -- added later once the API grant lands. store_google_oauth_tokens UNIONS
  -- into this array rather than overwriting, so granting the second scope
  -- later doesn't silently drop the first.
  granted_scopes        text[]      not null default '{}',
  status                text        not null default 'connected'
                        check (status in ('connected', 'revoked', 'error')),
  last_refreshed_at     timestamptz,
  last_error            text,
  connected_at          timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

drop trigger if exists trg_google_oauth_connections_updated_at on google_oauth_connections;
create trigger trg_google_oauth_connections_updated_at
  before update on google_oauth_connections
  for each row execute function set_updated_at();

alter table google_oauth_connections enable row level security;

drop policy if exists google_oauth_connections_tenant_select on google_oauth_connections;
create policy google_oauth_connections_tenant_select on google_oauth_connections
  for select using (client_id = current_client_id());

-- Defense in depth (0043's lesson): 0001's default privileges would otherwise
-- hand `authenticated` full CRUD here. Writes only ever happen through the
-- SECURITY DEFINER functions below, which bypass RLS/grants as the table
-- owner — a direct tenant write is never a legitimate path.
revoke insert, update, delete on google_oauth_connections from authenticated, anon;
grant select on google_oauth_connections to authenticated, service_role;
grant insert, update, delete on google_oauth_connections to service_role;

-- -----------------------------------------------------------------------------
-- google_oauth_tokens — the secret-adjacent table. See migration header.
-- -----------------------------------------------------------------------------
create table if not exists google_oauth_tokens (
  client_id                uuid        primary key references clients(id) on delete cascade,
  refresh_token_secret_id  uuid,                       -- vault.secrets.id — never the token itself
  -- Short-lived (~1hr) and low blast-radius if it ever leaked, unlike the
  -- refresh token — plaintext here is an accepted tradeoff, same reasoning
  -- most OAuth integrations use for access-token caching.
  access_token_cache       text,
  access_token_expires_at  timestamptz,
  updated_at               timestamptz not null default now()
);

drop trigger if exists trg_google_oauth_tokens_updated_at on google_oauth_tokens;
create trigger trg_google_oauth_tokens_updated_at
  before update on google_oauth_tokens
  for each row execute function set_updated_at();

alter table google_oauth_tokens enable row level security;
-- NO POLICY. With RLS on and no policy, `authenticated` sees nothing —
-- same pattern 0008 uses for provisioning_tasks/billing_events. Revoked
-- explicitly anyway, same defense-in-depth reasoning as the table above.
revoke all on google_oauth_tokens from authenticated, anon;
grant select, insert, update, delete on google_oauth_tokens to service_role;

comment on table google_oauth_tokens is
  'Never exposed to authenticated — not even via RLS-scoped SELECT. '
  'refresh_token_secret_id is a Vault pointer; the token itself lives only in '
  'vault.secrets, decrypted only by get_google_refresh_token (service_role).';

-- =============================================================================
-- Tenant-initiated writes (authenticated, self-scoped via current_client_id()).
-- =============================================================================

create or replace function store_google_oauth_tokens(
  p_refresh_token text,
  p_access_token  text,
  p_expires_at    timestamptz,
  p_scopes        text[],
  p_account_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client_id uuid := current_client_id();
  v_secret_id uuid;
begin
  if v_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;
  -- A renewal/re-consent may not carry a fresh refresh token at all — Google
  -- only issues one on the FIRST consent (or with prompt=consent). Update the
  -- access token and scopes without touching the stored refresh token when
  -- none is supplied, rather than clobbering a working connection.
  if p_refresh_token is not null and length(trim(p_refresh_token)) > 0 then
    select refresh_token_secret_id into v_secret_id
      from google_oauth_tokens where client_id = v_client_id;

    if v_secret_id is not null then
      perform vault.update_secret(v_secret_id, p_refresh_token);
    else
      v_secret_id := vault.create_secret(
        p_refresh_token,
        'google_refresh_token:' || v_client_id::text,
        'Google OAuth refresh token for client ' || v_client_id::text);
    end if;
  else
    select refresh_token_secret_id into v_secret_id
      from google_oauth_tokens where client_id = v_client_id;
    if v_secret_id is null then
      return jsonb_build_object('ok', false, 'error', 'no_refresh_token_on_first_connect');
    end if;
  end if;

  insert into google_oauth_tokens
    (client_id, refresh_token_secret_id, access_token_cache, access_token_expires_at)
  values (v_client_id, v_secret_id, p_access_token, p_expires_at)
  on conflict (client_id) do update
    set refresh_token_secret_id = excluded.refresh_token_secret_id,
        access_token_cache      = excluded.access_token_cache,
        access_token_expires_at = excluded.access_token_expires_at,
        updated_at              = now();

  insert into google_oauth_connections
    (client_id, google_account_email, granted_scopes, status, last_refreshed_at)
  values (v_client_id, p_account_email, coalesce(p_scopes, '{}'), 'connected', now())
  on conflict (client_id) do update
    set google_account_email = coalesce(excluded.google_account_email,
                                         google_oauth_connections.google_account_email),
        granted_scopes = (
          select coalesce(array_agg(distinct s), '{}')
          from unnest(google_oauth_connections.granted_scopes || excluded.granted_scopes) s
        ),
        status = 'connected',
        last_refreshed_at = now(),
        last_error = null,
        updated_at = now();

  return jsonb_build_object('ok', true, 'client_id', v_client_id);
end;
$$;

revoke execute on function store_google_oauth_tokens(text, text, timestamptz, text[], text)
  from public;
grant execute on function store_google_oauth_tokens(text, text, timestamptz, text[], text)
  to authenticated, service_role;

-- disconnect_google_oauth only cleans up local state. Revoking the grant with
-- Google itself (POST https://oauth2.googleapis.com/revoke) is an HTTP call,
-- done by the Next.js server action BEFORE calling this — plpgsql has no
-- direct way to make that call synchronously and report the result back to
-- the same request.
create or replace function disconnect_google_oauth()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client_id uuid := current_client_id();
  v_secret_id uuid;
begin
  if v_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;

  select refresh_token_secret_id into v_secret_id
    from google_oauth_tokens where client_id = v_client_id;

  delete from google_oauth_tokens where client_id = v_client_id;
  delete from google_oauth_connections where client_id = v_client_id;

  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function disconnect_google_oauth() from public;
grant execute on function disconnect_google_oauth() to authenticated, service_role;

-- =============================================================================
-- Backend-only reads/writes (service_role — the scheduled refresh job).
-- =============================================================================

create or replace function get_google_refresh_token(p_client_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select decrypted_secret from vault.decrypted_secrets
   where id = (
     select refresh_token_secret_id from google_oauth_tokens where client_id = p_client_id
   );
$$;

revoke execute on function get_google_refresh_token(uuid) from public, authenticated;
grant execute on function get_google_refresh_token(uuid) to service_role;

create or replace function update_google_access_token(
  p_client_id   uuid,
  p_access_token text,
  p_expires_at  timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update google_oauth_tokens
     set access_token_cache = p_access_token,
         access_token_expires_at = p_expires_at,
         updated_at = now()
   where client_id = p_client_id;

  update google_oauth_connections
     set status = 'connected', last_refreshed_at = now(), last_error = null
   where client_id = p_client_id;
end;
$$;

revoke execute on function update_google_access_token(uuid, text, timestamptz) from public, authenticated;
grant execute on function update_google_access_token(uuid, text, timestamptz) to service_role;

-- p_revoked=true is Google's own signal (an invalid_grant response from the
-- token endpoint means the client revoked access from their Google Account,
-- or the refresh token otherwise died) — module 2's "handling for revoked
-- access". Surfaced on google_oauth_connections.status so the dashboard can
-- prompt a reconnect instead of the integration silently going stale.
create or replace function mark_google_oauth_error(
  p_client_id uuid,
  p_error     text,
  p_revoked   boolean default false
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update google_oauth_connections
     set status = case when p_revoked then 'revoked' else 'error' end,
         last_error = p_error,
         updated_at = now()
   where client_id = p_client_id;
end;
$$;

revoke execute on function mark_google_oauth_error(uuid, text, boolean) from public, authenticated;
grant execute on function mark_google_oauth_error(uuid, text, boolean) to service_role;

-- =============================================================================
-- Scheduling — pg_cron -> pg_net -> edge function, mirrors 0023 exactly.
-- =============================================================================

create or replace view google_oauth_refresh_targets with (security_invoker = true) as
select
  c.client_id,
  c.google_account_email,
  c.status,
  t.access_token_expires_at,
  -- Due when never cached, expiring within 10 minutes, or already erroring
  -- (retry every tick on a transient failure rather than waiting out a full
  -- token lifetime).
  (
    t.access_token_expires_at is null
    or t.access_token_expires_at < now() + interval '10 minutes'
    or c.status = 'error'
  ) as is_due
from google_oauth_connections c
join google_oauth_tokens t on t.client_id = c.client_id
where c.status <> 'revoked';

-- Joins google_oauth_tokens, which authenticated cannot read at all (see
-- above) — this view is structurally service_role-only, security_invoker
-- kept anyway for the same blanket-rule reason 0012's cross-tenant views keep
-- it: explicit is better than "happens to be denied by a side effect".
revoke all on google_oauth_refresh_targets from authenticated, anon;
grant select on google_oauth_refresh_targets to service_role;

create or replace function request_google_token_refresh(p_client_id uuid)
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
    raise notice 'pg_net not installed — cannot request a refresh';
    return null;
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'google_token_refresh_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'google_token_refresh_url / voice_tool_secret not in Vault — cannot request a refresh';
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 20000)'
    into v_req
    using
      v_url,
      jsonb_build_object(
        'Content-Type', 'application/json',
        'x-voice-tool-secret', v_secret
      ),
      jsonb_build_object('client_id', p_client_id::text);

  return v_req;
end;
$$;

revoke execute on function request_google_token_refresh(uuid) from public, authenticated;
grant execute on function request_google_token_refresh(uuid) to service_role;

create or replace function run_due_google_token_refreshes(p_max_per_run int default 50)
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
    select client_id
      from google_oauth_refresh_targets
     where is_due
     order by access_token_expires_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_google_token_refresh(v_row.client_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_google_token_refreshes(int) from public, authenticated;
grant execute on function run_due_google_token_refreshes(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic Google token refresh NOT scheduled. '
                 'Enable the extension, then re-run this migration.';
    return;
  end if;

  begin
    perform cron.unschedule('google-oauth-token-refresh-due');
  exception when others then
    null;
  end;

  perform cron.schedule(
    'google-oauth-token-refresh-due',
    '*/15 * * * *',
    $cron$select run_due_google_token_refreshes();$cron$
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Health view — same "is the scheduler doing its job" question 0023 answers
-- for product sync, here for the OAuth refresh cycle.
-- -----------------------------------------------------------------------------
create or replace view google_oauth_health with (security_invoker = true) as
select
  c.client_id,
  c.google_account_email,
  c.status,
  c.granted_scopes,
  c.last_refreshed_at,
  t.access_token_expires_at,
  case
    when c.status = 'revoked' then 'revoked'
    when c.status = 'error' and c.last_refreshed_at < now() - interval '1 hour' then 'failing'
    when t.access_token_expires_at < now() then 'expired'
    else 'ok'
  end as health
from google_oauth_connections c
left join google_oauth_tokens t on t.client_id = c.client_id;

revoke all on google_oauth_health from authenticated, anon;
grant select on google_oauth_health to service_role;

comment on view google_oauth_health is
  'Per-client Google OAuth health for operators. health: revoked | failing | '
  'expired | ok. "failing" means refresh has been erroring for over an hour.';

-- End of 0046.
