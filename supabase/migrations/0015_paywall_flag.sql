-- =============================================================================
-- 0015_paywall_flag.sql
-- (Renumbered from 0009 — it collided with 0009_reschedule_cancel.sql, which
--  meant the Supabase CLI could record one version and silently skip the other.)
-- Global kill switch for the upsell/paywall built in 0008.
--
-- Why: there are no real clients yet, so we do NOT want locked pages or upsell
-- prompts surfacing anywhere. Rather than remembering to keep gating out of the
-- UI, we bake the switch into the SINGLE predicate the whole app gates on
-- (has_feature): while the paywall is OFF, has_feature returns true for every
-- feature, so every page renders unlocked and no upsell is ever shown. The 0008
-- machinery (entitlements, webhook, provisioning) stays intact and dormant.
--
-- Flip it on with:  update app_config set paywall_enabled = true;
-- (service role only). Do that once real clients + entitlements exist.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- app_config — singleton row of global switches. The `id boolean primary key
-- check (id)` trick allows exactly one row (id can only be true).
-- -----------------------------------------------------------------------------
create table if not exists app_config (
  id              boolean     primary key default true check (id),
  paywall_enabled boolean     not null default false,   -- OFF until we have clients
  updated_at      timestamptz not null default now()
);

insert into app_config (id) values (true) on conflict (id) do nothing;

-- `create trigger` is NOT idempotent (unlike the `if not exists` / `or replace`
-- forms used elsewhere in this file), so drop first — otherwise re-applying this
-- migration fails with "trigger already exists".
drop trigger if exists trg_app_config_updated_at on app_config;
create trigger trg_app_config_updated_at
  before update on app_config
  for each row execute function set_updated_at();

-- The flag is non-sensitive and useful to the UI (so the dashboard can hide the
-- upsell components entirely, not just unlock pages). Readable by everyone;
-- writable by the service role only.
alter table app_config enable row level security;
-- Same idempotency problem as the trigger above.
drop policy if exists app_config_select on app_config;
create policy app_config_select on app_config for select using (true);

grant select on app_config to anon, authenticated, service_role;
grant insert, update on app_config to service_role;

-- -----------------------------------------------------------------------------
-- paywall_enabled() — convenience read of the switch, false if the row is
-- somehow missing (fail OPEN: no paywall rather than accidentally locking).
-- -----------------------------------------------------------------------------
create or replace function paywall_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select paywall_enabled from app_config where id), false);
$$;

-- -----------------------------------------------------------------------------
-- has_feature() — redefined to short-circuit while the paywall is off. Same
-- signature as 0008, so every caller (dashboard, agents) picks this up with no
-- change. When the paywall is ON it falls back to the real entitlement check.
-- -----------------------------------------------------------------------------
create or replace function has_feature(p_feature feature_t, p_client_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not paywall_enabled() then true          -- kill switch: everything unlocked
    else exists (
      select 1 from entitlements e
      where e.client_id = coalesce(p_client_id, current_client_id())
        and e.feature   = p_feature
        and e.status in ('active','past_due')
    )
  end;
$$;
