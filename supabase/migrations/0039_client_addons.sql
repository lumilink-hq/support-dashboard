-- =============================================================================
-- 0039_client_addons.sql
-- Record which add-ons (lib/addons.ts) a client actually holds, so /billing can
-- show "Active" instead of an "Add To Plan" button for something already sold.
--
-- WHY THIS DIDN'T EXIST UNTIL NOW. Per lib/addons.ts and docs/STRIPE-TIERS-
-- RUNBOOK.md, every add-on purchase has been manual fulfilment with no record
-- of who bought what — billing_price_map only proves an add-on price BILLS
-- correctly, never that a given client OWNS one. /billing's add-on section
-- rendered the same shop list, with the same "Add To Plan" button, to every
-- client regardless of what they'd already bought.
--
-- SCOPE, DELIBERATELY SMALL. This is display truth for the dashboard, not a
-- new automated fulfilment pipeline. Rows are written by hand (or later, by a
-- webhook — see the closing note) the same way entitlements' `source='manual'`
-- already covers a comped/onboarding grant. It does not make an add-on
-- provision itself; nothing here changes what enqueue_provisioning or
-- provision-feature (0008) do.
--
-- SHAPE MIRRORS entitlements (0008) ON PURPOSE — same status vocabulary, same
-- RLS shape (tenant can read, never write), same updated_at trigger — so a
-- future webhook-driven path can reuse the exact pattern rather than invent a
-- second one.
--
-- addon_key IS NOT AN FK. billing_price_map has one row PER PRICE, so the same
-- addon_key appears on multiple rows across a price rotation (see
-- price_rotation_2026_09.sql) — there is no single row to reference. The
-- source of truth for which keys are valid is lib/addons.ts; this column is
-- free text that must match Addon.key there.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

create table if not exists client_addons (
  id          uuid        primary key default gen_random_uuid(),
  client_id   uuid        not null references clients(id) on delete cascade,
  addon_key   text        not null,          -- matches lib/addons.ts Addon.key

  status      text        not null default 'active'
              check (status in ('pending','active','past_due','canceled')),

  -- How it was granted: 'manual' (this table's only writer today — an operator
  -- adding a subscription item by hand, exactly like this migration's own
  -- budclub grant) or 'checkout', reserved for a future webhook path.
  source      text        not null default 'manual'
              check (source in ('checkout','manual')),

  -- Processor linkage, nullable — populated when the add-on rides a real
  -- Stripe subscription, same convention as entitlements.
  processor                  text,
  external_subscription_ref  text,
  current_period_end         timestamptz,

  started_at   timestamptz not null default now(),
  activated_at timestamptz,
  canceled_at  timestamptz,
  meta         jsonb       not null default '{}'::jsonb,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- One row per (client, add-on) — re-granting the same add-on updates it
  -- rather than duplicating it.
  unique (client_id, addon_key)
);

create index if not exists idx_client_addons_client on client_addons(client_id);

create trigger trg_client_addons_updated_at
  before update on client_addons
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS — same shape as entitlements: the owning tenant can SELECT, never
-- write. Granting a paid add-on is an operator/service-role action, not
-- something a client can self-serve by writing a row.
-- -----------------------------------------------------------------------------
alter table client_addons enable row level security;

create policy client_addons_select on client_addons
  for select using (client_id = current_client_id());

grant select on client_addons to authenticated;   -- RLS still scopes to own tenant
grant select, insert, update, delete on client_addons to service_role;

-- -----------------------------------------------------------------------------
-- STILL TO BUILD, if self-serve add-on purchases should record themselves:
-- billing-webhook would need to read the add-on's `addon_key` off
-- billing_price_map (kind='addon') for each subscription price id and upsert
-- a client_addons row per key, the same way apply_billing_event upserts
-- entitlements today. Nothing here does that yet — every row is written by
-- hand until that's built.
-- -----------------------------------------------------------------------------

-- Verify:
--   select c.slug, a.addon_key, a.status, a.source, a.current_period_end
--     from client_addons a join clients c on c.id = a.client_id
--    order by c.slug, a.addon_key;
