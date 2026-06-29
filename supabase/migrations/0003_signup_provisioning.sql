-- =============================================================================
-- 0003_signup_provisioning.sql
-- Self-serve signup: when a new auth user is created, provision their tenant.
--
-- Why a trigger (and not the dashboard's session):
--   * The dashboard talks to Postgres as `authenticated`, which has NO insert
--     policy on `clients` or `users` (see 0001 RLS). It deliberately cannot
--     bootstrap a tenant.
--   * With email confirmation ON there is no session at sign-up time anyway, so
--     there's nothing to insert *as*.
-- A SECURITY DEFINER trigger on auth.users sidesteps both: it runs as the
-- definer (bypassing RLS) at the moment the auth row is created, reading the
-- business/full name out of the sign-up metadata.
--
-- Sign-up passes these in `options.data` (-> raw_user_meta_data):
--   { "business_name": "...", "full_name": "..." }
-- Idempotent + slug-collision safe so re-runs / retries don't double-provision.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- slugify — url-safe handle from arbitrary text.
--   "Acme Outdoors, Inc." -> "acme-outdoors-inc"
-- -----------------------------------------------------------------------------
create or replace function slugify(p_input text)
returns text
language sql
immutable
as $$
  select trim(both '-' from
    regexp_replace(
      regexp_replace(lower(coalesce(p_input, '')), '[^a-z0-9]+', '-', 'g'),
      '-{2,}', '-', 'g'
    )
  );
$$;

-- -----------------------------------------------------------------------------
-- handle_new_user — provision a tenant + admin profile for a self-serve signup.
--
-- Runs after a row lands in auth.users. Creates the clients row, then the users
-- row (id mirrors auth.users.id, role 'admin' as the first/owning user).
-- Guards:
--   * If a users row already exists for this id, do nothing (idempotent).
--   * Base the slug on business_name, falling back to the email local-part, and
--     append -2, -3, ... until it's unique.
-- -----------------------------------------------------------------------------
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business   text := nullif(trim(new.raw_user_meta_data->>'business_name'), '');
  v_full_name  text := nullif(trim(new.raw_user_meta_data->>'full_name'), '');
  v_base_slug  text;
  v_slug       text;
  v_suffix     int := 1;
  v_client_id  uuid;
begin
  -- Already provisioned (e.g. trigger re-fired): nothing to do.
  if exists (select 1 from public.users where id = new.id) then
    return new;
  end if;

  -- A workspace needs a name; fall back to the email local-part if the form
  -- somehow didn't supply one.
  if v_business is null then
    v_business := split_part(new.email, '@', 1);
  end if;

  -- Unique slug.
  v_base_slug := slugify(v_business);
  if v_base_slug = '' then
    v_base_slug := 'workspace';
  end if;
  v_slug := v_base_slug;
  while exists (select 1 from public.clients where slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix;
  end loop;

  insert into public.clients (name, slug)
  values (v_business, v_slug)
  returning id into v_client_id;

  insert into public.users (id, client_id, email, full_name, role)
  values (new.id, v_client_id, new.email, v_full_name, 'admin');

  return new;
end;
$$;

drop trigger if exists trg_auth_user_created on auth.users;
create trigger trg_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
