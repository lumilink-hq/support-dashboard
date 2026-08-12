-- =============================================================================
-- 0035_restore_order_number_keys.sql
--
-- Restore two keys that 0029 silently deleted from get_client_config:
--   order_number_prefix  (added 0017)
--   order_number_scheme  (added 0022)
--
-- WHAT HAPPENED. 0029 added `timezone` and `escalation_mode` by re-running
-- `create or replace function get_client_config` with a freshly written
-- jsonb_build_object. That object was based on 0005's key list, not 0022's, so
-- the two order-number keys were dropped. 0029's own header says "Additive:
-- existing keys are untouched" — it wasn't, and nothing failed: the function
-- still compiled, still returned, and every caller just started reading
-- `undefined` for those two keys.
--
-- WHAT IT COST. Live call 2026-08-12, Tsunami (`shopify-store`), order 1833:
--   • clients.settings.order_number_prefix was correctly set to 'TSU#'
--   • the store really does name the order "TSU#1833"
--   • Shopify really did return it for the query voice-order-lookup sent
--   • the function got order_number_prefix = undefined, so pickExactOrder had
--     nothing to widen by, rejected "TSU#1833" as a near-miss of "1833", and
--     told the caller their order did not exist.
-- The same undefined hits WooCommerce clients through order_number_scheme,
-- which falls back to 'id' — looking up the WordPress post id instead of the
-- customer-facing order number, for every Woo tenant, since 0029 shipped.
--
-- THE RULE THIS BREAKS, WORTH WRITING DOWN. `create or replace function` on a
-- function that builds a jsonb payload is an API change with no compiler and no
-- error. When editing get_client_config, start from the CURRENT definition
-- (`\sf get_client_config`) and add to it — never retype the object from an
-- older migration.
--
-- This migration is the union of 0022 and 0029. No key is dropped, and no
-- caller has to change.
-- =============================================================================

create or replace function get_client_config(p_client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'client_id',             c.id,
    'name',                  c.name,
    'slug',                  c.slug,
    'is_active',             c.is_active,
    'store_platform',        c.store_platform,
    'store_base_url',        c.store_base_url,
    -- support_emails: prefer the settings.support_emails array; fall back to the
    -- legacy single support_email column; always hand back a (possibly empty) array.
    'support_emails',        coalesce(
                               nullif(c.settings -> 'support_emails', 'null'::jsonb),
                               case
                                 when c.support_email is not null
                                   then jsonb_build_array(c.support_email)
                                 else '[]'::jsonb
                               end
                             ),
    'brand_tone_config',     coalesce(c.brand_tone_config, '{}'::jsonb),
    'business_hours',        coalesce(c.business_hours, '{}'::jsonb),
    'abnormal_status_rules', coalesce(c.abnormal_status_rules, '{}'::jsonb),

    -- RESTORED (0017, dropped by 0029). Null when unset; callers must treat
    -- null as "no prefix".
    'order_number_prefix',   nullif(trim(c.settings ->> 'order_number_prefix'), ''),

    -- RESTORED (0022, dropped by 0029). Null when unset; callers must treat
    -- null as 'id'. WooCommerce only: id | search | meta:<key>.
    'order_number_scheme',   nullif(trim(c.settings ->> 'order_number_scheme'), ''),

    -- From 0029. An IANA name, always present, already validated. Callers
    -- format customer-facing dates in this rather than in UTC.
    'timezone',              client_timezone(c.id),

    -- From 0029. Where the agent sends a caller it cannot finish with.
    --   'callback' (default) -> take details, create a callback ticket
    --   'email'              -> may offer support_emails[0] instead
    'escalation_mode',       case
                               when c.settings ->> 'escalation_mode' = 'email'
                                 then 'email'
                               else 'callback'
                             end
  )
  from clients c
  where c.id = p_client_id;
$$;

revoke execute on function get_client_config(uuid) from public;
grant  execute on function get_client_config(uuid) to service_role;

comment on function get_client_config(uuid) is
  'Per-client config for the email and voice agents. settings keys read here: '
  'support_emails, order_number_prefix (0017), order_number_scheme (0022, '
  'WooCommerce only: id | search | meta:<key>), escalation_mode (0029). '
  'timezone comes from client_timezone(). EDIT BY ADDING TO THE CURRENT '
  'DEFINITION — 0029 retyped this object from an older migration and silently '
  'dropped two keys (see 0035).';

-- Verify — every key must be non-null for Tsunami, and prefix must read TSU#:
--   select slug,
--          get_client_config(id) ->> 'order_number_prefix' as prefix,
--          get_client_config(id) ->> 'order_number_scheme' as scheme,
--          get_client_config(id) ->> 'timezone'            as tz,
--          get_client_config(id) ->> 'escalation_mode'     as escalation
--     from clients order by slug;
--
-- Regression guard — no key that was ever exposed may disappear again:
--   select key from jsonb_object_keys(
--            get_client_config((select id from clients where slug = 'shopify-store'))
--          ) as key
--    order by 1;

-- End of 0035.
