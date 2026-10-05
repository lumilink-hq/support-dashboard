-- =============================================================================
-- reset-billing-test.sql — wipe one client's billing state for a clean re-test.
--
-- Supabase Dashboard -> SQL Editor. Run ONE section at a time; the editor only
-- returns the last statement's result.
--
-- TEST DATA ONLY. Every statement is scoped to :client_id — set it once below
-- and never run this unscoped. billing_events is an audit trail and the
-- idempotency ledger; deleting rows for a live tenant means a re-delivered
-- event can be applied twice.
-- =============================================================================

-- The client under test.
--   55815d4c-8e17-4128-8c67-bad6f99c62d7
-- Substitute it into each section below (the SQL editor has no \set).


-- =============================================================================
-- SECTION 0 — DRY RUN. Look before deleting.
-- =============================================================================
select 'entitlements' as table_name, count(*) as rows
  from entitlements where client_id = '55815d4c-8e17-4128-8c67-bad6f99c62d7'
union all
select 'provisioning_tasks', count(*)
  from provisioning_tasks where client_id = '55815d4c-8e17-4128-8c67-bad6f99c62d7'
union all
select 'billing_events (by client)', count(*)
  from billing_events where client_id = '55815d4c-8e17-4128-8c67-bad6f99c62d7'
union all
-- The parked ones never got a client_id, so they have to be found by the
-- subscription they referenced.
select 'billing_events (unmapped, this subscription)', count(*)
  from billing_events
 where client_id is null
   and payload ->> 'subscription_ref' = 'sub_1Tz7dK2MNeuPGOWjw6cD4qS4';


-- =============================================================================
-- SECTION 1 — Provisioning queue
-- =============================================================================
-- delete from provisioning_tasks
--  where client_id = '55815d4c-8e17-4128-8c67-bad6f99c62d7';


-- =============================================================================
-- SECTION 2 — Entitlements
-- =============================================================================
-- delete from entitlements
--  where client_id = '55815d4c-8e17-4128-8c67-bad6f99c62d7';


-- =============================================================================
-- SECTION 3 — Billing events (the idempotency ledger)
--
-- ONLY NEEDED IF YOU PLAN TO *RESEND* THE SAME EVENTS FROM STRIPE. Event ids
-- are the dedupe key, so a resent event finds its row and returns 'duplicate'
-- without doing anything.
--
-- If you're making a FRESH purchase instead, skip this section — new events get
-- new ids, and keeping the old rows preserves the diagnostic trail.
-- =============================================================================
-- delete from billing_events
--  where client_id = '55815d4c-8e17-4128-8c67-bad6f99c62d7'
--     or (client_id is null
--         and payload ->> 'subscription_ref' = 'sub_1Tz7dK2MNeuPGOWjw6cD4qS4');


-- =============================================================================
-- SECTION 4 — Voice caps.  READ THIS ONE, IT CHANGES WHAT YOUR TEST PROVES.
--
-- 0025 backfilled an EXPLICIT monthly_minutes onto every client that existed at
-- the time, pinning them at the platform default (200) so the default change
-- couldn't move anyone silently.
--
-- set_plan_voice_caps() then refuses to overwrite an existing explicit cap, so
-- a manually-granted Growth or Scale allowance survives re-provisioning.
--
-- Those two behaviours combine badly for THIS test: the client already has
-- monthly_minutes = 200 from the backfill, so provisioning reports
-- 'cap_already_set' and leaves it at 200. Your Starter customer ends up with
-- double the minutes they paid for, and nothing errors.
--
-- Clearing voice_caps here makes the test actually exercise the 100-minute
-- path. It also mirrors a real NEW signup, which has no voice_caps at all.
-- =============================================================================
-- select id, name, settings -> 'voice_caps' as caps_before
--   from clients where id = '55815d4c-8e17-4128-8c67-bad6f99c62d7';

-- update clients
--    set settings = coalesce(settings, '{}'::jsonb) - 'voice_caps'
--  where id = '55815d4c-8e17-4128-8c67-bad6f99c62d7';


-- =============================================================================
-- SECTION 5 — Confirm it's clean
-- =============================================================================
-- select
--   (select count(*) from entitlements       where client_id = '55815d4c-8e17-4128-8c67-bad6f99c62d7') as entitlements,
--   (select count(*) from provisioning_tasks where client_id = '55815d4c-8e17-4128-8c67-bad6f99c62d7') as tasks,
--   (select settings -> 'voice_caps' from clients where id = '55815d4c-8e17-4128-8c67-bad6f99c62d7') as caps;
-- -- expect 0, 0, null


-- =============================================================================
-- ALSO DO THIS IN STRIPE — the database is only half the state.
-- =============================================================================
-- The test subscription sub_1Tz7dK2MNeuPGOWjw6cD4qS4 is still live in Stripe.
-- Leave it and your next purchase creates a SECOND subscription for the same
-- customer, and renewal events from both will arrive against one entitlement.
--
--   Stripe (test mode) -> Subscriptions -> cancel sub_1Tz7dK2MNeuPGOWjw6cD4qS4
--
-- Cancelling fires customer.subscription.deleted. Do it BEFORE section 2, and
-- you get a free test of the cancellation path (entitlement -> 'canceled').
-- Do it after, and the event parks as unmapped, which is harmless here.
