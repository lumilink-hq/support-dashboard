-- =============================================================================
-- 0004_fix_signup_provisioning.sql
-- Fix: "Database error saving new user" on signup.
--
-- Root cause (found by inspecting the remote DB): public.users was MISSING.
-- Every other 0001 table existed (clients, conversations, messages,
-- orders_cache, review_queue) but `users` had been dropped, while the migration
-- history still listed 0001-0003 as applied. plpgsql doesn't validate table
-- references at CREATE time, so the 0003 trigger was created fine and only blew
-- up at runtime when signup tried to insert into a table that wasn't there.
--
-- Restoring users also un-breaks the dashboard: current_client_id() reads from
-- public.users, so every tenant-scoped RLS check depends on it.
--
-- This migration:
--   1. Recreates public.users exactly as 0001 defines it (table/index/RLS/grants).
--   2. Adds the provisioning grants + scoped policies the signup trigger needs.
--   3. Re-defines handle_new_user with a wider search_path + error surfacing.
-- All statements are idempotent / safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Restore public.users (mirrors 0001).
--    The user_role_t enum was dropped along with the table (only `users` used
--    it), so recreate it first — guarded + schema-qualified.
-- -----------------------------------------------------------------------------
do $$ begin
  create type public.user_role_t as enum ('admin', 'agent', 'viewer');
exception when duplicate_object then null; end $$;

create table if not exists public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  client_id   uuid        not null references public.clients(id) on delete cascade,
  email       text        not null,
  full_name   text,
  role        public.user_role_t not null default 'agent',
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists idx_users_client on public.users(client_id);

-- current_client_id() was dropped with users (it reads from it). Recreate it
-- BEFORE any policy references it. Mirrors 0001.
create or replace function current_client_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select client_id from public.users where id = auth.uid();
$$;

alter table public.users enable row level security;

drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select using (client_id = current_client_id());

drop policy if exists users_update_self on public.users;
create policy users_update_self on public.users
  for update using (id = auth.uid())
  with check (id = auth.uid());

grant select, insert, update, delete on public.users to authenticated, service_role;
grant select on public.users to anon;

-- -----------------------------------------------------------------------------
-- 1b) Re-assert the clients policies that depend on current_client_id() (these
--     were dropped with the function). clients is intact. The other tenant
--     tables (conversations/messages/orders_cache/review_queue) have drifted
--     from 0001 on this DB and are handled separately, not here, so signup +
--     login aren't blocked by their state.
-- -----------------------------------------------------------------------------
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients
  for select using (id = current_client_id());

drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients
  for update using (id = current_client_id())
  with check (id = current_client_id());

-- -----------------------------------------------------------------------------
-- 2) Provisioning access for the role GoTrue runs the signup trigger as.
--    Scoped to the trigger roles only; the dashboard's `authenticated` role
--    still has no INSERT policy, so users can't forge tenants.
-- -----------------------------------------------------------------------------
grant usage on schema public to supabase_auth_admin;
grant select, insert on public.clients to supabase_auth_admin;
grant select, insert on public.users   to supabase_auth_admin;

drop policy if exists clients_provision on public.clients;
create policy clients_provision on public.clients
  for insert to supabase_auth_admin, postgres
  with check (true);

drop policy if exists clients_provision_read on public.clients;
create policy clients_provision_read on public.clients
  for select to supabase_auth_admin, postgres
  using (true);

drop policy if exists users_provision on public.users;
create policy users_provision on public.users
  for insert to supabase_auth_admin, postgres
  with check (true);

-- -----------------------------------------------------------------------------
-- 3) Re-define the provisioning function: wider search_path (extensions for
--    pgcrypto on hosted Supabase) + surface the real error instead of an empty {}.
-- -----------------------------------------------------------------------------
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_business   text := nullif(trim(new.raw_user_meta_data->>'business_name'), '');
  v_full_name  text := nullif(trim(new.raw_user_meta_data->>'full_name'), '');
  v_base_slug  text;
  v_slug       text;
  v_suffix     int := 1;
  v_client_id  uuid;
begin
  if exists (select 1 from public.users where id = new.id) then
    return new;
  end if;

  if v_business is null then
    v_business := split_part(new.email, '@', 1);
  end if;

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
exception
  when others then
    raise log 'handle_new_user failed for auth user % : % (SQLSTATE %)',
      new.id, sqlerrm, sqlstate;
    raise exception 'provisioning failed: % (SQLSTATE %)', sqlerrm, sqlstate;
end;
$$;

grant execute on function handle_new_user() to supabase_auth_admin;
