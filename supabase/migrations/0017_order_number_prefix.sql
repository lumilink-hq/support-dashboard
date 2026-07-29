-- =============================================================================
-- 0017_order_number_prefix.sql
-- Surface clients.settings.order_number_prefix through get_client_config.
--
-- WHY: Shopify stores can set an order-name prefix, so Tsunami's orders are
-- named "TSU#1749", not "#1749". Every piece of the voice lookup assumed the
-- default "#1234" shape and broke on the prefix in two independent ways:
--
--   1. normalizeOrderNumber("TSU#1749") strips "#" as a non-alphanumeric, so we
--      queried Shopify for name:TSU1749 — a name that does not exist.
--   2. Even on a lucky token match, pickExactOrder compared stripHash("TSU#1749")
--      ("TSU#1749", since stripHash only removes a LEADING #) against "TSU1749".
--      Never equal, so the real order was discarded as a near-miss.
--
-- The exact-match guard in (2) exists for a good reason — Shopify's name search
-- is a token match, so name:1001 also returns #1001-A — so it must stay strict.
-- The fix is to make both sides prefix-aware rather than to loosen matching.
--
-- Adding it to get_client_config (rather than a second query) keeps the voice
-- function to one config round-trip, and gives the EMAIL agent the same value —
-- it reads this RPC too, and has the same prefix problem the moment a customer
-- writes "TSU#1749" in an email.
--
-- Set it with:
--   update clients
--      set settings = settings || jsonb_build_object('order_number_prefix', 'TSU#')
--    where slug = 'shopify-store';
--
-- NULL / absent means "no prefix", which is the default Shopify "#1234" shape
-- and the behaviour every other client already relies on.
--
-- Idempotent (create or replace).
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
    -- NEW in 0017. Null when unset; callers must treat null as "no prefix".
    'order_number_prefix',   nullif(trim(c.settings ->> 'order_number_prefix'), '')
  )
  from clients c
  where c.id = p_client_id;
$$;

revoke execute on function get_client_config(uuid) from public;
grant  execute on function get_client_config(uuid) to service_role;

-- End of 0017.
