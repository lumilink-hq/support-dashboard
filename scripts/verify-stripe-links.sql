-- =============================================================================
-- verify-stripe-links.sql — is the billing side actually wired?
--
-- Companion to docs/STRIPE-TIERS-RUNBOOK.md. That document explains WHY each
-- piece exists; this one answers "is it true right now?" against the live DB.
-- Read-only. Safe to run any time, in test or live.
--
-- Run: psql "$DATABASE_URL" -f scripts/verify-stripe-links.sql
--      (or paste §A into the Supabase SQL editor)
--
-- WHY A SCRIPT AND NOT A CHECKLIST. Every failure this catches is silent by
-- construction: Stripe reports a successful payment, billing-webhook returns
-- HTTP 200, and the customer is under-provisioned or not provisioned at all.
-- Nothing throws, so nothing tells you except a query like this one.
--
-- -----------------------------------------------------------------------------
-- THE METADATA EACH PAYMENT LINK NEEDS (there is no query for this — Stripe
-- holds it, not us — so it is written here next to the checks that depend on it)
--
--   Link            metadata.feature   metadata.plan_tier
--   Starter         voice              starter
--   Growth          voice              growth
--   Scale           voice              scale
--
-- Set BOTH keys in BOTH places Stripe offers:
--   1. the Payment Link's own `metadata`      -> lands on the Checkout Session
--   2. `subscription_data.metadata`           -> lands on the Subscription and
--                                                on every later invoice
-- collectMetadata() in billing-webhook/lib.ts reads both and merges them.
--
-- Product-level metadata does NOT count. Stripe does not copy a Product's
-- metadata onto the Session or the Subscription, so `feature` set on the
-- product (as the 2026-08-12 products export shows for Starter) reaches the
-- webhook on exactly zero events.
--
-- feature   — without it apply_billing_event PARKS the event: checkout.session
--             .completed is the only event carrying client_reference_id and it
--             carries no price, so nothing else can supply the feature on the
--             one event that creates a grant. Symptom: billing_events.result =
--             'unmapped', nothing unlocked, nothing logged as an error.
-- plan_tier — same event, same reason. Without it the entitlement is created
--             with plan_tier NULL, provision-feature falls back to the ENTRY
--             allowance, and a $449 Scale customer gets 100 minutes. invoice
--             .paid corrects it hours later. The metadata makes it right the
--             first time.
-- =============================================================================


-- =============================================================================
-- §A  Pre-flight. Every row must read PASS before you publish a link.
-- =============================================================================
select ord, check_name, verdict, detail from (

  -- 1. The overload trap. apply_billing_event was DROPPED and recreated in 0031
  --    because create-or-replace with a new defaulted arg leaves TWO functions,
  --    and PostgREST then can't choose — every webhook delivery 500s.
  select 1 as ord,
         'apply_billing_event has exactly one overload (9 args)' as check_name,
         case when count(*) = 1 and max(pronargs) = 9 then 'PASS' else 'FAIL' end as verdict,
         coalesce(string_agg(pronargs::text, ' + '), 'FUNCTION MISSING') as detail
    from pg_proc where proname = 'apply_billing_event'

  union all

  -- 2. The allowances provisioning will actually apply.
  select 2,
         'plan_tiers seeded with expected minutes + $49.99 setup',
         case when count(*) = 3 and bool_and(ok) then 'PASS' else 'FAIL' end,
         coalesce(string_agg(tier || ' ' || included_minutes || 'min/$' || setup_fee_usd,
                             ', ' order by sort_order), 'NO ACTIVE TIERS')
    from (
      select tier, included_minutes, setup_fee_usd, sort_order,
             (tier, included_minutes, setup_fee_usd) in (
               ('starter', 100, 49.99),
               ('growth',  250, 49.99),
               ('scale',   600, 49.99)
             ) as ok
        from plan_tiers where is_active
    ) t

  union all

  -- 3. Both Stripe modes must be mapped. A test purchase sends TEST price ids;
  --    matching them against live rows resolves nothing and parks as 'unmapped'.
  select 3,
         'billing_price_map: 6 active plan rows (3 live + 3 test)',
         case when count(*) = 6 then 'PASS' else 'FAIL' end,
         count(*) || ' rows, tiers: ' || coalesce(string_agg(distinct plan_tier, ','), 'none')
    from billing_price_map
   where processor = 'stripe' and kind = 'plan' and is_active

  union all

  select 4,
         'each tier mapped in BOTH modes (2 prices per tier)',
         case when count(*) = 3 and bool_and(n = 2) then 'PASS' else 'FAIL' end,
         coalesce(string_agg(plan_tier || '=' || n, ', ' order by plan_tier), 'none')
    from (
      select plan_tier, count(*) as n
        from billing_price_map
       where processor = 'stripe' and kind = 'plan' and is_active
       group by plan_tier
    ) t

  union all

  -- 5. The map is also the display source for /plans and /billing. If it
  --    disagrees with plan_tiers, the page and the invoice disagree too.
  select 5,
         'mapped amounts match plan_tiers.monthly_usd',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(m.external_price_id || ' $' || m.display_amount
                             || ' <> $' || t.monthly_usd, ', '), 'all agree')
    from billing_price_map m
    join plan_tiers t on t.tier = m.plan_tier
   where m.processor = 'stripe' and m.kind = 'plan' and m.is_active
     and m.display_amount <> t.monthly_usd

  union all

  -- 6. Setup prices must NEVER be mapped. A one-time line never becomes a
  --    subscription item, so mapping one creates a price that could grant an
  --    entitlement on its own — the case parseStripeEvent explicitly refuses.
  --    Ids below are the archived $299/$499/$799 objects (fee is now $49.99).
  select 6,
         'no one-time setup price is mapped',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(external_price_id, ', '), 'none mapped (correct)')
    from billing_price_map
   where processor = 'stripe'
     and external_price_id in (
       'price_1Tyltq2LgljE9PpsOMSVu17H',  -- live Starter setup $299
       'price_1Tylvi2LgljE9PpsT4Vk1KEw',  -- live Growth  setup $499
       'price_1TylwR2LgljE9PpsweJb8JPP',  -- live Scale   setup $799
       'price_1TyfP12MNeuPGOWjN8VJqGHC'   -- test Starter setup $299
     )

  union all

  select 7,
         'every active plan price maps to feature voice',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(external_price_id || ' -> ' || coalesce(feature, 'NULL'), ', '),
                  'all voice')
    from billing_price_map
   where processor = 'stripe' and kind = 'plan' and is_active
     and feature is distinct from 'voice'

  union all

  -- 8. Empty today. When add-ons ship, a kind='addon' row without an addon_key
  --    becomes a candidate answer to "which tier did they buy?".
  select 8,
         'add-on rows carry an addon_key',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(external_price_id, ', '), 'no malformed add-on rows')
    from billing_price_map
   where processor = 'stripe' and kind = 'addon' and addon_key is null

) checks
order by ord;


-- =============================================================================
-- §B  After each test purchase (card 4242 4242 4242 4242).
--
-- Replace <CLIENT_UUID>. The cap is the check that matters — everything else
-- here passed before 0031 too, and the minutes were the thing that was wrong.
-- =============================================================================
--
-- select e.feature,
--        e.plan_tier,                                    -- NULL = the 0031 bug
--        e.status,
--        c.settings -> 'voice_caps' ->> 'monthly_minutes' as minutes,
--        c.settings -> 'voice_caps' ->> 'max_call_secs'   as max_call_secs
--   from entitlements e
--   join clients c on c.id = e.client_id
--  where e.client_id = '<CLIENT_UUID>';
--
-- Expect: plan_tier = what you bought, minutes = 100 / 250 / 600,
--         max_call_secs = 105.
--
-- select event_type, result, received_at
--   from billing_events
--  where received_at > now() - interval '1 hour'
--  order by received_at;
--
-- Expect 'applied'. 'unmapped' means the link is missing metadata.feature —
-- see the header of this file, not the price map.
--
-- If minutes came back 100 on a Growth or Scale purchase, look in this order:
--   1. entitlements.plan_tier  -> null means the link had no plan_tier metadata
--                                 (or billing-webhook wasn't redeployed)
--   2. provisioning_tasks.last_error -> an unknown tier parks as needs_human
--                                 rather than falling back, by design


-- =============================================================================
-- §C  The 0025 trap — pick a test client that can actually fail.
--
-- 0025 backfilled monthly_minutes = 200 onto every client existing at the time.
-- set_plan_tier_caps is RAISE-ONLY, so one of these buying Starter (100) stays
-- at 200 and the test passes while proving nothing. Use a client NOT in this
-- list for Starter tests, or clear voice_caps first
-- (scripts/reset-billing-test.sql §4).
-- =============================================================================

select id, slug, settings -> 'voice_caps' ->> 'monthly_minutes' as minutes
  from clients
 where (settings -> 'voice_caps' ->> 'monthly_minutes') = '200'
 order by slug;
