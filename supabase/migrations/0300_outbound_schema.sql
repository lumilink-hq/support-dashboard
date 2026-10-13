-- =============================================================================
-- 0300_outbound_schema.sql
-- Outbound engine (docs/OUTBOUND-PLAN.md), Phase 1 step 1: cold-email lead
-- generation for LumiLink itself. Four tables plus two helpers:
--
--   outbound_profiles      one audience x product pair (e.g. dispensaries
--                          for SEO): what to source, which Instantly campaign
--   outbound_leads         one business: listing data, email, verification,
--                          funnel stage, Instantly state
--   outbound_events        every stage change, written by trigger; feeds the
--                          funnel and the audit trail
--   outbound_suppressions  never contact: unsubscribes, bounces, invalid
--                          addresses, existing clients, manual blocks
--
-- MIGRATION RANGE. 0300+ is reserved for the outbound branch (main is in the
-- 0090s, the loyalty branch uses 0200+). Pushing this after a lower-numbered
-- migration already reached prod needs `supabase db push --include-all`.
--
-- SERVICE-ROLE ONLY, ON PURPOSE. The staff access model is on hold until the
-- loyalty branch's staff concept lands (2026-10-13). Until then RLS is on with
-- NO policies and the browser roles have no grants, so nothing here is
-- reachable with the public anon key or a signed-in client's JWT. Edge
-- functions use the service role. Phase 3 (portal UI) adds the policies.
-- Profiles therefore have no owner column yet either.
--
-- ONE BUSINESS, ONE CONTACT. Dedupe is global, across profiles: a listing
-- (source, source_ref), a website domain and an email address can each appear
-- on one lead only, so two profiles never email the same business. A chain
-- with several listings on one website is emailed once.
--
-- Test: scripts/test_outbound_schema.sql. Idempotent / safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- 'https://WWW.Example.com:8080/contact?x=1' -> 'example.com'. Also takes a
-- bare host or an email address ('Info@Example.com' -> 'example.com').
create or replace function outbound_normalize_domain(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          lower(btrim(coalesce(p, ''))),
          '^([a-z][a-z0-9+.-]*://)?([^@/]*@)?', ''),   -- scheme, userinfo or email local part
        '[:/?#].*$', ''),                              -- port, path, query, fragment
      '^www\.', ''),
    '');
$$;


-- -----------------------------------------------------------------------------
-- outbound_profiles
-- -----------------------------------------------------------------------------
create table if not exists outbound_profiles (
  id                     uuid        primary key default gen_random_uuid(),
  name                   text        not null unique,
  -- What the profile sells; matches lib/catalog.ts ProductKey.
  product                text        not null check (product in ('voice', 'seo')),
  -- Who to source. Shape owned by outbound-source, e.g.
  -- {"categories": ["cannabis_store"], "location_codes": [1023191],
  --  "has_website": true, "min_rating": 3.5}
  audience               jsonb       not null default '{}'::jsonb
                         check (jsonb_typeof(audience) = 'object'),
  offer                  text,
  instantly_campaign_id  text,
  -- New leads pushed to Instantly per day, across the profile.
  daily_lead_target      int         not null default 50
                         check (daily_lead_target between 0 and 1000),
  status                 text        not null default 'draft'
                         check (status in ('draft', 'active', 'paused')),
  -- An active profile must say where its leads go.
  constraint outbound_profiles_active_needs_campaign
    check (status <> 'active' or instantly_campaign_id is not null),
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

drop trigger if exists trg_outbound_profiles_updated_at on outbound_profiles;
create trigger trg_outbound_profiles_updated_at
  before update on outbound_profiles
  for each row execute function set_updated_at();


-- -----------------------------------------------------------------------------
-- outbound_leads
-- -----------------------------------------------------------------------------
create table if not exists outbound_leads (
  id                        uuid        primary key default gen_random_uuid(),
  -- Restrict, not cascade: a lead's history outlives a deleted profile only if
  -- someone moves or archives it deliberately.
  profile_id                uuid        not null references outbound_profiles(id) on delete restrict,

  -- Where the business came from.
  source                    text        not null default 'dataforseo'
                            check (source in ('dataforseo', 'manual')),
  source_ref                text        not null,            -- DataForSEO cid / place_id, or a manual key
  raw                       jsonb,                            -- the source item as returned

  -- The business.
  business_name             text        not null,
  category                  text,
  address                   text,
  city                      text,
  region                    text,                             -- state
  postal_code               text,
  country_code              text        not null default 'US',
  phone                     text,
  website_url               text,
  domain                    text,                             -- set by trigger from website_url
  rating                    numeric(2,1) check (rating is null or rating between 0 and 5),
  review_count              int          check (review_count is null or review_count >= 0),

  -- Email finding (outbound-enrich) and verification (outbound-verify).
  email                     text,
  email_source_url          text,
  email_found_at            timestamptz,
  verification              text
                            check (verification in ('valid', 'invalid', 'catch_all', 'unknown', 'disposable')),
  verified_at               timestamptz,

  -- Funnel.
  stage                     text        not null default 'sourced'
                            check (stage in (
                              'sourced',                    -- listing saved, no email search yet
                              'email_found', 'no_email',    -- outbound-enrich
                              'verified', 'invalid',        -- outbound-verify
                              'queued',                     -- pushed to Instantly
                              'replied',                    -- any reply seen by polling
                              'positive', 'negative',       -- triaged by a person
                              'called', 'booked',
                              'won', 'lost',
                              'finished',                   -- sequence ended with no reply
                              'suppressed'                  -- unsubscribed / bounced / blocked
                            )),
  stage_changed_at          timestamptz not null default now(),

  -- Instantly state.
  instantly_lead_id         text,
  pushed_at                 timestamptz,
  last_reply_at             timestamptz,
  reply_snippet             text,
  -- Instantly's uploaded-contacts cap is a running total (1,000 on Growth):
  -- finished leads are deleted there once their state is saved here.
  removed_from_instantly_at timestamptz,

  notes                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint outbound_leads_source_unique unique (source, source_ref),
  constraint outbound_leads_email_needs_found_at
    check (email is null or email_found_at is not null),
  constraint outbound_leads_verification_needs_email
    check (verification is null or email is not null)
);

create unique index if not exists uq_outbound_leads_email
  on outbound_leads (lower(email)) where email is not null;
create unique index if not exists uq_outbound_leads_domain
  on outbound_leads (domain) where domain is not null;
create index if not exists idx_outbound_leads_profile_stage
  on outbound_leads (profile_id, stage);
create unique index if not exists uq_outbound_leads_instantly
  on outbound_leads (instantly_lead_id) where instantly_lead_id is not null;

-- domain always follows website_url, so dedupe can't be bypassed by a caller
-- that forgets to set it.
create or replace function outbound_leads_set_domain()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.domain := outbound_normalize_domain(new.website_url);
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    new.stage_changed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_outbound_leads_set_domain on outbound_leads;
create trigger trg_outbound_leads_set_domain
  before insert or update on outbound_leads
  for each row execute function outbound_leads_set_domain();

drop trigger if exists trg_outbound_leads_updated_at on outbound_leads;
create trigger trg_outbound_leads_updated_at
  before update on outbound_leads
  for each row execute function set_updated_at();


-- -----------------------------------------------------------------------------
-- outbound_events — written by trigger on every insert and stage change.
-- Functions may also insert their own (e.g. 'reply', 'push_failed').
-- -----------------------------------------------------------------------------
create table if not exists outbound_events (
  id          bigint      generated always as identity primary key,
  lead_id     uuid        not null references outbound_leads(id) on delete cascade,
  profile_id  uuid        not null references outbound_profiles(id) on delete cascade,
  type        text        not null,          -- 'stage' or a function-defined type
  from_stage  text,
  to_stage    text,
  detail      jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists idx_outbound_events_lead on outbound_events (lead_id, created_at);
create index if not exists idx_outbound_events_profile on outbound_events (profile_id, created_at);

create or replace function outbound_leads_log_stage()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into outbound_events (lead_id, profile_id, type, from_stage, to_stage)
    values (new.id, new.profile_id, 'stage', null, new.stage);
  elsif new.stage is distinct from old.stage then
    insert into outbound_events (lead_id, profile_id, type, from_stage, to_stage)
    values (new.id, new.profile_id, 'stage', old.stage, new.stage);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_outbound_leads_log_stage on outbound_leads;
create trigger trg_outbound_leads_log_stage
  after insert or update of stage on outbound_leads
  for each row execute function outbound_leads_log_stage();


-- -----------------------------------------------------------------------------
-- outbound_suppressions — an email, or a whole domain (email null).
-- -----------------------------------------------------------------------------
create table if not exists outbound_suppressions (
  id          uuid        primary key default gen_random_uuid(),
  email       text,
  domain      text,
  reason      text        not null
              check (reason in ('unsubscribed', 'bounced', 'complained', 'invalid', 'client', 'manual')),
  source      text,                          -- 'instantly', 'reoon', 'operator', ...
  note        text,
  created_at  timestamptz not null default now(),
  constraint outbound_suppressions_target check (email is not null or domain is not null)
);

create unique index if not exists uq_outbound_suppressions_email
  on outbound_suppressions (lower(email)) where email is not null;
create unique index if not exists uq_outbound_suppressions_domain
  on outbound_suppressions (domain) where email is null;

create or replace function outbound_suppressions_normalize()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.email  := nullif(lower(btrim(coalesce(new.email, ''))), '');
  new.domain := outbound_normalize_domain(coalesce(new.domain, new.email));
  return new;
end;
$$;

drop trigger if exists trg_outbound_suppressions_normalize on outbound_suppressions;
create trigger trg_outbound_suppressions_normalize
  before insert or update on outbound_suppressions
  for each row execute function outbound_suppressions_normalize();

-- True when the address or its domain must never be contacted: a suppression
-- row for the exact email, a domain-wide suppression, or a LumiLink client's
-- website domain (seo_locations). Webmail domains (gmail.com etc.) are only
-- ever suppressed per address, never as a whole domain by this function.
create or replace function outbound_is_suppressed(p_email text, p_website text default null)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  with d as (
    select nullif(lower(btrim(coalesce(p_email, ''))), '')  as email,
           outbound_normalize_domain(p_email)               as email_domain,
           outbound_normalize_domain(p_website)             as site_domain
  )
  select exists (
           select 1 from outbound_suppressions s, d
            where s.email is not null and lower(s.email) = d.email
         )
      or exists (
           select 1 from outbound_suppressions s, d
            where s.email is null and s.domain in (d.email_domain, d.site_domain)
         )
      or exists (
           select 1 from seo_locations l, d
            where outbound_normalize_domain(l.website_url) in (d.email_domain, d.site_domain)
         );
$$;


-- -----------------------------------------------------------------------------
-- Funnel: leads per profile per stage. security_invoker, so when Phase 3 adds
-- policies the view follows them.
-- -----------------------------------------------------------------------------
create or replace view outbound_funnel with (security_invoker = true) as
select p.id as profile_id, p.name as profile_name, p.product, l.stage, count(l.id) as leads
  from outbound_profiles p
  left join outbound_leads l on l.profile_id = p.id
 group by p.id, p.name, p.product, l.stage;


-- -----------------------------------------------------------------------------
-- Lock down: RLS on, no policies, no browser grants (see header).
-- -----------------------------------------------------------------------------
alter table outbound_profiles     enable row level security;
alter table outbound_leads        enable row level security;
alter table outbound_events       enable row level security;
alter table outbound_suppressions enable row level security;

revoke all on outbound_profiles, outbound_leads, outbound_events, outbound_suppressions, outbound_funnel
  from anon, authenticated;

revoke all on function outbound_normalize_domain(text) from public, anon, authenticated;
revoke all on function outbound_is_suppressed(text, text) from public, anon, authenticated;
revoke all on function outbound_leads_set_domain() from public, anon, authenticated;
revoke all on function outbound_leads_log_stage() from public, anon, authenticated;
revoke all on function outbound_suppressions_normalize() from public, anon, authenticated;
