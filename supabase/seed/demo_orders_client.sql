-- =============================================================================
-- demo_orders_client.sql — a fictional store for the customer-service demo.
--
-- The counterpart to seed_hvac_client.sql (comfort-air-demo), which demos
-- scheduling. This one demos order lookup and product questions.
--
-- WHY FICTIONAL. The alternative was pointing the public demo at Bud Club's or
-- Tsunami's live catalog. That exposes a paying client's inventory on our
-- marketing site, and order lookup is worse: the demo either fails on the most
-- important question or reads real customers' orders aloud to strangers. Made-up
-- data is safe, controllable, and lets us script order numbers that always work.
--
-- Run once:  psql "$DATABASE_URL" -f supabase/seed/demo_orders_client.sql
-- Idempotent on the slug.
-- =============================================================================

do $$
declare
  v_client uuid;
begin
  -- ---------------------------------------------------------------------------
  -- The tenant.
  --
  -- is_demo = true is load-bearing. voice-order-lookup and voice-call-logger
  -- both gate the web path on `web_lookup_enabled === true || is_demo === true`,
  -- so without it the browser widget refuses to resolve this tenant by slug.
  --
  -- store_platform is left NULL on purpose. Setting it would make
  -- provisionVoice demand a store_credentials_ref, and there is no real store
  -- behind this — every product and order below is seeded directly into cache.
  -- ---------------------------------------------------------------------------
  insert into clients (
    name, slug, is_active, phone_number,
    brand_tone_config, business_hours, settings
  ) values (
    'Northlake Supply (Demo)',
    'northlake-demo',
    true,
    null,  -- set to the shared demo number after purchase; see §Demo number below
    jsonb_build_object(
      'voice',    'friendly, direct, unhurried',
      'sign_off', '',
      'use_emoji', false,
      'persona',  'Lumi',
      'voice_instructions',
        'You answer for Northlake Supply, an online outdoor gear store. Look up '
        'orders by order number. If the caller has no order number, ask for the '
        'email on the order. Never invent a tracking number or a delivery date.'
    ),
    jsonb_build_object('tz','America/Los_Angeles','hours','Mon-Fri 09:00-17:00'),
    jsonb_build_object(
      'is_demo', true,
      -- REQUIRED. voice-personalization reads settings.voice_agent_mode and
      -- anything other than 'orders' builds the SCHEDULING prompt, so the demo
      -- would try to book an appointment when a caller asks where their parcel
      -- is. Nothing errors; the agent is just answering the wrong job.
      'voice_agent_mode', 'orders',
      -- Public demo traffic is LumiLink-paid (CFO model, Assumptions B59), so
      -- the cap is what keeps a viral link from costing hundreds. 200 minutes
      -- at ~$0.09/min is about $18/month, worst case.
      'voice_caps', jsonb_build_object(
        'monthly_minutes', 200,
        'daily_minutes',   20,
        'max_call_secs',   105,
        'enabled',         true
      )
    )
  )
  on conflict (slug) do update set
    name              = excluded.name,
    is_active         = excluded.is_active,
    brand_tone_config = excluded.brand_tone_config,
    business_hours    = excluded.business_hours,
    settings          = clients.settings || excluded.settings
  returning id into v_client;

  if v_client is null then
    select id into v_client from clients where slug = 'northlake-demo';
  end if;

  -- ---------------------------------------------------------------------------
  -- Catalog. Enough breadth that "do you have X" has interesting answers, and
  -- deliberately including one sold-out item so the alternatives path (0024)
  -- gets exercised on a real call.
  -- ---------------------------------------------------------------------------
  delete from products_cache where client_id = v_client;
  insert into products_cache
    (client_id, product_ref, handle, title, product_type, vendor, status, tags,
     description, url, currency, price_min, price_max, tracks_inventory,
     total_inventory, available, variants)
  values
    (v_client, 'demo-1', 'ridgeline-2p-tent', 'Ridgeline 2P Tent', 'Tents',
     'Northlake', 'ACTIVE', '{"camping","tents"}',
     'A two-person three-season tent that packs to the size of a loaf of bread.',
     'https://example.com/ridgeline-2p', 'usd', 249.00, 249.00, true, 12, true,
     '[{"title":"Green","price":249.00,"available":true,"inventory":8},
       {"title":"Slate","price":249.00,"available":true,"inventory":4}]'::jsonb),

    (v_client, 'demo-2', 'trailhead-45l-pack', 'Trailhead 45L Pack', 'Packs',
     'Northlake', 'ACTIVE', '{"hiking","packs"}',
     'A 45 litre weekend pack with a ventilated back panel.',
     'https://example.com/trailhead-45l', 'usd', 179.00, 199.00, true, 20, true,
     '[{"title":"Regular","price":179.00,"available":true,"inventory":14},
       {"title":"Tall","price":199.00,"available":true,"inventory":6}]'::jsonb),

    (v_client, 'demo-3', 'summit-down-jacket', 'Summit Down Jacket', 'Outerwear',
     'Northlake', 'ACTIVE', '{"outerwear","winter"}',
     'An 800-fill down jacket that packs into its own chest pocket.',
     'https://example.com/summit-down', 'usd', 289.00, 289.00, true, 0, false,
     '[{"title":"S","price":289.00,"available":false,"inventory":0},
       {"title":"M","price":289.00,"available":false,"inventory":0}]'::jsonb),

    (v_client, 'demo-4', 'basecamp-stove', 'Basecamp Stove', 'Cooking',
     'Northlake', 'ACTIVE', '{"cooking","camping"}',
     'A single-burner stove that boils a litre in about three minutes.',
     'https://example.com/basecamp-stove', 'usd', 64.00, 64.00, true, 31, true,
     '[{"title":"Standard","price":64.00,"available":true,"inventory":31}]'::jsonb);

  -- ---------------------------------------------------------------------------
  -- Orders. Four states a caller actually rings about, so the demo has
  -- somewhere to go whichever prompt the visitor picks.
  --
  -- Dates are relative to now() so the demo never goes stale, and so the >24h
  -- abnormal-status rule keeps behaving as designed.
  -- ---------------------------------------------------------------------------
  delete from orders_cache where client_id = v_client;
  insert into orders_cache
    (client_id, order_number, store_platform, store_status, is_abnormal,
     customer_name, customer_email, currency, order_total, order_placed_at,
     line_items, tracking_number, carrier)
  values
    -- Shipped and trackable: the happy path.
    (v_client, '1001', null, 'shipped', false, 'Dana Whitfield',
     'dana@example.com', 'usd', 249.00, now() - interval '6 days',
     '[{"title":"Ridgeline 2P Tent","quantity":1,"price":249.00}]'::jsonb,
     '9400111899223197428490', 'USPS'),

    -- Still processing, placed recently: nothing is wrong yet.
    (v_client, '1002', null, 'processing', false, 'Marcus Lee',
     'marcus@example.com', 'usd', 243.00, now() - interval '5 hours',
     '[{"title":"Trailhead 45L Pack","quantity":1,"price":179.00},
       {"title":"Basecamp Stove","quantity":1,"price":64.00}]'::jsonb,
     null, null),

    -- On hold: the abnormal path, so the agent escalates instead of reassuring.
    (v_client, '1003', null, 'on-hold', true, 'Priya Raman',
     'priya@example.com', 'usd', 289.00, now() - interval '3 days',
     '[{"title":"Summit Down Jacket","quantity":1,"price":289.00}]'::jsonb,
     null, null),

    -- Delivered: tests that the agent stops offering to track it.
    (v_client, '1004', null, 'delivered', false, 'Tom Alvarez',
     'tom@example.com', 'usd', 64.00, now() - interval '14 days',
     '[{"title":"Basecamp Stove","quantity":1,"price":64.00}]'::jsonb,
     '9400111899223197428491', 'USPS');

  raise notice 'Seeded northlake-demo (%). Products: 4, orders: 1001-1004.', v_client;
end $$;

select c.slug, c.id as client_id, c.phone_number,
       (select count(*) from products_cache p where p.client_id = c.id) as products,
       (select count(*) from orders_cache o where o.client_id = c.id)   as orders
from clients c where c.slug = 'northlake-demo';

-- =============================================================================
-- DEMO NUMBER — do this after buying it
-- =============================================================================
-- One shared Twilio number serves both demos (the CFO model budgets exactly one).
-- After purchasing and importing it into ElevenLabs:
--
--   update clients set phone_number = '+1XXXXXXXXXX' where slug = 'northlake-demo';
--
-- AND FIX THE HVAC DEMO WHILE YOU ARE THERE. app/demo/page.tsx currently
-- advertises +12135332469, which belongs to Tsunami (slug 'shopify-store') and
-- is assigned to their orders agent. Public demo callers are reaching a paying
-- client's line and spending their 100-minute allowance. comfort-air-demo holds
-- +14155550123, a reserved 555 number that cannot be dialled at all.
--
--   update clients set phone_number = '+1XXXXXXXXXX' where slug = 'comfort-air-demo';
--
-- One number cannot resolve to two tenants: resolve_client_by_number returns a
-- single row. So either give each demo its own number, or point the shared
-- number at ONE tenant and let the other demo run browser-only.
