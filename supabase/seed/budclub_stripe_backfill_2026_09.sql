-- =============================================================================
-- budclub_stripe_backfill_2026_09.sql — write Bud Club's (budmember001) real
-- Stripe identity onto clients.stripe_customer_id / stripe_subscription_id,
-- since their subscription predates 0041_clients_stripe_columns.sql and the
-- move to direct Stripe API calls (lib/services/billing.ts).
--
-- SOURCE: Stripe's own subscriptions export (jay@budclub.com / Jimmy Ngo),
-- confirming their Website Chat add-on already rides the SAME subscription as
-- their Starter plan — not a separate one:
--
--   sub_1TzSBD2LgljE9PpsBihz6AbW  cus_UzR3DJX4t51pBD  jay@budclub.com
--     price_1Tyltq2LgljE9Ppsatk8ckzq  (Starter, $179 — the old price id;
--       still valid, Stripe prices are immutable, renewals keep using it)
--     price_1UEd882LgljE9PpsOswMYp5M  (Website Chat, $40)
--   status: active
--
-- Once this runs, activeAddonsForClient/hasStripeCustomerForClient
-- (lib/services/billing.ts) read this directly — no client_addons row, no
-- webhook event needed. This is what actually fixes "Website Chat shows as
-- inactive for budclub," not a client_addons patch.
--
-- NOT a migration. Per-client data, run by hand. Safe to re-run — plain
-- update, no insert.
-- =============================================================================

do $$
declare
  v_id uuid;
begin
  select id into v_id from clients where slug = 'budmember001';
  if v_id is null then
    raise exception 'No client with slug "budmember001". Nothing was configured.';
  end if;
  raise notice 'Backfilling Stripe identity for client % (budmember001)', v_id;
end;
$$;

update clients
   set stripe_customer_id        = 'cus_UzR3DJX4t51pBD',
       stripe_subscription_id    = 'sub_1TzSBD2LgljE9PpsBihz6AbW',
       stripe_subscription_status = 'active'
 where slug = 'budmember001';

-- Verify:
select slug, stripe_customer_id, stripe_subscription_id, stripe_subscription_status
  from clients
 where slug = 'budmember001';
