-- =============================================================================
-- 0026_fix_apply_billing_event_rowcount.sql
-- Fixes a type error that made apply_billing_event throw on EVERY call.
--
-- THE BUG (introduced in 0008, copied verbatim into 0011):
--
--     declare v_is_new boolean;          -- declared boolean
--     ...
--     get diagnostics v_is_new = row_count;   -- assigned an integer
--     if v_is_new = 0 then                    -- compared to an integer
--
--   Postgres raises: operator does not exist: boolean = integer
--
--   Every webhook delivery got a 500 and the transaction aborted, so nothing
--   was written — no entitlement, and not even a billing_events row, because
--   the insert on the line above rolled back with it.
--
-- WHY IT STAYED HIDDEN. plpgsql only resolves operators when a line actually
-- executes, so a function that is never called with a real event is never
-- type-checked past parsing. This function had no caller until Stripe was
-- wired up: 0008 shipped it, 0011 hardened it, and both carried the same
-- defect for the entire time the pipeline sat waiting for a processor.
--
-- Every other `get diagnostics` in this schema (0018, 0024, 0025) correctly
-- declares an int. This one function was the outlier, in both copies.
--
-- ALSO HARDENED HERE: `found` is now captured into a variable the moment the
-- SELECT runs, instead of being read ten lines later. Reading it at a distance
-- is correct today — plain assignments don't touch `found` — but it is exactly
-- the kind of assumption that breaks silently when someone inserts a PERFORM
-- or another query in between, and the failure would be a wrongly re-granted
-- entitlement rather than an error.
--
-- Behaviour is otherwise IDENTICAL to 0011. Nothing about the ordering,
-- idempotency or state-machine semantics changes.
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
  v_rows         int;      -- was `v_is_new boolean` — the bug
  v_has_existing boolean;  -- `found`, captured at the point of the SELECT
  v_result       text;
  v_existing     entitlements%rowtype;
  v_same_sub     boolean;
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

  select * into v_existing from entitlements
    where client_id = p_client_id and feature = p_feature;
  v_has_existing := found;

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
    if not v_has_existing then
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

-- Smoke test the fixed path without a processor. Both calls should RETURN a
-- jsonb status rather than raising; the second must say 'duplicate'.
--
--   select apply_billing_event('generic','evt_smoke_0026','subscription_activated',
--                              null, null);   -- expect {"status":"unmapped",...}
--   select apply_billing_event('generic','evt_smoke_0026','subscription_activated',
--                              null, null);   -- expect {"status":"duplicate",...}
--   delete from billing_events where external_event_id = 'evt_smoke_0026';

-- End of 0026.
