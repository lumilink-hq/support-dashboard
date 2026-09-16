-- =============================================================================
-- 0042_seo_schema_and_rls.sql
-- Foundation schema for the LumiLink SEO product line (see plan.md, module 1).
--
-- WHAT: seven tenant-scoped tables plus the competitor/backlink tables modules
-- 15/18 need, all children of `clients` (a client with N locations gets N
-- seo_locations rows — this is what module 12 bills seats against). Every
-- table carries client_id, even where location_id would resolve it, same
-- denormalize-for-RLS-and-scale convention as messages/orders_cache in 0001.
--
-- WRITE OWNERSHIP splits tables into two shapes:
--   * Self-service setup (seo_locations, seo_keywords, seo_competitors) —
--     the client configures these, so tenants get full CRUD scoped to their
--     own client_id, same as conversations/messages in 0001.
--   * Vendor/AI-collected data (seo_rankings, seo_metrics_daily, seo_citations,
--     seo_backlink_snapshots, seo_competitor_rankings) — only scheduled jobs
--     and the AI pipeline write these, so tenants get SELECT only, same as
--     voice_usage_events (0012) and client_addons (0039).
--   * seo_findings and seo_actions are in between: the backend drafts them,
--     but a human must be able to act (dismiss a finding, approve/reject an
--     action) without a round trip through service_role. Each gets a single
--     narrow UPDATE policy whose USING/WITH CHECK only allows that one status
--     transition — a tenant cannot self-approve a draft into 'published' or
--     resurrect a dismissed finding by writing the row directly. Rule 1 (plan.md
--     §"Rules that apply to every module") still holds: the row only says a
--     human clicked approve; the actual external write happens in the backend
--     job that reads status='approved', same separation review_queue already
--     uses for human-resolved items.
--
-- RULE 2 ("name, address, phone and primary category are never writable by
-- automation") is enforced twice: once in the write-path code (app layer) and
-- once here, as a hard CHECK on seo_actions.target_field, so a bug in the
-- write path can't silently widen the allowlist.
--
-- RULE 4 (security_invoker + explicit revoke + isolation test) is exercised
-- by seo_location_overview below. See scripts/test_seo_schema_isolation.sql
-- for the isolation test — it fails loudly if `security_invoker` is dropped.
--
-- Idempotent where practical so it can be re-applied in a fresh environment.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- seo_locations — one row per business location. Multi-location clients (the
-- product supports 1 to 100+) get one row per location; module 12 bills seats
-- off this count via Payment Link metadata, not by counting these rows live.
--
-- google_place_id / gbp_* columns stay null until Phase 4 (module 11's location
-- mapping step, once the GBP API grant lands) populates them — nothing here
-- depends on the grant.
-- -----------------------------------------------------------------------------
create table if not exists seo_locations (
  id                uuid        primary key default gen_random_uuid(),
  client_id         uuid        not null references clients(id) on delete cascade,

  name              text        not null,
  address_line1     text,
  address_line2     text,
  city              text,
  region            text,                                -- state / province
  postal_code       text,
  country_code      text,                                -- ISO 3166-1 alpha-2
  lat               numeric(9,6),
  lng               numeric(9,6),                          -- geo grid center (module 7)
  phone_number      text,
  website_url       text,

  -- Cached from GBP profile sync (module 3) for display. NOT the write target —
  -- writes to name/address/phone/primary_category go through the allowlist
  -- check on seo_actions below, never straight to these columns.
  primary_category  text,

  -- Populated once, in Phase 4, by module 11's location mapping step.
  google_place_id   text,
  gbp_account_id    text,
  gbp_location_name text,                                -- Google resource name, e.g. "locations/12345"
  gbp_connected_at  timestamptz,

  is_active         boolean     not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_seo_locations_client on seo_locations(client_id);
create unique index if not exists uq_seo_locations_place
  on seo_locations(client_id, google_place_id) where google_place_id is not null;

drop trigger if exists trg_seo_locations_updated_at on seo_locations;
create trigger trg_seo_locations_updated_at
  before update on seo_locations
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- seo_keywords — tracked per location. Rule (module 7): the 5x5 geo grid must
-- be turned on per keyword by a person and must not multiply on its own, so
-- is_geo_grid_enabled defaults false and enabled_by/enabled_at record who did it.
-- -----------------------------------------------------------------------------
create table if not exists seo_keywords (
  id                    uuid        primary key default gen_random_uuid(),
  client_id             uuid        not null references clients(id) on delete cascade,
  location_id           uuid        not null references seo_locations(id) on delete cascade,

  keyword               text        not null,
  is_geo_grid_enabled   boolean     not null default false,
  enabled_by            uuid        references users(id) on delete set null,
  enabled_at            timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (location_id, keyword)
);

create index if not exists idx_seo_keywords_client on seo_keywords(client_id);
create index if not exists idx_seo_keywords_location on seo_keywords(location_id);

drop trigger if exists trg_seo_keywords_updated_at on seo_keywords;
create trigger trg_seo_keywords_updated_at
  before update on seo_keywords
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- seo_rankings — weekly organic/local-pack position per keyword, plus the 5x5
-- geo grid on priority keywords. grid_row/grid_col default to 0 (not null) so
-- the uniqueness constraint actually dedupes non-grid rows too — Postgres
-- treats NULL <> NULL, which would let duplicate organic rows through a
-- (…, null, null, …) unique key.
-- -----------------------------------------------------------------------------
create table if not exists seo_rankings (
  id            uuid        primary key default gen_random_uuid(),
  client_id     uuid        not null references clients(id) on delete cascade,
  location_id   uuid        not null references seo_locations(id) on delete cascade,
  keyword_id    uuid        not null references seo_keywords(id) on delete cascade,

  rank_type     text        not null check (rank_type in ('organic', 'local_pack', 'geo_grid')),
  grid_row      int         not null default 0,
  grid_col      int         not null default 0,
  position      int,                                     -- null = not found within tracked depth
  serp_url      text,
  raw           jsonb       not null default '{}'::jsonb, -- full SERP snapshot; module 18 matches
                                                           -- competitor domains against this, no
                                                           -- extra vendor call needed
  check_date    date        not null default current_date,
  checked_at    timestamptz not null default now(),

  check (rank_type <> 'geo_grid' or (grid_row between 1 and 5 and grid_col between 1 and 5)),
  check (rank_type = 'geo_grid'  or (grid_row = 0 and grid_col = 0)),

  unique (keyword_id, rank_type, grid_row, grid_col, check_date)
);

create index if not exists idx_seo_rankings_client on seo_rankings(client_id);
create index if not exists idx_seo_rankings_location_date on seo_rankings(location_id, check_date desc);
create index if not exists idx_seo_rankings_keyword_date on seo_rankings(keyword_id, check_date desc);

-- -----------------------------------------------------------------------------
-- seo_metrics_daily — nightly GBP performance pull. `metrics` stays JSONB
-- (rather than one column per metric) because Google's daily-metric set is
-- vendor-defined and has changed before; same reasoning as orders_cache's
-- raw_* columns for full fidelity without a migration per new field.
-- -----------------------------------------------------------------------------
create table if not exists seo_metrics_daily (
  id            uuid        primary key default gen_random_uuid(),
  client_id     uuid        not null references clients(id) on delete cascade,
  location_id   uuid        not null references seo_locations(id) on delete cascade,

  metric_date   date        not null,
  metrics       jsonb       not null default '{}'::jsonb, -- views_maps, views_search, calls,
                                                           -- direction_requests, website_clicks,
                                                           -- reviews_count, reviews_avg_rating, ...
  source        text        not null default 'gbp' check (source in ('gbp')),
  created_at    timestamptz not null default now(),

  unique (location_id, metric_date)
);

create index if not exists idx_seo_metrics_client on seo_metrics_daily(client_id);

-- -----------------------------------------------------------------------------
-- seo_findings — audit output from modules 3/6/9/17. Tenants can dismiss an
-- open finding themselves (see RLS below); every other transition is backend.
-- -----------------------------------------------------------------------------
create table if not exists seo_findings (
  id            uuid        primary key default gen_random_uuid(),
  client_id     uuid        not null references clients(id) on delete cascade,
  location_id   uuid        not null references seo_locations(id) on delete cascade,

  module        text        not null check (module in ('crawl', 'technical', 'gbp_profile', 'citations')),
  finding_type  text        not null,                     -- evolving set, e.g. 'thin_content',
                                                           -- 'missing_schema', 'redirect_chain' —
                                                           -- free text on purpose, see 0001's rule
                                                           -- for evolving-set columns
  severity      text        not null default 'info' check (severity in ('critical', 'warning', 'info')),
  title         text        not null,
  details       jsonb       not null default '{}'::jsonb,
  target_url    text,

  status        text        not null default 'open'
                check (status in ('open', 'actioned', 'dismissed', 'resolved')),

  detected_at   timestamptz not null default now(),
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_seo_findings_client_status on seo_findings(client_id, status);
create index if not exists idx_seo_findings_location on seo_findings(location_id, module);

drop trigger if exists trg_seo_findings_updated_at on seo_findings;
create trigger trg_seo_findings_updated_at
  before update on seo_findings
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- seo_actions — the approval queue (module 8). previous_value + idempotency_key
-- are rule 3 ("every write stores the previous value ... and carries an
-- idempotency key"). target_field's CHECK is rule 2's DB-level backstop.
-- -----------------------------------------------------------------------------
create table if not exists seo_actions (
  id                uuid        primary key default gen_random_uuid(),
  client_id         uuid        not null references clients(id) on delete cascade,
  location_id       uuid        not null references seo_locations(id) on delete cascade,
  finding_id        uuid        references seo_findings(id) on delete set null,

  action_type       text        not null,                 -- 'gbp_field_update', 'review_reply',
                                                           -- 'onpage_fix', 'content_publish',
                                                           -- 'off_page_order', ...
  target_field      text,                                 -- populated for gbp_field_update / onpage_fix

  previous_value    jsonb,                                -- rule 3: rollback source of truth
  proposed_value    jsonb       not null default '{}'::jsonb,
  diff              jsonb,                                -- before/after diff shown in the queue

  status            text        not null default 'draft'
                    check (status in ('draft', 'pending_approval', 'approved', 'rejected',
                                       'published', 'rolled_back', 'failed', 'escalated')),
  idempotency_key   text        not null,
  drafted_by        text,                                 -- model tier used, e.g. 'sonnet-class'
  approved_by       uuid        references users(id) on delete set null,
  approved_at       timestamptz,
  published_at      timestamptz,
  rolled_back_at    timestamptz,
  error             text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (idempotency_key),
  -- Rule 2, enforced at the DB in addition to the write-path allowlist.
  check (target_field is null or lower(target_field) not in
         ('name', 'address', 'phone', 'primary_category'))
);

create index if not exists idx_seo_actions_client_status on seo_actions(client_id, status);
create index if not exists idx_seo_actions_location on seo_actions(location_id);

drop trigger if exists trg_seo_actions_updated_at on seo_actions;
create trigger trg_seo_actions_updated_at
  before update on seo_actions
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- seo_citations — NAP snapshot per (location, source). Latest-state table
-- (like orders_cache), not a full history — module 9 reports drift against
-- the current snapshot, not a timeline.
-- -----------------------------------------------------------------------------
create table if not exists seo_citations (
  id                uuid        primary key default gen_random_uuid(),
  client_id         uuid        not null references clients(id) on delete cascade,
  location_id       uuid        not null references seo_locations(id) on delete cascade,

  source            text        not null,                 -- 'google', 'bing', 'apple', or an aggregator name
  listed_name       text,
  listed_address    text,
  listed_phone      text,
  listed_website    text,

  match_status      text        not null default 'unknown'
                    check (match_status in ('match', 'mismatch', 'missing', 'unknown')),
  mismatch_details  jsonb       not null default '{}'::jsonb,

  checked_at        timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (location_id, source)
);

create index if not exists idx_seo_citations_client on seo_citations(client_id);

drop trigger if exists trg_seo_citations_updated_at on seo_citations;
create trigger trg_seo_citations_updated_at
  before update on seo_citations
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- seo_competitors + seo_competitor_rankings (module 18) — up to 5 domains per
-- location, chosen at onboarding. Rankings are matched from the SERP results
-- seo_rankings.raw already fetched, so no new vendor call per plan.md.
-- -----------------------------------------------------------------------------
create table if not exists seo_competitors (
  id            uuid        primary key default gen_random_uuid(),
  client_id     uuid        not null references clients(id) on delete cascade,
  location_id   uuid        not null references seo_locations(id) on delete cascade,

  domain        text        not null,
  label         text,
  is_active     boolean     not null default true,
  added_by      uuid        references users(id) on delete set null,
  created_at    timestamptz not null default now(),

  unique (location_id, domain)
);

create index if not exists idx_seo_competitors_client on seo_competitors(client_id);

create table if not exists seo_competitor_rankings (
  id             uuid        primary key default gen_random_uuid(),
  client_id      uuid        not null references clients(id) on delete cascade,
  location_id    uuid        not null references seo_locations(id) on delete cascade,
  competitor_id  uuid        not null references seo_competitors(id) on delete cascade,
  keyword_id     uuid        not null references seo_keywords(id) on delete cascade,

  rank_type      text        not null check (rank_type in ('organic', 'local_pack')),
  position       int,
  serp_url       text,
  check_date     date        not null default current_date,
  created_at     timestamptz not null default now(),

  unique (competitor_id, keyword_id, rank_type, check_date)
);

create index if not exists idx_seo_competitor_rankings_client on seo_competitor_rankings(client_id);
create index if not exists idx_seo_competitor_rankings_location_date
  on seo_competitor_rankings(location_id, check_date desc);

-- -----------------------------------------------------------------------------
-- seo_backlink_snapshots (module 15) — monthly link profile.
-- -----------------------------------------------------------------------------
create table if not exists seo_backlink_snapshots (
  id                       uuid        primary key default gen_random_uuid(),
  client_id                uuid        not null references clients(id) on delete cascade,
  location_id              uuid        not null references seo_locations(id) on delete cascade,

  snapshot_date            date        not null,
  referring_domains_count  int,
  total_backlinks          int,
  gained_count             int,
  lost_count               int,
  top_linked_pages         jsonb       not null default '[]'::jsonb,
  raw                      jsonb       not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),

  unique (location_id, snapshot_date)
);

create index if not exists idx_seo_backlink_snapshots_client on seo_backlink_snapshots(client_id);

-- =============================================================================
-- Row-Level Security
-- =============================================================================
alter table seo_locations            enable row level security;
alter table seo_keywords             enable row level security;
alter table seo_rankings             enable row level security;
alter table seo_metrics_daily        enable row level security;
alter table seo_findings             enable row level security;
alter table seo_actions              enable row level security;
alter table seo_citations            enable row level security;
alter table seo_competitors          enable row level security;
alter table seo_competitor_rankings  enable row level security;
alter table seo_backlink_snapshots   enable row level security;

-- --- Self-service setup: full tenant CRUD, same shape as conversations (0001).
drop policy if exists seo_locations_tenant on seo_locations;
create policy seo_locations_tenant on seo_locations
  for all using (client_id = current_client_id())
  with check (client_id = current_client_id());

drop policy if exists seo_keywords_tenant on seo_keywords;
create policy seo_keywords_tenant on seo_keywords
  for all using (client_id = current_client_id())
  with check (client_id = current_client_id());

drop policy if exists seo_competitors_tenant on seo_competitors;
create policy seo_competitors_tenant on seo_competitors
  for all using (client_id = current_client_id())
  with check (client_id = current_client_id());

-- --- Vendor/AI-collected data: tenant read-only, same shape as voice_usage_events (0012).
drop policy if exists seo_rankings_tenant_select on seo_rankings;
create policy seo_rankings_tenant_select on seo_rankings
  for select using (client_id = current_client_id());

drop policy if exists seo_metrics_daily_tenant_select on seo_metrics_daily;
create policy seo_metrics_daily_tenant_select on seo_metrics_daily
  for select using (client_id = current_client_id());

drop policy if exists seo_citations_tenant_select on seo_citations;
create policy seo_citations_tenant_select on seo_citations
  for select using (client_id = current_client_id());

drop policy if exists seo_competitor_rankings_tenant_select on seo_competitor_rankings;
create policy seo_competitor_rankings_tenant_select on seo_competitor_rankings
  for select using (client_id = current_client_id());

drop policy if exists seo_backlink_snapshots_tenant_select on seo_backlink_snapshots;
create policy seo_backlink_snapshots_tenant_select on seo_backlink_snapshots
  for select using (client_id = current_client_id());

-- --- seo_findings: tenant can read everything, and dismiss an OPEN finding —
--     nothing else. Any other status change (actioned, resolved) is backend.
drop policy if exists seo_findings_tenant_select on seo_findings;
create policy seo_findings_tenant_select on seo_findings
  for select using (client_id = current_client_id());

drop policy if exists seo_findings_tenant_dismiss on seo_findings;
create policy seo_findings_tenant_dismiss on seo_findings
  for update using (client_id = current_client_id() and status = 'open')
  with check (client_id = current_client_id() and status = 'dismissed');

-- --- seo_actions: tenant can read everything, and resolve a PENDING_APPROVAL
--     draft to approved/rejected — the human-approval click in rule 1. The
--     backend (service_role) still performs the actual publish/rollback and
--     owns every other status transition.
drop policy if exists seo_actions_tenant_select on seo_actions;
create policy seo_actions_tenant_select on seo_actions
  for select using (client_id = current_client_id());

drop policy if exists seo_actions_tenant_approve on seo_actions;
create policy seo_actions_tenant_approve on seo_actions
  for update using (client_id = current_client_id() and status = 'pending_approval')
  with check (client_id = current_client_id() and status in ('approved', 'rejected'));

-- -----------------------------------------------------------------------------
-- Defense in depth: 0001's default privileges hand `authenticated` full CRUD
-- on every future table. RLS policies above already narrow the effective
-- access, but revoke the write grants outright on the read-only tables so a
-- future permissive policy can't silently reopen them — same reasoning 0012
-- used for voice_usage_events.
-- -----------------------------------------------------------------------------
revoke insert, update, delete on seo_rankings             from authenticated, anon;
revoke insert, update, delete on seo_metrics_daily         from authenticated, anon;
revoke insert, update, delete on seo_citations             from authenticated, anon;
revoke insert, update, delete on seo_competitor_rankings   from authenticated, anon;
revoke insert, update, delete on seo_backlink_snapshots     from authenticated, anon;
revoke insert, delete         on seo_findings              from authenticated, anon;
revoke insert, delete         on seo_actions               from authenticated, anon;

grant select on seo_rankings             to authenticated, service_role;
grant select on seo_metrics_daily        to authenticated, service_role;
grant select on seo_citations            to authenticated, service_role;
grant select on seo_competitor_rankings  to authenticated, service_role;
grant select on seo_backlink_snapshots   to authenticated, service_role;
grant select, update on seo_findings     to authenticated;
grant select, update on seo_actions      to authenticated;
grant insert, update, delete on seo_rankings             to service_role;
grant insert, update, delete on seo_metrics_daily         to service_role;
grant insert, update, delete on seo_citations             to service_role;
grant insert, update, delete on seo_competitor_rankings   to service_role;
grant insert, update, delete on seo_backlink_snapshots     to service_role;
grant insert, delete on seo_findings to service_role;
grant insert, delete on seo_actions  to service_role;

-- =============================================================================
-- Reporting view — rule 4: security_invoker, explicit revoke, isolation test.
-- =============================================================================
create or replace view seo_location_overview with (security_invoker = true) as
select
  l.id                as location_id,
  l.client_id,
  l.name,
  count(distinct k.id)                                             as keyword_count,
  count(distinct k.id) filter (where k.is_geo_grid_enabled)        as geo_grid_keyword_count,
  count(distinct f.id) filter (where f.status = 'open')            as open_findings_count,
  count(distinct f.id) filter (where f.status = 'open'
                                 and f.severity = 'critical')       as critical_findings_count,
  count(distinct a.id) filter (where a.status = 'pending_approval') as pending_actions_count
from seo_locations l
left join seo_keywords k on k.location_id = l.id
left join seo_findings f on f.location_id = l.id
left join seo_actions  a on a.location_id = l.id
group by l.id, l.client_id, l.name;

-- security_invoker makes the underlying RLS apply to the querying user, so this
-- grant is safe even though it matches 0001's default-privilege grant — see
-- 0012's voice_usage_current for the identical reasoning. Revoke first anyway
-- (rule 4's "explicit revoke") so the grant below is never accidental.
revoke all on seo_location_overview from authenticated, anon;
grant select on seo_location_overview to authenticated, service_role;

comment on table seo_locations is
  'One row per business location. Child of clients; module 12 bills seats off '
  'this count via Payment Link metadata, not a live count of this table.';
comment on table seo_actions is
  'Approval queue (module 8). previous_value + idempotency_key are rule 3 '
  '(every write is rollback-able and idempotent). target_field''s CHECK is the '
  'DB-level backstop for rule 2''s NAP/category allowlist.';
comment on view seo_location_overview is
  'security_invoker=true is load-bearing — see scripts/test_seo_schema_isolation.sql.';

-- End of 0042.
