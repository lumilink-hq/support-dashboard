-- =============================================================================
-- 0222_loyalty_self_serve_install.sql - LL Loyalty Phase 2 module P1
-- Plan: docs/loyalty/PLAN.md section 7.
--
-- loyalty_apps - one row per LL Loyalty Shopify app (client id + its Vault
--   secret), custom or public. self_serve = an install on a store nobody set
--   up creates the store a workspace and a program with generic defaults.
--   Tsunami and the dev store keep self_serve false, so their install path is
--   unchanged (provision-loyalty-shopify-app.sql).
--
-- loyalty_install - the one call loyalty-oauth makes after a token exchange.
--   Registered store: stores the token (as before). Unregistered store on a
--   self-serve app: creates client + program + config, registers the store,
--   stores the token and starts the backfill, all in one transaction.
--
-- loyalty_mark_uninstalled - app/uninstalled. Drops the token reference
--   (Shopify already revoked it), and when no other app still serves the
--   store, pauses the program (is_active false, paused_by_uninstall true).
--   Reinstalling resumes only a program the uninstall paused, so a program
--   staff switched off stays off.
--
-- Defaults are generic, not the Tsunami settings: 1 point per 1 unit of shop
-- currency, 200 points = 5 off (2.5 percent back), Bronze 0 / Silver 500 /
-- Gold 1000 spend, every customer a member, Klaviyo off. The merchant edits
-- them in the program editor (0221).
--
-- Comment rule (plan section 1): no semicolons or apostrophes in top-level
-- comments, or db push splits the file wrongly.
--
-- Test: scripts/test_loyalty_self_serve_install.sql.
-- =============================================================================

create table if not exists loyalty_apps (
  app_client_id   text        primary key check (length(app_client_id) between 8 and 100),
  label           text        not null,
  distribution    text        not null check (distribution in ('custom', 'public')),
  self_serve      boolean     not null default false,
  app_secret_ref  text        not null,
  scopes          text        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table loyalty_apps enable row level security;

drop trigger if exists trg_loyalty_apps_updated_at on loyalty_apps;
create trigger trg_loyalty_apps_updated_at
  before update on loyalty_apps
  for each row execute function set_updated_at();

-- Existing apps (the Tsunami custom app) are registered, never self-serve.
insert into loyalty_apps (app_client_id, label, distribution, self_serve, app_secret_ref, scopes)
select distinct on (a.app_client_id) a.app_client_id, 'LL Loyalty', 'custom', false, a.app_secret_ref, a.scopes
  from loyalty_shopify_apps a
 order by a.app_client_id, a.connected_at desc nulls last
on conflict (app_client_id) do nothing;

alter table loyalty_programs add column if not exists created_via text not null default 'staff'
  check (created_via in ('staff', 'self_serve'));
alter table loyalty_programs add column if not exists paused_by_uninstall boolean not null default false;
alter table loyalty_shopify_apps add column if not exists uninstalled_at timestamptz;

-- get_loyalty_self_serve_apps - credentials of every self-serve app, for an
-- install on a store that has no registered app yet.
create or replace function get_loyalty_self_serve_apps()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'app_client_id', a.app_client_id,
           'scopes',        a.scopes,
           'credentials',   (select decrypted_secret from vault.decrypted_secrets where name = a.app_secret_ref)
         ) order by a.created_at), '[]'::jsonb)
    from loyalty_apps a
   where a.self_serve;
$$;

-- loyalty_create_default_program - a workspace and a program with generic
-- defaults for a store. Raises if the store already has a program.
create or replace function loyalty_create_default_program(p_shop text, p_shop_name text, p_timezone text)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_shop   text := lower(p_shop);
  v_name   text := nullif(btrim(coalesce(p_shop_name, '')), '');
  v_tz     text := coalesce(nullif(p_timezone, ''), 'UTC');
  v_base   text;
  v_slug   text;
  v_client uuid;
  v_prog   uuid;
  i        int := 1;
begin
  if v_shop !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' then
    raise exception 'not a myshopify domain: %', p_shop;
  end if;
  if exists (select 1 from loyalty_programs where shop_domain = v_shop) then
    raise exception 'shop % already has a program', v_shop;
  end if;
  if not exists (select 1 from pg_timezone_names where name = v_tz) then
    v_tz := 'UTC';
  end if;
  v_name := left(coalesce(v_name, split_part(v_shop, '.', 1)), 80);

  v_base := 'loyalty-' || split_part(v_shop, '.', 1);
  v_slug := v_base;
  while exists (select 1 from clients where slug = v_slug) loop
    i := i + 1;
    v_slug := v_base || '-' || i;
  end loop;
  insert into clients (name, slug) values (v_name, v_slug) returning id into v_client;

  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, tier_spend_since,
                                demote_after_inactive, demotion_warning_days, points_expire_after,
                                discount_code_prefix, timezone, enroll_guests, created_via)
  values (v_client, v_shop, left(v_name || ' Rewards', 80), 1, null,
          '12 months', 7, '1 year', 'LL-', v_tz, true, 'self_serve')
  returning id into v_prog;

  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier, perks) values
    (v_prog, 'bronze', 'Bronze', 0, 0,      1.0,  '[]'),
    (v_prog, 'silver', 'Silver', 1, 50000,  1.25, '["1.25x points"]'),
    (v_prog, 'gold',   'Gold',   2, 100000, 1.5,  '["1.5x points"]');

  insert into loyalty_earn_rules (program_id, key, kind, points, order_count, claimable) values
    (v_prog, 'signup',      'action',    50,  null, false),
    (v_prog, 'birthday',    'action',    100, null, false),
    (v_prog, 'anniversary', 'action',    100, null, false),
    (v_prog, 'referral',    'referral',  200, null, false),
    (v_prog, 'order_1',     'milestone', 50,  1,    false);

  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents, min_order_cents, max_units) values
    (v_prog, 'five_off',        '$5 off',                   'amount_off_order', 200,  500,  0, null),
    (v_prog, 'referral_friend', '$10 off your first order', 'amount_off_order', null, 1000, 0, 1);

  perform loyalty_seed_default_badges(v_prog);
  return v_prog;
end;
$$;

-- loyalty_install - after a successful token exchange. Returns the program,
-- whether this call created it, and how it was created (staff or self_serve).
create or replace function loyalty_install(
  p_shop text, p_app_client_id text, p_access_token text, p_scopes text[],
  p_shop_name text default null, p_timezone text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_shop    text := lower(p_shop);
  v_app     loyalty_apps%rowtype;
  v_prog    uuid;
  v_created boolean := false;
begin
  if not exists (select 1 from loyalty_shopify_apps where shop_domain = v_shop and app_client_id = p_app_client_id) then
    select * into v_app from loyalty_apps where app_client_id = p_app_client_id and self_serve;
    if not found then
      raise exception 'shop % / app % is not registered and the app is not self-serve', v_shop, p_app_client_id;
    end if;
    select id into v_prog from loyalty_programs where shop_domain = v_shop;
    if v_prog is null then
      v_prog := loyalty_create_default_program(v_shop, p_shop_name, p_timezone);
      v_created := true;
    end if;
    insert into loyalty_shopify_apps (shop_domain, app_client_id, program_id, app_secret_ref, scopes)
    values (v_shop, v_app.app_client_id, v_prog, v_app.app_secret_ref, v_app.scopes);
  end if;

  v_prog := store_loyalty_shopify_token(v_shop, p_app_client_id, p_access_token, p_scopes);

  update loyalty_shopify_apps set uninstalled_at = null
   where shop_domain = v_shop and app_client_id = p_app_client_id;
  update loyalty_programs set is_active = true, paused_by_uninstall = false
   where id = v_prog and paused_by_uninstall;

  if v_created then
    perform start_loyalty_backfill(v_prog);
  end if;
  return jsonb_build_object('program_id', v_prog, 'created', v_created,
                            'created_via', (select created_via from loyalty_programs where id = v_prog));
end;
$$;

-- loyalty_mark_uninstalled - app/uninstalled for one app on one store.
-- Returns true when the program was paused.
create or replace function loyalty_mark_uninstalled(p_shop text, p_app_client_id text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_shop text := lower(p_shop);
  v_prog uuid;
  v_ref  text;
begin
  select program_id, token_ref into v_prog, v_ref from loyalty_shopify_apps
   where shop_domain = v_shop and app_client_id = p_app_client_id for update;
  if not found then
    return false;
  end if;
  if v_ref is not null then
    delete from vault.secrets where name = v_ref;
  end if;
  update loyalty_shopify_apps set token_ref = null, uninstalled_at = now()
   where shop_domain = v_shop and app_client_id = p_app_client_id;

  if exists (select 1 from loyalty_shopify_apps where program_id = v_prog and token_ref is not null) then
    return false;
  end if;
  update loyalty_programs set is_active = false, paused_by_uninstall = true
   where id = v_prog and is_active;
  return found;
end;
$$;

revoke all on table loyalty_apps from public, anon, authenticated;
revoke execute on function get_loyalty_self_serve_apps() from public, anon, authenticated;
revoke execute on function loyalty_create_default_program(text, text, text) from public, anon, authenticated;
revoke execute on function loyalty_install(text, text, text, text[], text, text) from public, anon, authenticated;
revoke execute on function loyalty_mark_uninstalled(text, text) from public, anon, authenticated;

grant execute on function get_loyalty_self_serve_apps() to service_role;
grant execute on function loyalty_create_default_program(text, text, text) to service_role;
grant execute on function loyalty_install(text, text, text, text[], text, text) to service_role;
grant execute on function loyalty_mark_uninstalled(text, text) to service_role;
