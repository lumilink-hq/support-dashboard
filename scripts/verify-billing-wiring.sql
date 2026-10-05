-- =============================================================================
-- verify-billing-wiring.sql — did those HTTP 200s actually grant anything?
--
-- HOW TO RUN (no psql needed):
--   Supabase Dashboard -> SQL Editor -> paste ONE section at a time -> Run.
--   The editor shows the result of the LAST statement, so pasting the whole
--   file only returns section 7. Run them individually.
--
--   (`npx psql` does NOT work: there is an unrelated npm package called `psql`
--   that npx will happily download instead of the PostgreSQL client.)
--
-- WHY THIS EXISTS. billing-webhook returns 200 for 'unmapped' and 'ignored' on
-- purpose: those are configuration gaps, and making Stripe retry them forever
-- would bury the real signal. So an all-green webhook log is entirely
-- consistent with nothing having been granted. The HTTP status says the request
-- was handled; only billing_events.result says what it did.
--
-- Run after a test-mode purchase, and again after the first live one.
-- =============================================================================


-- =============================================================================
-- SECTION 0 — START HERE. One query, answers "why is it unmapped?"
-- =============================================================================
-- Read the verdict column.
--
-- NOTE: the _source fields only exist on events received AFTER the diagnostics
-- change. Older rows show "(no diagnostics — resend this event from Stripe)".
select
  b.received_at,
  b.event_type,
  b.result,
  case
    when b.payload = '{}'::jsonb
      then '(no diagnostics — redeploy, then resend this event from Stripe)'
    when b.result = 'applied'
      then 'OK — granted'
    when b.payload ->> 'client_id_source' = 'none'
     and b.payload ->> 'feature_source'   = 'none'
      then 'NO TENANT + NO FEATURE: anonymous Payment Link purchase and no feature metadata. Set metadata feature=voice on the link, and buy via /billing (or append ?client_reference_id=<clients.id>).'
    when b.payload ->> 'client_id_source' = 'none'
      then 'NO TENANT: buyer was anonymous. The link was opened directly, so Stripe sent no client_reference_id. Buy from /billing while signed in, or append ?client_reference_id=<clients.id> to the link.'
    when b.payload ->> 'feature_source' = 'none'
      then 'NO FEATURE: no metadata.feature on the link AND price_id_received is not in billing_price_map. Check test-vs-live price ids (section 6).'
    else 'routed fine — look at result/status instead'
  end                                   as verdict,
  b.client_id,
  b.feature,
  b.payload ->> 'client_id_source'      as client_id_source,
  b.payload ->> 'feature_source'        as feature_source,
  b.payload ->> 'external_price_id'     as price_id_received,
  b.payload ->> 'subscription_ref'      as subscription_ref
from billing_events b
order by b.received_at desc
limit 20;


-- =============================================================================
-- SECTION 1 — What did each event do?
-- Want: subscription_activated -> applied.
-- =============================================================================
-- select received_at, event_type,
--        coalesce(result, '(null — function errored before finishing)') as result,
--        client_id, feature, processor
--   from billing_events
--  order by received_at desc
--  limit 20;


-- =============================================================================
-- SECTION 2 — LIVE payments that failed to route. Expect 0 rows.
--
-- Scoped to livemode. billing_events accumulates every test purchase, resend
-- and cancellation forever, so an unscoped version fills with test-era noise
-- and stops being a usable alarm.
--
-- TWO THINGS THAT LOOK LIKE FAILURES AND AREN'T:
--
--  * RESENT EVENTS REPLAY THE ORIGINAL PAYLOAD. An event created before you
--    added client_reference_id (or link metadata) will never have it, however
--    many times you resend. Resending cannot fix a payload problem — only a
--    fresh purchase can.
--
--  * A CANCELLATION FOR A DELETED ENTITLEMENT parks by design.
--    resolveBySubscription looks the tenant up via
--    entitlements.external_subscription_ref, so if the entitlement was wiped
--    (e.g. by reset-billing-test.sql) there is nothing left to match.
-- =============================================================================
-- select received_at, event_type, client_id, feature, external_event_id,
--        payload ->> 'client_id_source' as client_id_source,
--        payload ->> 'feature_source'   as feature_source
--   from billing_events
--  where (payload ->> 'livemode')::boolean is true
--    and result is distinct from 'applied'
--    and result is distinct from 'duplicate'
--    and event_type <> 'ignored'
--  order by received_at desc;


-- =============================================================================
-- SECTION 2b — Test vs live at a glance.
-- Rows with livemode null predate the diagnostics change.
-- =============================================================================
-- select coalesce(payload ->> 'livemode', '(unknown — pre-diagnostics)') as livemode,
--        result, count(*) as events, max(received_at) as latest
--   from billing_events
--  group by 1, 2
--  order by 1 desc, 3 desc;


-- =============================================================================
-- SECTION 3 — Entitlements.
-- Want: one voice row, status active. 'pending' = provisioning still running.
-- =============================================================================
-- select e.client_id, c.name as client, e.feature, e.status, e.processor,
--        e.external_subscription_ref, e.current_period_end, e.activated_at
--   from entitlements e
--   left join clients c on c.id = e.client_id
--  order by e.activated_at desc nulls last;


-- =============================================================================
-- SECTION 4 — Provisioning queue. 'needs_human' means it stopped; read last_error.
-- =============================================================================
-- select client_id, feature, status, attempts, last_error, updated_at
--   from provisioning_tasks
--  order by updated_at desc
--  limit 10;


-- =============================================================================
-- SECTION 5 — THE MONEY CHECK: is the paying client actually capped?
-- monthly_minutes must be 100, max_call_secs 105. A null or larger
-- monthly_minutes means a $179 client can run unmetered minutes at real
-- ElevenLabs + Twilio cost.
-- =============================================================================
-- select c.id, c.name,
--        c.settings -> 'voice_caps' ->> 'monthly_minutes' as monthly_minutes,
--        c.settings -> 'voice_caps' ->> 'max_call_secs'   as max_call_secs,
--        c.phone_number
--   from clients c
--   join entitlements e on e.client_id = c.id and e.feature = 'voice'
--  order by c.name;


-- =============================================================================
-- SECTION 6 — Price map vs the price Stripe actually sent.
-- Every external_price_id must start with price_ (not prod_).
-- TEST-MODE AND LIVE-MODE PRICE IDS ARE DIFFERENT OBJECTS. A live purchase
-- matched against test-mode rows resolves no feature and parks as unmapped.
-- =============================================================================
-- select processor, external_price_id, feature, display_amount, is_active
--   from billing_price_map
--  order by display_amount;


-- =============================================================================
-- SECTION 7 — Platform defaults (0025).
-- Want: default_monthly_minutes 100, default_max_call_secs 105, voice_enabled true.
-- =============================================================================
-- select voice_enabled, default_monthly_minutes, default_max_call_secs, plan_minutes
--   from platform_settings
--  where id = 1;


-- =============================================================================
-- Finding a client_id to append to a Payment Link for a routed test:
-- =============================================================================
-- select id, name, slug from clients order by name;
--
-- Then open:  <payment link>?client_reference_id=<that id>
