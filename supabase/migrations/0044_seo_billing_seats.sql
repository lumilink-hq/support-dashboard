-- =============================================================================
-- 0044_seo_billing_seats.sql
-- Module 12 (plan.md): per-location seat billing for the SEO product line.
--
-- WHY THIS BUILDS ON lib/services/billing.ts, NOT billing_price_map/Payment
-- Links. plan.md's module 12 row describes seat count coming from "Payment
-- Link metadata" — the pattern voice/email used before 0041. But 0041 and
-- lib/services/billing.ts already moved that whole flow to direct Stripe
-- Checkout Session creation, with client_id/plan_tier set as metadata AT
-- CREATION time rather than resolved from a static link afterwards (see
-- app/api/webhooks/stripe/route.ts's header comment — it explicitly replaces
-- supabase/functions/billing-webhook). Building SEO's brand-new billing on
-- the pattern the codebase retired one migration ago would be adding to dead
-- weight the day after it was marked dead. This migration extends the LIVE
-- path instead: apply_billing_event + entitlements, called from
-- lib/services/billing.ts's Stripe-direct sync functions.
--
-- WHAT'S NEW, ON TOP OF 0008/0031's entitlements design:
--   1. feature_t gets a third value, 'seo'.
--   2. entitlements.seat_count — how many units (locations) the client is
--      paying for. NULL for voice/email (meaningless there — they're
--      always-quantity-1 in this codebase, see lib/addons.ts's header).
--      For 'seo' it is Stripe's own subscription-item quantity, mirrored
--      here purely for the dashboard to read without an API round trip.
--   3. apply_billing_event recreated with p_seat_count. SOURCE OF TRUTH FOR
--      SEAT COUNT IS ALWAYS STRIPE — unlike plan_tier (which is raise-only
--      via set_plan_tier_caps, because a plan grants a MINIMUM allowance),
--      a seat count is simply "how many locations are currently being paid
--      for," which Stripe's subscription item quantity defines exactly. So
--      whenever an event carries one, it OVERWRITES rather than merges —
--      there is no "customer entitled to at least N seats" concept to
--      protect here the way there is for minutes.
--
-- DROPPED FIRST, deliberately — same reason 0031 did it for the p_plan_tier
-- addition: `create or replace` with one more defaulted parameter creates a
-- SECOND function rather than replacing the first (Postgres resolves
-- overloads by full argument list), and PostgREST's .rpc() then fails with
-- "could not choose the best candidate function" on every webhook delivery.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

alter type feature_t add value if not exists 'seo';

alter table entitlements
  add column if not exists seat_count int;

do $$ begin
  alter table entitlements
    add constraint entitlements_seat_count_chk check (seat_count is null or seat_count >= 0);
exception when duplicate_object then null; end $$;

comment on column entitlements.seat_count is
  'Units of the feature the client pays for (SEO: location count). Always '
  'mirrors Stripe''s own subscription-item quantity — overwritten on every '
  'event that carries one, never raise-only. NULL for quantity-always-1 '
  'features (voice, email).';

drop function if exists apply_billing_event(
  text, text, text, uuid, feature_t, text, timestamptz, jsonb, text);

create or replace function apply_billing_event(
  p_processor          text,
  p_external_event_id  text,
  p_event_type         text,
  p_client_id          uuid,
  p_feature            feature_t,
  p_subscription_ref   text          default null,
  p_current_period_end timestamptz   default null,
  p_payload            jsonb         default '{}'::jsonb,
  p_plan_tier          text          default null,
  p_seat_count         int           default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows         int;
  v_has_existing boolean;
  v_result       text;
  v_existing     entitlements%rowtype;
  v_same_sub     boolean;
  v_tier         text;
begin
  -- 1) Idempotency: first writer wins; a re-delivered event does nothing.
  insert into billing_events (processor, external_event_id, event_type, client_id, feature, payload)
  values (p_processor, p_external_event_id, p_event_type, p_client_id, p_feature, coalesce(p_payload, '{}'::jsonb))
  on conflict (processor, external_event_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('status','duplicate','event_id',p_external_event_id);
  end if;

  -- 2) Must know who + what. If not, park for manual reconciliation.
  if p_client_id is null or p_feature is null then
    v_result := 'unmapped';
    update billing_events set result = v_result, processed_at = now()
     where processor = p_processor and external_event_id = p_external_event_id;
    return jsonb_build_object('status', v_result, 'event_id', p_external_event_id);
  end if;

  -- An unrecognised tier is dropped rather than stored (same reasoning as
  -- 0031: entitlements.plan_tier FKs to plan_tiers, so a junk value would
  -- abort the whole transaction, including the billing_events row).
  select tier into v_tier from plan_tiers where tier = p_plan_tier;

  select * into v_existing from entitlements
    where client_id = p_client_id and feature = p_feature;
  v_has_existing := found;

  v_same_sub := (
    p_subscription_ref is null
    or v_existing.external_subscription_ref is null
    or v_existing.external_subscription_ref = p_subscription_ref
  );

  -- 3) Route.
  if p_event_type in ('subscription_activated','subscription_renewed') then
    if not v_has_existing then
      -- New grant: create as 'pending' and kick off provisioning.
      insert into entitlements (client_id, feature, status, source, processor,
                                external_subscription_ref, current_period_end,
                                plan_tier, seat_count)
      values (p_client_id, p_feature, 'pending', 'checkout', p_processor,
              p_subscription_ref, p_current_period_end, v_tier, p_seat_count);
      perform enqueue_provisioning(p_client_id, p_feature);
      v_result := 'applied';

    elsif v_existing.status = 'canceled' then
      if v_same_sub then
        v_result := 'stale_ignored';
      else
        -- Genuinely new subscription after the old one was canceled — a
        -- re-purchase. The new event's own seat_count wins outright, same
        -- reasoning as the new-tier-wins branch just below: this is a fresh
        -- purchase, so carrying the dead subscription's seat count forward
        -- would misreport what's actually being paid for now.
        update entitlements
           set status = 'pending', source = 'checkout',
               processor = coalesce(processor, p_processor),
               external_subscription_ref = p_subscription_ref,
               current_period_end = p_current_period_end,
               plan_tier = coalesce(v_tier, plan_tier),
               seat_count = coalesce(p_seat_count, seat_count),
               canceled_at = null
         where id = v_existing.id;
        perform enqueue_provisioning(p_client_id, p_feature);
        v_result := 'applied';
      end if;

    elsif v_existing.status = 'active' then
      update entitlements
         set current_period_end = greatest(current_period_end, p_current_period_end),
             external_subscription_ref = coalesce(external_subscription_ref, p_subscription_ref),
             processor = coalesce(processor, p_processor),
             plan_tier = coalesce(v_tier, plan_tier),
             seat_count = coalesce(p_seat_count, seat_count)
       where id = v_existing.id;

      if v_tier is not null and v_tier is distinct from v_existing.plan_tier then
        perform enqueue_provisioning(p_client_id, p_feature);
      end if;

      v_result := 'applied';

    elsif v_existing.status = 'past_due' then
      update entitlements
         set status = 'active',
             current_period_end = greatest(current_period_end, p_current_period_end),
             external_subscription_ref = coalesce(external_subscription_ref, p_subscription_ref),
             processor = coalesce(processor, p_processor),
             plan_tier = coalesce(v_tier, plan_tier),
             seat_count = coalesce(p_seat_count, seat_count)
       where id = v_existing.id;
      v_result := 'applied';

    else -- 'pending'
      update entitlements
         set current_period_end = greatest(current_period_end, p_current_period_end),
             external_subscription_ref = coalesce(external_subscription_ref, p_subscription_ref),
             processor = coalesce(processor, p_processor),
             plan_tier = coalesce(v_tier, plan_tier),
             seat_count = coalesce(p_seat_count, seat_count)
       where id = v_existing.id;
      perform enqueue_provisioning(p_client_id, p_feature);
      v_result := 'applied';
    end if;

  elsif p_event_type = 'payment_failed' then
    update entitlements
       set status = 'past_due'
     where client_id = p_client_id and feature = p_feature
       and status in ('active','pending','past_due')
       and (p_subscription_ref is null
            or external_subscription_ref is null
            or external_subscription_ref = p_subscription_ref);
    v_result := 'applied';

  elsif p_event_type = 'subscription_canceled' then
    update entitlements
       set status = 'canceled', canceled_at = now()
     where client_id = p_client_id and feature = p_feature
       and status <> 'canceled'
       and (p_subscription_ref is null
            or external_subscription_ref is null
            or external_subscription_ref = p_subscription_ref);
    v_result := 'applied';

  else
    v_result := 'ignored';
  end if;

  update billing_events
     set result = v_result, processed_at = now()
   where processor = p_processor and external_event_id = p_external_event_id;

  return jsonb_build_object('status', v_result, 'client_id', p_client_id,
                            'feature', p_feature, 'plan_tier', v_tier,
                            'seat_count', p_seat_count);
end;
$$;

-- Verify (expect the SAME function every other apply_billing_event caller
-- already relies on, now with one more param — exactly one row, 10 args):
--   select pronargs, pg_get_function_identity_arguments(oid)
--     from pg_proc where proname = 'apply_billing_event';

-- End of 0044.
