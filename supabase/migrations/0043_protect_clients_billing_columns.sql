-- =============================================================================
-- 0043_protect_clients_billing_columns.sql
-- Fixes forward: 0041's `revoke update (stripe_customer_id, ...) on clients
-- from authenticated` never actually protected anything.
--
-- WHY IT DID NOTHING. 0001 grants `authenticated` a table-wide
-- `update` on every table (`grant select, insert, update, delete on all
-- tables in schema public to authenticated`). In Postgres, a column-level
-- REVOKE only removes a column-specific grant — it cannot narrow a broader
-- table-level grant the role already holds. With table-wide UPDATE still in
-- effect, `authenticated` could keep writing stripe_customer_id /
-- stripe_subscription_id / stripe_subscription_status the entire time,
-- confirmed live via `has_column_privilege('authenticated', 'clients',
-- 'stripe_customer_id', 'UPDATE')` returning true even after re-running 0041.
--
-- The RLS policy on clients (0001's clients_update) is ROW-level only — it
-- can't restrict which columns change within a row a tenant already owns.
-- Column-level GRANT/REVOKE is the textbook Postgres tool for that, but it
-- only works if the table-wide grant is revoked FIRST and specific columns
-- re-granted — a second migration doing that would need to enumerate every
-- other column on `clients` and silently break onboarding the next time a
-- column is added there and this list isn't updated to match. A BEFORE
-- UPDATE trigger is the version of "protect these 3 columns" that doesn't
-- require tracking the other 17.
--
-- SCOPE: blocks the `authenticated` role specifically — the only role an
-- end-user request ever runs as (anon never reaches this table; RLS's
-- clients_update policy already requires being authenticated). service_role,
-- postgres and any other role (an operator fixing data by hand in the SQL
-- editor) are unaffected.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

create or replace function protect_clients_billing_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'authenticated' and (
       new.stripe_customer_id         is distinct from old.stripe_customer_id
    or new.stripe_subscription_id     is distinct from old.stripe_subscription_id
    or new.stripe_subscription_status is distinct from old.stripe_subscription_status
  ) then
    raise exception
      'stripe_customer_id, stripe_subscription_id and stripe_subscription_status '
      'are writable only by the billing service (lib/services/billing.ts, '
      'service_role) — see 0043_protect_clients_billing_columns.sql'
      using errcode = '42501';  -- insufficient_privilege
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_clients_billing_columns on clients;
create trigger trg_protect_clients_billing_columns
  before update on clients
  for each row execute function protect_clients_billing_columns();

comment on function protect_clients_billing_columns() is
  'Blocks the authenticated role from writing clients.stripe_* columns. '
  'Column-level REVOKE cannot do this — see migration header for why.';

-- Verify (expect an insufficient_privilege error on the authenticated attempt,
-- and success for the service_role one):
--   set local role authenticated;
--   update clients set stripe_customer_id = 'cus_forged' where id = current_client_id();
--   reset role;
--   set local role service_role;
--   update clients set stripe_customer_id = 'cus_real' where id = '<some client id>';
--   reset role;

-- End of 0043.
