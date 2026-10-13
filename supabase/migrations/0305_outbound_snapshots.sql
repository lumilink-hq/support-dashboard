-- =============================================================================
-- 0305_outbound_snapshots.sql
-- Outbound engine (docs/OUTBOUND-PLAN.md), Phase 4: the pre-call SEO
-- snapshot. Built by outbound-snapshot for one lead, read by whoever makes
-- the call (and, from Phase 3, by the portal's reply inbox).
--
-- A snapshot is what Robin's call script promises a prospect: their website,
-- their Google listing against nearby competitors, where they show up for
-- the search that matters, and a to-do list they get whether they sign up or
-- not. `data` holds the raw checks; `todo` is the ordered list of plain-
-- language items generated from them (outbound-snapshot/lib.ts buildTodo).
--
-- History is kept: a lead can have several snapshots (e.g. one before the
-- call, one months later). The newest is the current one.
--
-- Service-role only, like 0300-0304.
-- Test: scripts/test_outbound_snapshots.sql. Idempotent / safe to re-apply.
-- =============================================================================

create table if not exists outbound_snapshots (
  id          uuid        primary key default gen_random_uuid(),
  lead_id     uuid        not null references outbound_leads(id) on delete cascade,
  status      text        not null check (status in ('ready', 'partial', 'failed')),
  keyword     text,                        -- the search the ranking check used
  data        jsonb       not null default '{}'::jsonb,
  todo        jsonb       not null default '[]'::jsonb check (jsonb_typeof(todo) = 'array'),
  summary     text,                        -- two or three lines for the caller
  cost        numeric(8,4),                -- DataForSEO spend for this snapshot, USD
  error       text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_outbound_snapshots_lead on outbound_snapshots (lead_id, created_at desc);

alter table outbound_snapshots enable row level security;
revoke all on outbound_snapshots from anon, authenticated;
