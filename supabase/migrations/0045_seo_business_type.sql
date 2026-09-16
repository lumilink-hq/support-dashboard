-- =============================================================================
-- 0045_seo_business_type.sql
-- Module 11 (plan.md): the new 'seo' branch of clients.business_type.
--
-- Three places already encode "only 'service' or 'ecommerce' are valid" and
-- all three need the same third option, or a client picking SEO at signup
-- gets silently dropped to NULL by whichever one is missed:
--
--   1. clients_business_type_chk (0032)      — the column's own CHECK.
--   2. sync_voice_agent_mode()   (0032)       — MUST NOT fire for 'seo'. It
--      derives settings.voice_agent_mode ('scheduling'/'orders'), which only
--      means something for a client with a phone line. Its current ELSE
--      branch defaults anything that isn't 'ecommerce' to 'scheduling' —
--      widening the CHECK without touching this would silently stamp every
--      SEO-only signup (no voice product at all) with a scheduling mode.
--   3. handle_new_user()          (0004/0034) — validates raw_user_meta_data
--      the same way the CHECK does, because that metadata is client-supplied.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

alter table clients drop constraint if exists clients_business_type_chk;
alter table clients
  add constraint clients_business_type_chk
  check (business_type is null or business_type in ('service', 'ecommerce', 'seo'));

comment on column clients.business_type is
  'Onboarding archetype: service (HVAC/trades, books appointments), ecommerce '
  '(online store, answers order questions), or seo (local SEO product line, no '
  'phone product implied). Drives which onboarding steps are shown. service/'
  'ecommerce also keep settings.voice_agent_mode in sync via '
  'trg_clients_business_type — seo deliberately does not, see '
  'sync_voice_agent_mode() below. NULL means never asked.';

create or replace function sync_voice_agent_mode()
returns trigger
language plpgsql
as $$
begin
  if new.business_type is null then
    return new;
  end if;

  -- SEO clients have no voice product implied by signing up for SEO alone —
  -- do not invent a scheduling/orders mode for them. If an SEO client later
  -- also buys voice, that purchase (or an operator) sets business_type to
  -- service/ecommerce at that point and this trigger picks it up normally.
  if new.business_type = 'seo' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.business_type is not distinct from old.business_type then
      return new;
    end if;
  end if;

  new.settings := coalesce(new.settings, '{}'::jsonb)
    || jsonb_build_object(
         'voice_agent_mode',
         case new.business_type when 'ecommerce' then 'orders' else 'scheduling' end);

  return new;
end;
$$;

-- The trigger itself (name, timing, event) is unchanged from 0032 — only the
-- function body above changed — but re-declared here so this file is a
-- complete, re-runnable unit on its own.
drop trigger if exists trg_clients_business_type on clients;
create trigger trg_clients_business_type
  before insert or update of business_type on clients
  for each row execute function sync_voice_agent_mode();

-- -----------------------------------------------------------------------------
-- handle_new_user — identical to 0034 apart from the one-line allowlist
-- widening. Copied rather than refactored into a shared helper, same
-- reasoning 0034 gave for copying 0004: a diff against 0034 shows exactly
-- one idea.
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

  if v_biz_type not in ('service', 'ecommerce', 'seo') then
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

-- Verify:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'clients_business_type_chk';
--   -- expect business_type in ('service','ecommerce','seo')
--
--   insert into auth.users (id, email, raw_user_meta_data) values
--     (gen_random_uuid(), 'seo-verify@example.com',
--      '{"business_name":"Verify SEO Co","business_type":"seo"}'::jsonb);
--   select business_type, settings ->> 'voice_agent_mode' as mode
--     from clients where slug = 'verify-seo-co';
--   -- expect business_type = 'seo', mode IS NULL

-- End of 0045.
