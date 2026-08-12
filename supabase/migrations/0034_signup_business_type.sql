-- =============================================================================
-- 0034_signup_business_type.sql
-- Let signup carry the onboarding archetype through to the client row.
--
-- 0032 added clients.business_type but nothing sets it at creation, so every
-- self-serve signup lands as NULL and an operator has to guess or ask later.
-- The archetype decides which onboarding steps a client sees, so it has to
-- exist BEFORE the wizard renders — which means at signup, in the one trigger
-- that creates the tenant.
--
-- Redefines handle_new_user identically to 0004 apart from reading one more
-- metadata key. Everything else — slug collision handling, the early return for
-- an existing user, the error surfacing — is unchanged and deliberately copied
-- rather than refactored, so a diff against 0004 shows exactly one idea.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_business   text := nullif(trim(new.raw_user_meta_data->>'business_name'), '');
  v_full_name  text := nullif(trim(new.raw_user_meta_data->>'full_name'), '');
  -- NEW in 0034. Validated against the same two values as the CHECK constraint
  -- rather than trusted: raw_user_meta_data is CLIENT-SUPPLIED — it comes
  -- straight from the browser's signUp call — so anything unrecognised becomes
  -- NULL instead of raising. A junk value must not be able to fail a signup;
  -- NULL simply means "never asked", which the wizard already handles.
  v_biz_type   text := lower(nullif(trim(new.raw_user_meta_data->>'business_type'), ''));
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

  if v_biz_type not in ('service', 'ecommerce') then
    v_biz_type := null;
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

  -- trg_clients_business_type (0032) fires BEFORE INSERT and derives
  -- settings.voice_agent_mode from this, so the agent is in the right mode from
  -- the moment the tenant exists. Nothing else needs to set it.
  insert into public.clients (name, slug, business_type)
  values (v_business, v_slug, v_biz_type)
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

-- =============================================================================
-- VERIFY
-- =============================================================================
--
-- After one real signup, the archetype and the agent mode must both be set and
-- must agree. A null business_type here means the form did not send it:
--
--   select name, business_type, settings ->> 'voice_agent_mode' as mode, created_at
--     from clients order by created_at desc limit 5;
--
-- End of 0034.
