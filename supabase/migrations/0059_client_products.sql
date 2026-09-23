-- =============================================================================
-- 0059_client_products.sql
-- Split "what the client is" from "what the client uses".
--
-- clients.business_type used to answer two questions at once. 'service' and
-- 'ecommerce' are INDUSTRIES (they pick the phone agent's mode and its
-- onboarding steps), but 'seo' (0045) is a PRODUCT. So a plumber buying Local
-- SEO had to stop being a plumber, and a phone client could never add SEO:
-- the SEO onboarding steps and /billing's SEO checkout only existed for
-- business_type = 'seo'.
--
-- After this migration:
--   business_type  the industry only: 'service' | 'ecommerce' | NULL
--   products       the products this workspace has set up: {'voice','seo'}
--
-- products is INTENT, not payment. It decides which onboarding steps and
-- checkout the client sees; access to a paid product is still decided by
-- entitlements (0008), which only the billing webhook writes. That's why the
-- tenant may write products (clients_update, 0004): adding 'seo' to your own
-- workspace unlocks a checkout form, nothing that costs us money.
--
-- Three things change together, same reasoning 0045 gave:
--   1. the column + backfill, then the narrowed business_type CHECK
--   2. sync_voice_agent_mode(): only a client that uses the phone agent gets
--      a voice_agent_mode, now decided by products rather than by
--      business_type <> 'seo'
--   3. handle_new_user(): reads the product and the industry from signup
--      metadata separately; still accepts the old business_type = 'seo'
--      metadata, so a signup from the previous app build during the deploy
--      window lands correctly
--
-- DEPLOY ORDER: apply this, then deploy the app. The app reads products; the
-- previous build reads business_type = 'seo', which this sets to NULL (no
-- production client had it as of 2026-09-23).
--
-- Idempotent / safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. products
-- -----------------------------------------------------------------------------

alter table clients
  add column if not exists products text[] not null default array['voice']::text[];

-- Default 'voice': every client created before this column existed, or seeded
-- by hand, was a phone client, and stepsFor()'s old rule was "unknown means
-- show the phone steps".

alter table clients drop constraint if exists clients_products_chk;
alter table clients
  add constraint clients_products_chk
  check (products <@ array['voice', 'seo']::text[]);

comment on column clients.products is
  'Products this workspace has set up (intent, not payment): voice and/or seo. '
  'Decides which onboarding steps and checkout the client sees. Paid access is '
  'entitlements (0008). Tenant-writable on purpose, see 0059.';

-- Backfill. The column default already gave every existing row {'voice'};
-- only the SEO clients need correcting. Their industry was never asked, so it
-- becomes NULL (the old 'seo' value was a product, not an industry).
update clients
   set products = array['seo']::text[],
       business_type = null
 where business_type = 'seo';

-- -----------------------------------------------------------------------------
-- 1b. business_type is an industry again
-- -----------------------------------------------------------------------------

alter table clients drop constraint if exists clients_business_type_chk;
alter table clients
  add constraint clients_business_type_chk
  check (business_type is null or business_type in ('service', 'ecommerce'));

comment on column clients.business_type is
  'Industry: service (books appointments) or ecommerce (answers order '
  'questions). NULL means never asked. For a client using the phone agent '
  '(products has voice) it also sets settings.voice_agent_mode via '
  'trg_clients_business_type. What the client uses is clients.products (0059).';

-- -----------------------------------------------------------------------------
-- 2. voice_agent_mode follows the industry, for phone clients only
-- -----------------------------------------------------------------------------

create or replace function sync_voice_agent_mode()
returns trigger
language plpgsql
as $$
begin
  if new.business_type is null then
    return new;
  end if;

  -- A client without the phone agent has no agent mode to set. When it adds
  -- the phone agent later, products changes and this runs again.
  if not ('voice' = any(new.products)) then
    return new;
  end if;

  -- Only act when something this depends on changed, so a plain settings
  -- save never clobbers a mode an operator set by hand.
  if tg_op = 'UPDATE' then
    if new.business_type is not distinct from old.business_type
       and ('voice' = any(old.products)) then
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

drop trigger if exists trg_clients_business_type on clients;
create trigger trg_clients_business_type
  before insert or update of business_type, products on clients
  for each row execute function sync_voice_agent_mode();

-- -----------------------------------------------------------------------------
-- 3. handle_new_user — 0045's body, with the product read separately.
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
  v_product    text := lower(nullif(trim(new.raw_user_meta_data->>'product'), ''));
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

-- Verify: scripts/test_client_products.sql (runs in a rolled-back transaction).

-- End of 0059.
