-- =============================================================================
-- 0080_client_invites.sql — let a second person join an EXISTING client.
--
-- Until now handle_new_user always created a fresh client, so a staff member
-- signing up got an empty workspace of their own (see
-- scripts/add-user-to-client.sql for the manual repair this replaces).
--
-- client_invites is a pre-approved list: email -> client + role. When an auth
-- user is created with an email that has a pending invite, the trigger puts
-- them on that client instead of creating one, and marks the invite accepted.
-- Works however the auth user is made: /signup, Dashboard -> Add user, or
-- inviteUserByEmail.
--
-- Rows are added by us (SQL editor / service role), never by the dashboard:
-- RLS is on with no policies, so `authenticated` and `anon` can't read or
-- write it. Matching is on email only, which is safe because sign-in needs a
-- confirmed email (signup requires confirmation), so someone registering a
-- staff address they don't own lands on the client but can never log in.
--
-- Add people with scripts/add-staff.sql.
-- =============================================================================

create table if not exists public.client_invites (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid        not null references public.clients(id) on delete cascade,
  email       text        not null check (email = lower(trim(email)) and email like '%@%'),
  full_name   text,
  role        public.user_role_t not null default 'agent',
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  user_id     uuid references auth.users(id) on delete set null
);

-- One pending invite per email: an address can't be promised to two clients.
create unique index if not exists client_invites_pending_email
  on public.client_invites (email) where accepted_at is null;
create index if not exists idx_client_invites_client on public.client_invites (client_id);

alter table public.client_invites enable row level security;
revoke all on public.client_invites from anon, authenticated;
grant select, insert, update, delete on public.client_invites to service_role;
-- The signup trigger runs as supabase_auth_admin (see 0004).
grant select, update on public.client_invites to supabase_auth_admin;

drop policy if exists client_invites_provision on public.client_invites;
create policy client_invites_provision on public.client_invites
  for all to supabase_auth_admin, postgres
  using (true) with check (true);

-- Same as 0059 apart from the invite branch at the top.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_business   text := nullif(trim(new.raw_user_meta_data->>'business_name'), '');
  v_full_name  text := nullif(trim(new.raw_user_meta_data->>'full_name'), '');
  v_biz_type   text := lower(nullif(trim(new.raw_user_meta_data->>'business_type'), ''));
  v_product    text := lower(nullif(trim(new.raw_user_meta_data->>'product'), ''));
  v_base_slug  text;
  v_slug       text;
  v_suffix     int := 1;
  v_client_id  uuid;
  v_invite     public.client_invites%rowtype;
begin
  if exists (select 1 from public.users where id = new.id) then
    return new;
  end if;

  -- Invited staff join the existing client. business_name and the product
  -- from the signup form are ignored: the client is already set up.
  select * into v_invite
    from public.client_invites
   where email = lower(trim(new.email)) and accepted_at is null
   for update;

  if found then
    insert into public.users (id, client_id, email, full_name, role)
    values (new.id, v_invite.client_id, new.email,
            coalesce(v_full_name, v_invite.full_name), v_invite.role);

    update public.client_invites
       set accepted_at = now(), user_id = new.id
     where id = v_invite.id;

    return new;
  end if;

  if v_business is null then
    v_business := split_part(new.email, '@', 1);
  end if;

  -- Metadata is client-supplied: anything unrecognised is dropped, never
  -- trusted. The previous app build sent the product as business_type 'seo';
  -- honour that rather than dropping the product.
  if v_biz_type = 'seo' then
    v_product := coalesce(v_product, 'seo');
    v_biz_type := null;
  end if;
  if v_biz_type not in ('service', 'ecommerce') then
    v_biz_type := null;
  end if;
  if v_product is null or v_product not in ('voice', 'seo') then
    v_product := 'voice';
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

  insert into public.clients (name, slug, business_type, products)
  values (v_business, v_slug, v_biz_type, array[v_product])
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

-- Verify: scripts/test_client_invites.sql (runs in a rolled-back transaction).

-- End of 0080.
