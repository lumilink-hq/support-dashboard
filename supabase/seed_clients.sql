-- =============================================================================
-- seed_clients.sql — one-off seed for the two in-house stores (crunch setup).
-- Run in the Supabase SQL editor (NOT part of `db reset`; that's seed.sql).
--
-- Crunch mode: store API creds are hardcoded in the Zaps, so the *_credentials_ref
-- columns stay NULL here. When you move to Vault later, set them to the secret names.
--
-- Idempotent: re-running updates the row (conflict on the unique `slug`).
-- Replace the <PLACEHOLDER> values, then run. The final SELECT returns the
-- client_id you paste into each Zap's p_client_id.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. WooCommerce store
-- -----------------------------------------------------------------------------
insert into clients (
  name, slug, store_platform, store_base_url,
  support_email, brand_tone_config, abnormal_status_rules,
  business_hours, settings
) values (
  'Bud Club',
  'woo-store',                                   -- url-safe handle (unique)
  'woocommerce',
  'https://budclub.com',                   -- no trailing slash
  'hey@budclub.com',
  jsonb_build_object(
    'voice',    'friendly, concise, helpful',
    'sign_off', '— The Bud Club Team',
    'use_emoji', false
  ),
  -- evaluate_flag checks the normalized store_status against this array, and
  -- flags orders older than stale_after_hours. Woo statuses are lowercase.
  jsonb_build_object(
    'abnormal_statuses', jsonb_build_array('on-hold','failed','cancelled','refunded'),
    'stale_after_hours', 24
  ),
  jsonb_build_object('tz','America/New_York','hours','Mon-Fri 09:00-17:00'),
  -- order_number_scheme: 'id' (customer number == Woo order id) or
  -- 'meta:_order_number' if a sequential-number plugin is installed.
  jsonb_build_object('order_number_scheme','id')
)
on conflict (slug) do update set
  name                  = excluded.name,
  store_platform        = excluded.store_platform,
  store_base_url        = excluded.store_base_url,
  support_email         = excluded.support_email,
  brand_tone_config     = excluded.brand_tone_config,
  abnormal_status_rules = excluded.abnormal_status_rules,
  business_hours        = excluded.business_hours,
  settings              = excluded.settings,
  updated_at            = now();

-- -----------------------------------------------------------------------------
-- 2. Shopify store
-- -----------------------------------------------------------------------------
insert into clients (
  name, slug, store_platform, store_base_url,
  support_email, brand_tone_config, abnormal_status_rules,
  business_hours, settings
) values (
  'Tsunami',
  'shopify-store',                               -- url-safe handle (unique)
  'shopify',
  'https://tsunami-store-7957.myshopify.com',          -- the *.myshopify.com admin host
  'hey@tsunami.store',
  jsonb_build_object(
    'voice',    'friendly, concise, helpful',
    'sign_off', '— The Tsunami Team',
    'use_emoji', false
  ),
  -- Shopify has TWO status enums (financial + fulfillment). evaluate_flag takes
  -- ONE string, so in the Zap push a single normalized status:
  --   if displayFinancialStatus in (REFUNDED, VOIDED, PARTIALLY_REFUNDED) -> use it,
  --   else use displayFulfillmentStatus.
  -- This array then covers both dimensions in one membership check.
  jsonb_build_object(
    'abnormal_statuses', jsonb_build_array(
      'ON_HOLD','RESTOCKED','REFUNDED','VOIDED','PARTIALLY_REFUNDED'),
    'stale_after_hours', 24
  ),
  jsonb_build_object('tz','America/New_York','hours','Mon-Fri 09:00-17:00'),
  -- Shopify lookup is always by order name (#1001), so the scheme is informational.
  jsonb_build_object('order_number_scheme','name')
)
on conflict (slug) do update set
  name                  = excluded.name,
  store_platform        = excluded.store_platform,
  store_base_url        = excluded.store_base_url,
  support_email         = excluded.support_email,
  brand_tone_config     = excluded.brand_tone_config,
  abnormal_status_rules = excluded.abnormal_status_rules,
  business_hours        = excluded.business_hours,
  settings              = excluded.settings,
  updated_at            = now();

-- -----------------------------------------------------------------------------
-- Grab the client_id for each Zap's p_client_id constant.
-- -----------------------------------------------------------------------------
select slug, id, name, store_platform
from clients
where slug in ('woo-store','shopify-store')
order by slug;
