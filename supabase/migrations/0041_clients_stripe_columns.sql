-- =============================================================================
-- 0041_clients_stripe_columns.sql
-- Store Stripe's own customer/subscription identity on the client row, so the
-- billing services layer can call Stripe's API directly instead of routing
-- everything through static Payment Links + a webhook resolution chain.
--
-- Part of the move off Payment Links (see lib/services/billing.ts). Purely
-- additive: no existing table, RPC, or behavior changes. Safe to deploy
-- standalone, ahead of any app code that reads or writes these columns.
--
-- WHY A CLIENT-LEVEL COLUMN, NOT entitlements.external_subscription_ref.
-- That column already exists but is scoped per (client_id, feature) — and the
-- new add-on model needs ONE subscription id to look up "everything this
-- client is subscribed to" (plan + every add-on, all as items on the same
-- subscription). A client-wide column is the thing that question actually
-- maps onto.
-- =============================================================================

alter table clients
  add column if not exists stripe_customer_id         text,
  add column if not exists stripe_subscription_id     text,
  add column if not exists stripe_subscription_status  text;

create unique index if not exists idx_clients_stripe_customer_id
  on clients(stripe_customer_id) where stripe_customer_id is not null;

-- =============================================================================
-- WEBHOOK-OWNED ONLY. clients_update's RLS policy (0001_init_schema.sql) is a
-- ROW check, not column-level:
--
--   create policy clients_update on clients
--     for update using (id = current_client_id())
--     with check (id = current_client_id());
--
-- A signed-in user can already update every column on their OWN clients row —
-- that's how onboarding writes settings/brand_tone_config today. Without this
-- revoke, a tenant could point their own row at someone else's subscription
-- id, or silently clear a past_due status, through any existing or future
-- generic `.update()` against clients. Only lib/services/billing.ts (via the
-- service-role client) may write these three columns.
-- =============================================================================
revoke update (stripe_customer_id, stripe_subscription_id, stripe_subscription_status)
  on clients from authenticated;
