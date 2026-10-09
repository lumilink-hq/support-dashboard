-- =============================================================================
-- 0077_seo_shopify_oauth.sql
-- "Connect Shopify": the store owner approves LumiLink's app once and the
-- store's long-lived offline token lands in Vault, wired to every one of the
-- client's locations. Replaces copying credentials by hand (0055's runbook).
--
-- WHY. Since 2026-01-01 Shopify no longer lets a store create legacy custom
-- apps (the shpat_ token in the admin). A Dev Dashboard app's client
-- credentials grant only works on stores in the app's own organization, so an
-- app LumiLink creates gets "shop_not_permitted" on a client's live store
-- (PACKS, 2026-10-09). The supported route for an agency is the authorization
-- code grant on a CUSTOM-DISTRIBUTION app, and custom distribution allows ONE
-- store per app: so one small app per client store, registered here.
--
-- seo_shopify_apps — one row per client store: which LumiLink app serves it.
--   app_secret_ref names a Vault secret holding JSON {"client_id", "client_secret"}
--   (the same shape seo-publish already accepts, so a store's existing
--   credential secret can be reused). Service-role only: no tenant reads it.
--
-- The OAuth itself runs in the shopify-oauth edge function (service role, no
-- signed-in user needed: the store is identified by its shop domain, which only
-- an operator can register here, and only someone who can install apps on that
-- store can approve).
--
-- store_seo_shopify_token (service_role) writes the token to Vault and points
-- every active location of the client at it, platform 'shopify' only (a
-- client's GitHub connection, 0075, is never touched). The heartbeat then
-- re-checks them.
--
-- seo_shopify_connect_info (authenticated, self-scoped) tells the portal
-- whether a store is registered for the caller, so it can show the button.
--
-- Test: scripts/test_seo_shopify_oauth.sql. Idempotent / safe to re-apply.
-- =============================================================================

create table if not exists seo_shopify_apps (
  shop_domain     text        primary key check (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  client_id       uuid        not null references clients(id) on delete cascade,
  app_secret_ref  text        not null,   -- vault.secrets NAME; JSON {"client_id","client_secret"}
  scopes          text        not null default 'write_products,write_content',
  token_ref       text,                   -- vault.secrets NAME of the offline token, once connected
  connected_at    timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_seo_shopify_apps_client on seo_shopify_apps(client_id);

drop trigger if exists trg_seo_shopify_apps_updated_at on seo_shopify_apps;
create trigger trg_seo_shopify_apps_updated_at
  before update on seo_shopify_apps
  for each row execute function set_updated_at();

alter table seo_shopify_apps enable row level security;
-- NO POLICY: operator config plus a secret pointer.
revoke all on seo_shopify_apps from authenticated, anon;
grant select, insert, update, delete on seo_shopify_apps to service_role;

-- -----------------------------------------------------------------------------
-- get_seo_shopify_app — the edge function's lookup: the app's credentials for
-- a shop. service_role only.
-- -----------------------------------------------------------------------------
create or replace function get_seo_shopify_app(p_shop text)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'shop_domain', a.shop_domain,
    'client_id',   a.client_id,
    'scopes',      a.scopes,
    'credentials', (select decrypted_secret from vault.decrypted_secrets where name = a.app_secret_ref)
  )
  from seo_shopify_apps a
  where a.shop_domain = lower(p_shop);
$$;

revoke execute on function get_seo_shopify_app(text) from public, anon, authenticated;
grant execute on function get_seo_shopify_app(text) to service_role;

-- -----------------------------------------------------------------------------
-- store_seo_shopify_token — after a successful token exchange.
-- Returns the number of locations wired to the token.
-- -----------------------------------------------------------------------------
create or replace function store_seo_shopify_token(p_shop text, p_access_token text, p_scopes text[])
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_app    seo_shopify_apps%rowtype;
  v_name   text;
  v_secret uuid;
  v_loc    record;
  v_conn   uuid;
  v_count  int := 0;
begin
  select * into v_app from seo_shopify_apps where shop_domain = lower(p_shop) for update;
  if not found then
    raise exception 'shop % is not registered in seo_shopify_apps', p_shop;
  end if;
  if p_access_token is null or length(p_access_token) < 10 then
    raise exception 'no access token';
  end if;

  v_name := 'shopify-token:' || v_app.shop_domain;
  select id into v_secret from vault.secrets where name = v_name;
  if v_secret is null then
    perform vault.create_secret(
      jsonb_build_object('access_token', p_access_token)::text, v_name,
      'Shopify offline token for ' || v_app.shop_domain);
  else
    perform vault.update_secret(v_secret, jsonb_build_object('access_token', p_access_token)::text);
  end if;

  update seo_shopify_apps
     set token_ref = v_name, connected_at = now(), last_error = null
   where shop_domain = v_app.shop_domain;

  for v_loc in
    select id from seo_locations where client_id = v_app.client_id and is_active
  loop
    select id into v_conn from seo_site_connections where location_id = v_loc.id;
    if v_conn is null then
      insert into seo_site_connections (client_id, location_id, platform, shop_domain)
      values (v_app.client_id, v_loc.id, 'shopify', v_app.shop_domain)
      returning id into v_conn;
    elsif (select platform from seo_site_connections where id = v_conn) <> 'shopify' then
      v_conn := null;  -- a GitHub site (0075): not ours to change
      continue;
    end if;

    update seo_site_connections
       set shop_domain = v_app.shop_domain,
           status = 'unchecked',
           granted_scopes = coalesce(p_scopes, '{}'),
           last_checked_at = null,
           last_error = null
     where id = v_conn;

    insert into seo_site_credentials (connection_id, credentials_ref)
    values (v_conn, v_name)
    on conflict (connection_id) do update set credentials_ref = excluded.credentials_ref;

    -- The heartbeat re-checks at the next tick instead of tomorrow.
    update job_attempts
       set next_run_at = now()
     where client_id = v_app.client_id and job_type = 'seo_site_check' and entity_id = v_loc.id
       and status <> 'running';

    v_conn := null;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function store_seo_shopify_token(text, text, text[]) from public, anon, authenticated;
grant execute on function store_seo_shopify_token(text, text, text[]) to service_role;

create or replace function mark_seo_shopify_error(p_shop text, p_error text)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update seo_shopify_apps set last_error = left(p_error, 500) where shop_domain = lower(p_shop);
$$;

revoke execute on function mark_seo_shopify_error(text, text) from public, anon, authenticated;
grant execute on function mark_seo_shopify_error(text, text) to service_role;

-- -----------------------------------------------------------------------------
-- seo_shopify_connect_info — for the portal: the caller's registered store, if
-- any, and whether it is connected. No secret material.
-- -----------------------------------------------------------------------------
create or replace function seo_shopify_connect_info()
returns table (shop_domain text, connected_at timestamptz, last_error text)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select a.shop_domain, a.connected_at, a.last_error
    from seo_shopify_apps a
   where a.client_id = current_client_id()
   order by a.created_at
$$;

revoke execute on function seo_shopify_connect_info() from public, anon;
grant execute on function seo_shopify_connect_info() to authenticated, service_role;

-- SETUP, once per client store (scripts/provision-seo-shopify-app.sql):
--   1. A custom-distribution app for the store in LumiLink's Dev Dashboard.
--   2. Its client id + secret in Vault as JSON; a seo_shopify_apps row.
--   3. The store owner clicks Connect Shopify (/seo > Settings) or the app's
--      install link.
-- Once per project: supabase functions deploy shopify-oauth --no-verify-jwt

-- End of 0077.
