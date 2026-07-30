-- =============================================================================
-- 0022_woo_order_scheme.sql
-- Surface clients.settings.order_number_scheme through get_client_config, so the
-- voice path can look a WooCommerce order up the same three ways the production
-- email Zap already does.
--
-- WHY: `/wp-json/wc/v3/orders/{n}` takes WooCommerce's INTERNAL post id. That is
-- only the same as the number printed on the customer's confirmation on a store
-- with no sequential-order-number plugin — and those plugins are close to
-- universal. On any store where they differ, the customer reads out the number
-- they can see, the voice function asks Woo for a post id that either does not
-- exist or belongs to SOMEONE ELSE'S ORDER, and the call fails while the exact
-- same order resolves fine over email. The Zap has supported the schemes since
-- it was written; only the voice function was ever hardcoded to 'id'.
--
--   'id'          -> /orders/{n}                            (default, unchanged)
--   'search'      -> /orders?search={n}                     customer-facing number
--   'meta:<key>'  -> /orders?meta_key=<key>&meta_value={n}  plugin's meta field
--
-- The 'search' form is a FULL-TEXT match and can return a neighbouring order
-- (the number appearing in a customer note is enough). The function guards that
-- with pickWooOrder(), which requires an exact hit on `number` or `id` — the Woo
-- analogue of pickExactOrder() on the Shopify side. Do not relax either one.
--
-- Shopify ignores this value entirely; it looks orders up by name.
--
-- Set it with:
--   update clients
--      set settings = settings || jsonb_build_object('order_number_scheme', 'search')
--    where slug = 'budmember001';
--
-- NULL / absent means 'id', which is the behaviour every existing client has
-- today, so this migration changes nothing until a client opts in.
--
-- Idempotent (create or replace). Supersedes the definition in 0017; every
-- field there is carried forward unchanged.
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
    -- Added 0017. Null when unset; callers must treat null as "no prefix".
    'order_number_prefix',   nullif(trim(c.settings ->> 'order_number_prefix'), ''),
    -- NEW in 0022. Null when unset; callers must treat null as 'id'.
    'order_number_scheme',   nullif(trim(c.settings ->> 'order_number_scheme'), '')
  )
  from clients c
  where c.id = p_client_id;
$$;

revoke execute on function get_client_config(uuid) from public;
grant  execute on function get_client_config(uuid) to service_role;

comment on function get_client_config(uuid) is
  'Per-client config for the email and voice agents. settings keys read here: '
  'support_emails, order_number_prefix (0017), order_number_scheme (0022, '
  'WooCommerce only: id | search | meta:<key>).';

-- End of 0022.
