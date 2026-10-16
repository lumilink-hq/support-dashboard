-- =============================================================================
-- test_seo_trial_takeover.sql — a paid SEO subscription takes over a
-- hand-granted trial (PACKS) without a gap in service.
--
-- The sequence lib/services/billing.ts runs once the first invoice is paid:
-- apply_billing_event('subscription_activated'), then flip the row's source
-- from 'trial' to 'checkout' where external_subscription_ref = the new
-- subscription. Then a failed renewal and the cancellation must reach the row.
--
-- WHY THE TRIAL ISN'T CANCELLED FIRST: a canceled row whose
-- external_subscription_ref is null counts as "same subscription" in
-- apply_billing_event, so the paid activation would be dropped as
-- stale_ignored. Asserted at the end.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_trial_takeover.sql
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_ent    entitlements%rowtype;
  v_res    jsonb;
begin
  insert into clients (name, slug, is_active) values ('Trial Co', 'trial-takeover-test', true) returning id into v_client;
  insert into entitlements (client_id, feature, status, source, seat_count)
  values (v_client, 'seo', 'active', 'trial', 4);

  -- While ACH clears nothing is called, so the trial keeps the jobs running.
  assert seo_billing_active(v_client), 'trial: SEO jobs run while the payment clears';

  -- Invoice paid: activation lands on the same row.
  v_res := apply_billing_event('stripe', 'evt_takeover_1', 'subscription_activated', v_client, 'seo',
                               'sub_paid_1', now() + interval '1 month', '{}'::jsonb, null, 4);
  assert v_res->>'status' = 'applied', format('activation applied, got %s', v_res);
  update entitlements set source = 'checkout'
   where client_id = v_client and feature = 'seo' and source = 'trial' and external_subscription_ref = 'sub_paid_1';

  select * into v_ent from entitlements where client_id = v_client and feature = 'seo';
  assert v_ent.status = 'active', format('still active, got %s', v_ent.status);
  assert v_ent.source = 'checkout', format('now a paid entitlement, got %s', v_ent.source);
  assert v_ent.external_subscription_ref = 'sub_paid_1', 'linked to the paid subscription';
  assert v_ent.seat_count = 4, 'seat count from the subscription';
  assert v_ent.current_period_end is not null, 'period end set';
  assert (select count(*) from entitlements where client_id = v_client and feature = 'seo') = 1, 'one row, not two';

  -- A later failed renewal and the cancellation reach the taken-over row.
  perform apply_billing_event('stripe', 'evt_takeover_2', 'payment_failed', v_client, 'seo', 'sub_paid_1');
  select * into v_ent from entitlements where client_id = v_client and feature = 'seo';
  assert v_ent.status = 'past_due', format('failed payment -> past_due, got %s', v_ent.status);
  perform apply_billing_event('stripe', 'evt_takeover_3', 'subscription_canceled', v_client, 'seo', 'sub_paid_1');
  select * into v_ent from entitlements where client_id = v_client and feature = 'seo';
  assert v_ent.status = 'canceled', format('cancel -> canceled, got %s', v_ent.status);
  assert not seo_billing_active(v_client), 'cancelled: SEO jobs stop';

  -- The trap this design avoids: cancelling a trial, then paying.
  delete from entitlements where client_id = v_client;
  insert into entitlements (client_id, feature, status, source, seat_count, canceled_at)
  values (v_client, 'seo', 'canceled', 'trial', 4, now());
  v_res := apply_billing_event('stripe', 'evt_takeover_4', 'subscription_activated', v_client, 'seo',
                               'sub_paid_2', now() + interval '1 month', '{}'::jsonb, null, 4);
  assert v_res->>'status' = 'stale_ignored',
    format('documented trap: a cancelled trial swallows the payment (got %s); never cancel the trial first', v_res);

  raise notice 'test_seo_trial_takeover: all assertions passed';
end
$$;

rollback;
