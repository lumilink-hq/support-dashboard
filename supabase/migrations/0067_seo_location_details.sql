-- =============================================================================
-- 0067_seo_location_details.sql
-- Module 28 (plan.md, Phase 6c): the local-detail intake behind module 16's
-- articles. One row per location: the neighbourhoods and towns it serves,
-- nearby landmarks, the services it really offers, and facts the client
-- vouches for (year founded, licensed / insured / bonded, certifications,
-- family- or locally-owned, free estimates, a guarantee, awards).
--
-- seo-content passes these to the model as data and lets an otherwise-blocked
-- claim through only when the matching fact is here (seo-content/lib.ts
-- RISKY_CLAIMS[].allow). See seo-content/details.ts for why the facts are
-- structured fields rather than free text.
--
-- SELF-SERVICE, like seo_keywords: the client writes its own rows. RLS ties
-- every row to the caller's client AND to one of that client's locations.
-- The checks below mirror details.ts DETAIL_LIMITS, so a request that skips
-- the dashboard still can't store an oversized list.
--
-- WHO VOUCHED. Saving is the client confirming the facts are true. A trigger
-- stamps confirmed_by (the signed-in user) and confirmed_at on every write by
-- a signed-in user, so neither can be set by hand.
--
-- Isolation: scripts/test_seo_location_details.sql.
-- Idempotent / safe to re-apply.
-- =============================================================================

create or replace function seo_text_array_ok(a text[], max_items int, max_len int)
returns boolean
language sql
immutable
as $$
  select coalesce(array_length(a, 1), 0) <= max_items
     and not exists (select 1 from unnest(a) x where x is null or length(btrim(x)) < 2 or length(x) > max_len);
$$;

create table if not exists seo_location_details (
  location_id     uuid        primary key references seo_locations(id) on delete cascade,
  client_id       uuid        not null references clients(id) on delete cascade,
  service_areas   text[]      not null default '{}' check (seo_text_array_ok(service_areas, 20, 60)),
  landmarks       text[]      not null default '{}' check (seo_text_array_ok(landmarks, 10, 80)),
  services        text[]      not null default '{}' check (seo_text_array_ok(services, 30, 80)),
  -- 2100, not "this year": a CHECK must not depend on now(). The dashboard
  -- refuses a future year (details.ts cleanYear).
  year_founded    int         check (year_founded between 1800 and 2100),
  licensed        boolean     not null default false,
  insured         boolean     not null default false,
  bonded          boolean     not null default false,
  certifications  text[]      not null default '{}' check (seo_text_array_ok(certifications, 10, 80)),
  family_owned    boolean     not null default false,
  locally_owned   boolean     not null default false,
  free_estimates  boolean     not null default false,
  guarantee       text        check (guarantee is null or length(btrim(guarantee)) between 2 and 120),
  awards          text[]      not null default '{}' check (seo_text_array_ok(awards, 10, 100)),
  confirmed_by    uuid        references users(id) on delete set null,
  confirmed_at    timestamptz,
  updated_at      timestamptz not null default now()
);

create index if not exists idx_seo_location_details_client on seo_location_details(client_id);

drop trigger if exists trg_seo_location_details_updated_at on seo_location_details;
create trigger trg_seo_location_details_updated_at
  before update on seo_location_details
  for each row execute function set_updated_at();

-- Stamp who vouched. Only for signed-in users (service_role writes, e.g. a
-- seed script, keep what they set).
create or replace function seo_location_details_stamp()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is not null then
    new.confirmed_by := auth.uid();
    new.confirmed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_seo_location_details_stamp on seo_location_details;
create trigger trg_seo_location_details_stamp
  before insert or update on seo_location_details
  for each row execute function seo_location_details_stamp();

alter table seo_location_details enable row level security;

drop policy if exists seo_location_details_tenant on seo_location_details;
create policy seo_location_details_tenant on seo_location_details
  for all
  using (client_id = current_client_id())
  with check (
    client_id = current_client_id()
    and exists (select 1 from seo_locations l where l.id = location_id and l.client_id = current_client_id())
  );

revoke all on seo_location_details from anon;
grant select, insert, update, delete on seo_location_details to authenticated;
grant select, insert, update, delete on seo_location_details to service_role;

-- SETUP AFTER APPLYING: redeploy seo-content (it now reads this table):
--   supabase functions deploy seo-content --no-verify-jwt

-- End of 0067.
