-- =============================================================================
-- 0011_billing_event_ordering.sql
-- Hardens apply_billing_event (0008) against out-of-order / re-delivered
-- processor events. Create-or-replace, so this migration simply redefines the
-- function; no data change.
--
-- Bugs this closes (payment processors deliver events out of order and retry):
--   1. A trailing subscription_activated|renewed AFTER a cancel used to hit the
--      "was canceled → move to pending + re-provision" path, RESURRECTING a dead
--      plan and re-running provisioning. For voice that BUYS A TWILIO NUMBER —
--      real money for a canceled plan. Now: a stale event for the SAME
--      subscription is ignored ('stale_ignored'); only a genuinely NEW
--      subscription ref re-grants.
--   2. Recovery from past_due (payment retried and succeeded) used the same
--      pending+re-provision path, risking a SECOND provisioning of an
--      already-live feature. Now: past_due → active with NO re-provision.
--   3. Period end could move BACKWARDS on an out-of-order older renewal. Now the
--      period is monotonic (greatest()).
--   4. A late cancel of an OLD subscription could kill a freshly re-subscribed
--      plan. Now cancel/payment_failed only apply when the event concerns the
--      subscription we currently track.
-- =============================================================================

create or replace function apply_billing_event(
  p_processor          text,
  p_external_event_id  text,
  p_event_type         text,
  p_client_id          uuid,
  p_feature            feature_t,
  p_subscription_ref   text          default null,
  p_current_period_end timestamptz   default null,
  p_payload            jsonb         default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_new   boolean;
  v_result   text;
  v_existing entitlements%rowtype;
  v_same_sub boolean;
begin
  -- 1) Idempotency: first writer wins; a re-delivered event does nothing.
  insert into billing_events (processor, external_event_id, event_type, client_id, feature, payload)
  values (p_processor, p_external_event_id, p_event_type, p_client_id, p_feature, coalesce(p_payload, '{}'::jsonb))
  on conflict (processor, external_event_id) do nothing;
  get diagnostics v_is_new = row_count;
  if v_is_new = 0 then
    return jsonb_build_object('status','duplicate','event_id',p_external_event_id);
  end if;

  -- 2) Must know who + what. If not, park for manual reconciliation.
  if p_client_id is null or p_feature is null then
    v_result := 'unmapped';
    update billing_events set result = v_result, processed_at = now()
     where processor = p_processor and external_event_id = p_external_event_id;
    return jsonb_build_object('status', v_result, 'event_id', p_external_event_id);
  end if;

  select * into v_existing from entitlements
    where client_id = p_client_id and feature = p_feature;

  -- Does this event concern the SAME subscription we already track? Used to tell a
  -- stale/out-of-order event for an old sub from a genuine new signup. When we have
  -- no ref on either side we can't distinguish, so we treat it as the same.
  v_same_sub := (
    p_subscription_ref is null
    or v_existing.external_subscription_ref is null
    or v_existing.external_subscription_ref = p_subscription_ref
  );

  -- 3) Route.
  if p_event_type in ('subscription_activated','subscription_renewed') then
    if not found then
      -- New grant: create as 'pending' and kick off provisioning.
      insert into entitlements (client_id, feature, status, source, processor,
                                external_subscription_ref, current_period_end)
      values (p_client_id, p_feature, 'pending', 'checkout', p_processor,
              p_subscription_ref, p_current_period_end);
      perform enqueue_provisioning(p_client_id, p_feature);
      v_result := 'applied';

    elsif v_existing.status = 'canceled' then
      if v_same_sub then
        -- Stale/out-of-order activate|renew for the sub we already canceled (e.g.
        -- a trailing invoice.paid after the cancel). Do NOT resurrect or
        -- re-provision — that would re-buy infra for a dead plan.
        v_result := 'stale_ignored';
      else
        -- Genuinely NEW subscription after the old one was canceled → re-grant.
        update entitlements
           set status = 'pending', source = 'checkout',
               processor = coalesce(processor, p_processor),
               external_subscription_ref = p_subscription_ref,
               current_period_end = p_current_period_end,
               canceled_at = null
         where id = v_existing.id;
        perform enqueue_provisioning(p_client_id, p_feature);
        v_result := 'applied';
      end if;

    elsif v_existing.status = 'active' then
      -- Renewal of a live feature: extend the period (monotonic — never shorten on
      -- an out-of-order older event). No re-provision.
      update entitlements
         set current_period_end = greatest(current_period_end, p_current_period_end),
             external_subscription_ref = coalesce(external_subscription_ref, p_subscription_ref),
             processor = coalesce(processor, p_processor)
       where id = v_existing.id;
      v_result := 'applied';

    elsif v_existing.status = 'past_due' then
      -- Payment recovered on an already-provisioned feature → back to active
      -- WITHOUT re-provisioning (the infra already exists).
      update entitlements
         set status = 'active',
             current_period_end = greatest(current_period_end, p_current_period_end),
             external_subscription_ref = coalesce(external_subscription_ref, p_subscription_ref),
             processor = coalesce(processor, p_processor)
       where id = v_existing.id;
      v_result := 'applied';

    else
      -- status = 'pending': still provisioning. Update linkage/period and make sure
      -- a provisioning task exists (enqueue is a no-op if one is already open).
      update entitlements
         set current_period_end = greatest(current_period_end, p_current_period_end),
             external_subscription_ref = coalesce(external_subscription_ref, p_subscription_ref),
             processor = coalesce(processor, p_processor)
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
    -- Only cancel the sub we track — a late cancel of an OLD sub must not kill a
    -- freshly re-subscribed plan.
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

  return jsonb_build_object('status', v_result, 'client_id', p_client_id, 'feature', p_feature);
end;
$$;

-- End of 0011.
