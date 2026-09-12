-- =============================================================================
-- 0040_addon_billing_events.sql
-- Let the Stripe webhook write client_addons (0039) automatically, instead of
-- every grant being a hand-run SQL script like budclub_website_chat_addon.
--
-- WHY THIS IS SEPARATE FROM apply_billing_event, not a branch inside it.
--
--   * DIFFERENT CARDINALITY. One event names exactly one plan (0031's
--     "highest wins" tie-break exists because a tie is even possible), but can
--     name SEVERAL add-ons at once — a customer can pick multiple optional
--     items at checkout. This function is called once per resolved addon_key,
--     from a loop in billing-webhook/index.ts.
--
--   * DIFFERENT IDEMPOTENCY. apply_billing_event's first move is inserting
--     into billing_events, unique on (processor, external_event_id) — ONE row
--     per event. Calling that insert again per add-on on the same event would
--     hit the conflict and report every add-on after the first as 'duplicate',
--     even on the very first delivery. This function carries NO ledger insert
--     at all and instead relies on every branch being idempotent under
--     redelivery on its own (see each branch below) — safe because, unlike
--     apply_billing_event, nothing here enqueues a side-effecting job.
--
--   * NO PROVISIONING QUEUE. Every add-on today is manualFulfilment: true
--     (lib/addons.ts) — nothing automatically stands up a second phone line or
--     a managed integration. So there is no enqueue_provisioning() call here;
--     a paid add-on lands as 'pending' ("Setting up your plan…" on /billing,
--     same UI state entitlements already uses) until an operator flips it to
--     'active' by hand once fulfilled. That flip is a plain UPDATE — no RPC
--     needed for it, matching client_addons having no automated activator.
--
-- CLIENT RESOLUTION IS THE HARD PART, handled in index.ts, not here — worth
-- recording why. Each add-on has its OWN Payment Link (lib/addons.ts), and a
-- separate Payment Link checkout creates its own Checkout Session; Stripe does
-- not merge it into an existing subscription. So an add-on bought via
-- /billing's "Add To Plan" may ride a DIFFERENT subscription than the plan's —
-- entitlements.external_subscription_ref (what resolveBySubscription in
-- index.ts already checks) won't find it. The fix is symmetric with how
-- planTier resolution already works: the add-on's Payment Link must carry
-- `addon_key` metadata (mirrors `plan_tier`), which Stripe copies onto the
-- Checkout Session — so checkout.session.completed alone carries BOTH who
-- (client_reference_id) and what (addon_key metadata), with no dependency on
-- which subscription it ends up on. Renewals/cancellations of that same
-- add-on-only subscription are then resolved by matching
-- client_addons.external_subscription_ref, stored from that first event —
-- see resolveAddonClientBySubscription in index.ts.
--
-- REQUIRES, IN STRIPE (not code): every add-on's Payment Link needs
-- `addon_key` metadata set to its lib/addons.ts key (e.g. `website_chat`,
-- `additional_phone_line`) — the same way each plan's Payment Link already
-- carries `plan_tier`. Without it, the FIRST purchase of a new add-on has a
-- known client but no known addon_key and is silently dropped (see
-- resolveAddonKeys in index.ts) until the metadata is added.
-- =============================================================================

create or replace function apply_addon_billing_event(
  p_client_id          uuid,
  p_addon_key          text,          -- null ONLY for subscription_canceled
  p_event_type         text,
  p_subscription_ref   text          default null,
  p_current_period_end timestamptz   default null,
  p_processor          text          default 'stripe'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing     client_addons%rowtype;
  v_has_existing boolean;
  v_same_sub     boolean;
  v_result       text;
begin
  if p_client_id is null then
    return jsonb_build_object('status', 'unmapped');
  end if;

  -- Cancellation kills every add-on riding this subscription, known key or
  -- not — mirrors entitlements' own cancel-by-subscription, and matters
  -- because a customer.subscription.deleted payload isn't guaranteed to
  -- still carry line items by the time it's parsed.
  if p_event_type = 'subscription_canceled' then
    update client_addons
       set status = 'canceled', canceled_at = now()
     where client_id = p_client_id
       and status <> 'canceled'
       and (p_subscription_ref is null
            or external_subscription_ref is null
            or external_subscription_ref = p_subscription_ref)
       and (p_addon_key is null or addon_key = p_addon_key);
    return jsonb_build_object('status', 'applied', 'client_id', p_client_id);
  end if;

  if p_addon_key is null then
    return jsonb_build_object('status', 'ignored', 'reason', 'no_addon_key');
  end if;

  select * into v_existing from client_addons
    where client_id = p_client_id and addon_key = p_addon_key;
  v_has_existing := found;

  -- Same reasoning as apply_billing_event's v_same_sub: tell a stale event for
  -- an old subscription apart from a genuine re-purchase after a cancel. With
  -- no ref on either side we can't distinguish, so treat it as the same.
  v_same_sub := (
    p_subscription_ref is null
    or v_existing.external_subscription_ref is null
    or v_existing.external_subscription_ref = p_subscription_ref
  );

  if p_event_type in ('subscription_activated', 'subscription_renewed') then
    if not v_has_existing then
      -- New grant. 'pending', not 'active' — nothing provisions an add-on
      -- automatically, so the honest state is "paid, not yet set up" until an
      -- operator does the manual fulfilment and flips it by hand.
      insert into client_addons (client_id, addon_key, status, source, processor,
                                  external_subscription_ref, current_period_end)
      values (p_client_id, p_addon_key, 'pending', 'checkout', p_processor,
              p_subscription_ref, p_current_period_end);
      v_result := 'applied';

    elsif v_existing.status = 'canceled' then
      if v_same_sub then
        -- Stale/out-of-order event for the subscription we already canceled.
        -- Do not resurrect it.
        v_result := 'stale_ignored';
      else
        -- Genuinely new subscription after the old one was canceled — a
        -- re-purchase. Back to pending for a fresh manual fulfilment pass.
        update client_addons
           set status = 'pending', source = 'checkout',
               processor = coalesce(processor, p_processor),
               external_subscription_ref = p_subscription_ref,
               current_period_end = p_current_period_end,
               canceled_at = null
         where id = v_existing.id;
        v_result := 'applied';
      end if;

    elsif v_existing.status = 'active' then
      -- Renewal of a live add-on: extend the period, monotonically (never
      -- shorten on an out-of-order older event). No status change.
      update client_addons
         set current_period_end = greatest(current_period_end, p_current_period_end),
             external_subscription_ref = coalesce(external_subscription_ref, p_subscription_ref),
             processor = coalesce(processor, p_processor)
       where id = v_existing.id;
      v_result := 'applied';

    elsif v_existing.status = 'past_due' then
      -- Payment recovered — back to active. Nothing to re-provision (there
      -- never was automated provisioning to begin with).
      update client_addons
         set status = 'active',
             current_period_end = greatest(current_period_end, p_current_period_end),
             external_subscription_ref = coalesce(external_subscription_ref, p_subscription_ref),
             processor = coalesce(processor, p_processor)
       where id = v_existing.id;
      v_result := 'applied';

    else -- 'pending' — still awaiting manual fulfilment.
      update client_addons
         set current_period_end = greatest(current_period_end, p_current_period_end),
             external_subscription_ref = coalesce(external_subscription_ref, p_subscription_ref),
             processor = coalesce(processor, p_processor)
       where id = v_existing.id;
      v_result := 'applied';
    end if;

  elsif p_event_type = 'payment_failed' then
    update client_addons
       set status = 'past_due'
     where client_id = p_client_id and addon_key = p_addon_key
       and status in ('active', 'pending', 'past_due')
       and (p_subscription_ref is null
            or external_subscription_ref is null
            or external_subscription_ref = p_subscription_ref);
    v_result := 'applied';

  else
    v_result := 'ignored';
  end if;

  return jsonb_build_object('status', v_result, 'client_id', p_client_id, 'addon_key', p_addon_key);
end;
$$;

revoke execute on function apply_addon_billing_event(uuid, text, text, text, timestamptz, text)
  from public, authenticated;
grant execute on function apply_addon_billing_event(uuid, text, text, text, timestamptz, text)
  to service_role;

-- Verify, after a real add-on purchase flows through:
--   select client_id, addon_key, status, source, external_subscription_ref, current_period_end
--     from client_addons
--    order by created_at desc;
