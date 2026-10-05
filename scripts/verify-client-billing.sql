-- =============================================================================
-- verify-client-billing.sql — did THIS store's subscription land correctly?
--
-- Supabase Dashboard -> SQL Editor. Run once per store, right after they pay.
--
-- One query, one verdict column. It exists because "the webhook returned 200"
-- and "the customer is being served correctly" are different claims, and every
-- failure so far lived in the gap between them.
-- =============================================================================


-- =============================================================================
-- BEFORE THEY BUY — fix the minute cap
-- =============================================================================
-- 0025 backfilled every pre-existing client at the old platform default of 200
-- minutes. set_plan_voice_caps refuses to overwrite an explicit cap (so a
-- manually granted Growth or Scale allowance survives re-provisioning), which
-- means a Starter purchase leaves them on 200. Double the allowance, silently:
-- we eat ~$8.50/month of vendor cost and never bill the $0.30/min overage
-- because they never cross 100.
--
-- Bud Club was at 200 as of 2026-07-31. Check both stores:
--
--   select slug, settings -> 'voice_caps' ->> 'monthly_minutes' as minutes
--     from clients where slug in ('budmember001','shopify-store');
--
-- Fix any that read 200:
--
--   update clients
--      set settings = coalesce(settings,'{}'::jsonb) || jsonb_build_object(
--            'voice_caps',
--            coalesce(settings->'voice_caps','{}'::jsonb)
--              || jsonb_build_object('monthly_minutes', 100))
--    where slug = 'budmember001';


-- =============================================================================
-- AT CHECKOUT — read the button before they press it
-- =============================================================================
-- Sign in as them, open /billing, right-click the Unlock button, copy the link.
-- It must look like:
--
--   https://buy.stripe.com/<LIVE-LINK>?client_reference_id=<their clients.id>
--
-- No client_reference_id means the payment arrives with no tenant and parks as
-- 'unmapped'. That is the single most common failure, and it is visible before
-- any money moves.


-- =============================================================================
-- AFTER THEY PAY — the whole path in one query
-- =============================================================================
-- Change the slug. Read the verdict column first.
with target as (
  select id, slug, name, phone_number, settings
    from clients
   where slug = 'budmember001'          -- <-- the store you are checking
),
ent as (
  select * from entitlements e
   where e.client_id = (select id from target) and e.feature = 'voice'
),
task as (
  select * from provisioning_tasks p
   where p.client_id = (select id from target)
   order by p.updated_at desc limit 1
),
evt as (
  select * from billing_events b
   where b.client_id = (select id from target)
   order by b.received_at desc limit 1
)
select
  t.slug,
  case
    when (select count(*) from ent) = 0
      then 'NO ENTITLEMENT: payment never routed here. Check billing_events for an unmapped row with this subscription.'
    when (select status from ent) <> 'active'
      then 'ENTITLEMENT ' || upper((select status from ent))
           || ': provisioning has not finished. See task_status/last_error.'
    when coalesce((select status from task), 'none') = 'needs_human'
      then 'PROVISIONING PARKED: ' || coalesce((select last_error from task), '')
    when (t.settings -> 'voice_caps' ->> 'monthly_minutes') is null
      then 'NO MINUTE CAP: this line can run unmetered at real vendor cost.'
    when (t.settings -> 'voice_caps' ->> 'monthly_minutes')::int <> 100
      then 'WRONG ALLOWANCE: ' || (t.settings -> 'voice_caps' ->> 'monthly_minutes')
           || ' minutes on a 100-minute plan.'
    when coalesce((t.settings -> 'voice_caps' ->> 'max_call_secs')::int,
                  (select default_max_call_secs from platform_settings where id = 1)) >= 120
      then 'CALL CEILING TOO HIGH: calls will be cut off mid-sentence by ElevenLabs.'
    when t.phone_number is null
      then 'NO PHONE NUMBER: nothing to answer on.'
    when coalesce((select (payload ->> 'livemode')::boolean from evt), false) is not true
      then 'TEST-MODE EVENT: this is not a real payment yet.'
    else 'OK — subscribed, provisioned, capped and answering'
  end                                                        as verdict,

  (select status from ent)                                   as entitlement,
  (select current_period_end from ent)                       as renews,
  (select external_subscription_ref from ent)                as stripe_subscription,
  (select status from task)                                  as task_status,
  (select last_error from task)                              as task_error,
  t.settings -> 'voice_caps' ->> 'monthly_minutes'           as minutes_cap,
  coalesce(t.settings -> 'voice_caps' ->> 'max_call_secs',
           '(platform default)')                             as max_call_secs,
  t.phone_number,
  (select event_type from evt)                               as last_event,
  (select result from evt)                                   as last_result,
  (select payload ->> 'livemode' from evt)                   as livemode
from target t;


-- =============================================================================
-- ANYTHING THAT DIDN'T ROUTE, ACROSS ALL STORES
-- =============================================================================
-- Expect zero rows. A row here is money taken with nothing granted.
select received_at, event_type, result,
       payload ->> 'client_id_source' as client_id_source,
       payload ->> 'feature_source'   as feature_source,
       payload ->> 'subscription_ref' as subscription_ref
  from billing_events
 where (payload ->> 'livemode')::boolean is true
   and result not in ('applied', 'duplicate')
   and event_type <> 'ignored'
 order by received_at desc;


-- =============================================================================
-- LAST CHECK, AND IT IS NOT SQL
-- =============================================================================
-- Call the store's number and ask about a real order. Everything above can pass
-- while the agent is answering as the wrong tenant, quoting the wrong prices, or
-- reading dates in UTC. The database says the subscription is correct; only the
-- call says the product is.
--
-- Then confirm the call metered:
--   select started_at, duration_secs, est_cost_usd from voice_usage_events
--    where client_id = (select id from clients where slug = 'budmember001')
--    order by started_at desc limit 5;
