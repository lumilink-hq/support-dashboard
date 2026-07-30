-- =============================================================================
-- budclub_config.sql — configure the Bud Club (budmember001) client.
--
-- Run top to bottom. Every value that is a JUDGEMENT rather than a fact is in
-- its own numbered block with the alternative written out next to it, so it can
-- be flipped from the dashboard later without re-reading this file.
--
-- Sources, all read from the live site on 2026-07-30:
--   https://budclub.com/refund-cancellation-delivery-policy/  ← authoritative
--       ("Last updated: July 3, 2025"; linked from every footer)
--   https://budclub.com/contact/
--   the homepage FAQ accordion
--   https://budclub.com/wp-json/wc/store/v1/products          ← public, no key
--
-- NOT a migration. Per-client data, so it lives in seed/ and is run by hand
-- against whichever environment you mean to configure. Safe to re-run.
-- =============================================================================


-- #############################################################################
-- SECTION 0 — THE THREE CONTRADICTIONS ON THE LIVE SITE
--
-- These are not ambiguities in our data; they are places where budclub.com says
-- two different things about itself. The agent will state whichever it is given
-- with complete confidence, so each one is DECIDED below rather than averaged.
-- The decision taken is marked ✅. Flipping any of them is a one-line update.
-- #############################################################################
--
-- (a) REFUNDS — the expensive one.
--     Policy page:  "All sales are final… does not offer refunds or exchanges
--                    once an order has been processed and fulfilled."
--     Homepage FAQ: "If you decide you don't like it for any other reason, ship
--                    it back and we will offer you a credit or replacement."
--     Those are opposites, and a caller who read the homepage will quote the FAQ
--     back at the agent.
--     ✅ DECIDED: follow the POLICY PAGE (dated, legally framed, footer-linked).
--        Section 5 below encodes "all sales final, replacement only for damaged
--        or wrong items within 7 days".
--     ↳ Also note: that same FAQ answer says "the Bay Smokes family" — copy from
--       a DIFFERENT BRAND left in the page. The agent would repeat it verbatim.
--       Worth telling the client regardless of which way they resolve (a).
--
-- (b) FREE SHIPPING THRESHOLD.
--     Homepage banner: "FREE SHIPPING ON $100+ ORDERS"
--     Policy page:     free shipping "available for orders over $75"
--     ✅ DECIDED: state NEITHER. The blob explicitly forbids quoting a
--        threshold. Quoting the wrong one costs a real order or a real refund.
--        Once the client confirms, replace that final sentence with the number.
--
-- (c) LEGAL ENTITY / ADDRESS.
--     Desktop footer: "TP Touch Down Solutions LLC, 4030 Wake Forest Road,
--                      Raleigh, NC 27609"
--     Mobile footer:  "BudClub LLC, a North Carolina LLC, 5540 Centerview Dr
--                      Ste 204 #286972, Raleigh, NC 27606"
--     Contact page:   "BUD CLUB , LLC"
--     ✅ DECIDED: not in the blob at all. It is not a support answer, and an
--        agent naming the wrong legal entity in a billing dispute is worse than
--        one that offers to have someone follow up.


-- #############################################################################
-- SECTION 0.5 — PREFLIGHT: fail loudly if the slug is wrong
--
-- Every statement below is `update clients … where slug = 'budmember001'`. If
-- that slug does not exist, each one quietly updates ZERO rows and the whole
-- file "succeeds" while configuring nothing — and the first sign would be a
-- voice call answering "this line isn't configured for a store".
--
-- This is not hypothetical here: a snapshot of this row taken earlier showed the
-- slug as `budmember001-2`, so the two names are genuinely in circulation.
-- Raising an exception costs nothing and turns a silent no-op into an obvious
-- error, so run the whole file inside a transaction if you can.
-- #############################################################################

do $$
declare
  v_id   uuid;
  v_near text;
begin
  select id into v_id from clients where slug = 'budmember001';
  if v_id is null then
    select string_agg(slug, ', ' order by slug) into v_near
      from clients
     where slug ilike 'bud%' or name ilike '%bud%';
    raise exception
      'No client with slug "budmember001". Nothing was configured. Similar slugs: %',
      coalesce(v_near, '(none found)');
  end if;
  raise notice 'Configuring client % (budmember001)', v_id;
end;
$$;


-- #############################################################################
-- SECTION 1 — Core store wiring (facts, not judgements)
-- #############################################################################
--
-- No REST key needed to start: budclub.com serves the public WooCommerce Store
-- API at /wp-json/wc/store/v1/products, so product-sync populates the catalog
-- from that today. Adding store_credentials_ref later gains exact stock counts
-- and per-variant prices — product ids are identical between the two APIs, so
-- the switch UPDATES rows rather than duplicating them.

update clients
   set store_platform = 'woocommerce',
       store_base_url = 'https://budclub.com',
       support_email  = 'hey@budclub.com'
 where slug = 'budmember001';

-- Phone: NONE EXISTS on the site — support is email-only (hey@budclub.com plus a
-- contact form). There was never a number to find. Once Twilio provisioning
-- lands, set it here in E.164 and nowhere else:
--
--   update clients set phone_number = '+1XXXXXXXXXX' where slug = 'budmember001';
--
-- ⚠️ uq_clients_phone_digits has NO is_active filter, so a deactivated client
--    still holds its number. If this update fails on a unique violation, null
--    the old holder's phone_number first.


-- #############################################################################
-- SECTION 2 — Order numbers  ⚠️ THE ONE THING TO VERIFY IN WP ADMIN
-- #############################################################################
--
-- Bud Club orders are "#" + 6 digits (e.g. #123456).
--
-- NO order_number_prefix is needed. normalizeOrderNumber() already strips a
-- leading "#"; a prefix is only for order NAMES containing letters, like
-- Tsunami's "TSU#1749".
--
-- THE SCHEME IS SET TO 'id' BELOW, AND HERE IS THE REASONING — check it rather
-- than trust it. WooCommerce order numbers default to the WordPress post id,
-- and this site's post-id space is already six digits: the public Store API
-- returned product id 87142. Orders share that same wp_posts sequence, so a
-- 6-digit order number is exactly what a raw post id looks like on this store.
-- That makes 'id' the likely-correct answer, not a guess in the dark.
--
-- ✅ VERIFY IT ANYWAY, it takes thirty seconds:
--      WP Admin → WooCommerce → Orders → open any recent order.
--      Compare the number shown in the list ("#123456") with `post=123456` in
--      the browser's address bar.
--        • SAME    → leave this as-is. Nothing to run.
--        • DIFFERENT → a sequential-order-number plugin is installed. Run:
--            update clients
--               set settings = settings || jsonb_build_object(
--                     'order_number_scheme', 'search')
--             where slug = 'budmember001';
--          or, if the plugin's docs name a postmeta key, prefer the exact form:
--                     'order_number_scheme', 'meta:_order_number'
--
-- Getting this wrong is loud, not silent: EVERY voice lookup 404s while the
-- same order resolves fine over email. If that is the symptom, this is the
-- cause.

update clients
   set settings = coalesce(settings, '{}'::jsonb)
                  || jsonb_build_object('order_number_scheme', 'id')
 where slug = 'budmember001';


-- #############################################################################
-- SECTION 3 — Flag rules (judgement: the staleness window)
-- #############################################################################
--
-- Woo's lowercase statuses are mapped into the shared uppercase token set by
-- normalizeWooStatus(), so these rules are written in that vocabulary. Writing
-- them as 'processing'/'on-hold' would silently never match anything.
--
-- ✅ DECIDED: stale_after_hours = 96, not the usual 24.
--    Bud Club fulfils Monday–Friday only ("As a family-owned business, our team
--    fulfills orders Monday through Friday"). At 24h, every order placed on a
--    Friday evening escalates to a human on Saturday morning having done nothing
--    wrong. 96h clears a normal weekend plus a federal holiday.
--    Tighten to 48 once weekend fulfilment starts, which the site says they are
--    "actively working towards".
--
-- FULFILLED and REFUNDED stop the clock entirely — a shipped order is not "late"
-- no matter how old it is. Without this exemption nearly every WISMO call
-- escalates, which is the single highest-impact misconfiguration here.

update clients
   set abnormal_status_rules = jsonb_build_object(
         'abnormal_statuses',     jsonb_build_array('ON_HOLD', 'VOIDED'),
         'stale_after_hours',     96,
         'stale_exempt_statuses', jsonb_build_array('FULFILLED', 'REFUNDED')
       )
 where slug = 'budmember001';


-- #############################################################################
-- SECTION 4 — Business hours
-- #############################################################################
--
-- Fulfilment is Mon–Fri; the business is in Raleigh, NC. These hours drive
-- whether the agent offers a warm transfer or a callback, so they describe when
-- a HUMAN is reachable, not when the website takes orders (always).

update clients
   set business_hours = jsonb_build_object(
         'tz',  'America/New_York',
         'mon', jsonb_build_array('09:00', '17:00'),
         'tue', jsonb_build_array('09:00', '17:00'),
         'wed', jsonb_build_array('09:00', '17:00'),
         'thu', jsonb_build_array('09:00', '17:00'),
         'fri', jsonb_build_array('09:00', '17:00'),
         'sat', jsonb_build_array(),
         'sun', jsonb_build_array()
       )
 where slug = 'budmember001';


-- #############################################################################
-- SECTION 5 — Settings + the condensed policy blob
-- #############################################################################
--
-- The blob is DECISION RULES, not prose — what the agent must DO. It is re-sent
-- on every conversation turn, so length is latency; this is ~290 words, which is
-- about the ceiling before it starts costing noticeable response time.
--
-- Everything in it is answerable WITHOUT a lookup. Anything that needs the
-- caller's order is the lookup tool's job, not this text's.
--
-- Resolutions from Section 0 are marked inline so they are findable later.

update clients
   set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(

     -- ⚠️ REQUIRED, and easy to miss. voice-personalization DEFAULTS TO
     -- 'scheduling', which returns a full conversation_config_override carrying
     -- the HVAC booking prompt. Sent to the shared ORDERS agent, that override
     -- REPLACES its prompt — so Bud Club would answer the phone as a heating
     -- engineer. 'orders' makes personalization return dynamic variables ONLY
     -- and leave the agent's own prompt alone.
     'voice_agent_mode',              'orders',

     -- The slug is public (it sits in page HTML), so it is an identifier, never
     -- a credential. This opt-in plus the email/ZIP verification gate is what
     -- makes web lookups safe.
     'web_lookup_enabled',            true,

     -- State stock regardless of snapshot age (0021). Safe only because 0023
     -- keeps the sync running; watch product_sync_health.
     'stock_policy',                  'always',
     'product_cache_max_age_minutes', 120,
     'product_sync_interval_minutes', 120,

     -- Bud Club's tags are not prefixed the way Tsunami's are, so 0020's
     -- tag-prefix type derivation finds nothing and product_type falls back to
     -- the category. Left at the default rather than removed, so a future
     -- retagging picks it up automatically.
     'product_type_tag_prefix',       'format-',

     'policies', concat(
       -- (a) RESOLVED IN FAVOUR OF THE POLICY PAGE.
       'REFUNDS: All sales are final. No refunds or exchanges once an order is processed and fulfilled. ',
       'DAMAGED OR WRONG ITEM: the customer must report it within 7 days of delivery through ',
       'budclub.com/contact, with a description and photos. If approved we send a replacement — a ',
       'replacement, not a refund, and subject to stock. Never promise a refund; never promise approval. ',
       'CANCELLATIONS: possible only before an order is processed or shipped. Once fulfilled or shipped ',
       'it cannot be cancelled or changed. Send cancellation requests to budclub.com/contact immediately ',
       'and do not imply it will succeed. ',
       'SHIPPING: orders are fulfilled Monday to Friday, never weekends or federal holidays; an order ',
       'placed outside those hours is typically fulfilled the next business day. Standard USPS delivery ',
       'is 2 to 5 days in the continental US. Tracking is emailed once the order is packed and can take ',
       'a business day to start updating — USPS miscans and late-afternoon handoffs commonly delay the ',
       'first scan. NEVER give a guaranteed delivery date. ',
       'WRONG ADDRESS: the address given at checkout is the customer''s responsibility. A package returned ',
       'for a bad address costs extra to resend. ',
       'MARKED DELIVERED BUT MISSING: once the carrier marks it delivered we cannot replace or refund it; ',
       'the customer files a claim with the carrier. Say this kindly, and offer to log a ticket so someone ',
       'can look at it. ',
       'CARRIER DELAYS: fulfilment is handled by a third-party logistics partner and we are not liable for ',
       'delays, loss or damage in transit. ',
       'POTENCY AND LAB RESULTS: never state a THC percentage, potency, strength or cannabinoid number, ',
       'and never compare two products by strength. The catalogue holds no such data, so any number would ',
       'be invented, and potency claims carry regulatory exposure. Say the certificates of analysis for ',
       'every batch are published at budclub.com/lab-result and offer to have someone follow up. Product ',
       'descriptions are flavour and aroma notes only — read those freely, but never read an effect claim ',
       'as a promise. ',
       'LEGAL: products are hemp-derived, under 0.3% Delta-9 THC, lab tested, 21+ only. We may refuse ',
       'shipment where state law restricts them. Never give medical, dosage or legal advice — say plainly ',
       'that it is not something we can advise on. ',
       'CONTACT: hey@budclub.com or budclub.com/contact. There is no support phone line. ',
       -- (b) UNRESOLVED ON THE SITE — deliberately silent.
       'NEVER state a free-shipping threshold: the site currently shows two different numbers.'
     )
   )
 where slug = 'budmember001';


-- #############################################################################
-- SECTION 6 — Verify
-- #############################################################################

select slug,
       store_platform,
       store_base_url,
       phone_number,
       store_credentials_ref,
       settings ->> 'order_number_scheme'        as scheme,
       settings ->> 'stock_policy'               as stock_policy,
       (settings ->> 'web_lookup_enabled')::bool as web_lookup,
       length(settings ->> 'policies')           as policy_chars,
       abnormal_status_rules ->> 'stale_after_hours' as stale_hours,
       business_hours ->> 'tz'                   as tz
  from clients
 where slug = 'budmember001';

-- Then sync the catalog (public Store API — no key required):
--
--   curl -X POST "$FUNCTIONS_URL/product-sync" \
--     -H "x-voice-tool-secret: $VOICE_TOOL_SECRET" \
--     -H 'content-type: application/json' \
--     -d '{"client_slug":"budmember001"}'
--
-- A healthy response has "complete": true and an empty warnings array, and
-- "source": "woocommerce_store_api" until a REST key is added.

select count(*)                              as products,
       count(*) filter (where available)     as in_stock,
       count(*) filter (where on_sale)       as on_sale,
       max(fetched_at)                       as last_sync
  from products_cache
 where client_id = (select id from clients where slug = 'budmember001');

select * from product_sync_health where slug = 'budmember001';


-- #############################################################################
-- SECTION 7 — Changing any of this later
-- #############################################################################
--
-- Everything above lives in two columns, so nothing here needs a redeploy:
--
--   clients.settings              — jsonb, merged with ||
--   clients.abnormal_status_rules — jsonb, replaced wholesale
--
-- Flip one key without touching the rest:
--
--   update clients
--      set settings = settings || jsonb_build_object('order_number_scheme', 'search')
--    where slug = 'budmember001';
--
-- Remove a key:
--
--   update clients set settings = settings - 'order_number_scheme'
--    where slug = 'budmember001';
--
-- ⚠️ `settings = jsonb_build_object(...)` without the `settings ||` REPLACES the
--    whole object and would silently drop web_lookup_enabled, stock_policy and
--    the policy blob. Always merge.
--
-- After changing settings, the next call picks it up — get_client_config is
-- read per request, and there is no cache to bust. products_cache is the one
-- exception: changing product_sync_interval_minutes only takes effect on the
-- next 15-minute scheduler tick.
