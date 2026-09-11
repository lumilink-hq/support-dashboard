-- =============================================================================
-- budclub_domain_update_2026_09.sql — repoint Bud Club (budmember001) at its
-- new domain, budclubshop.com.
--
-- WHY: budclub.com went down. The client moved to budclubshop.com. Everything
-- in budclub_config.sql that reads/writes store_base_url — product-sync and
-- voice-order-lookup's WooCommerce calls — was still pointed at the dead
-- domain, so catalog sync and order lookup would fail even with the contact-
-- page widget correctly embedded.
--
-- NOT a migration. Per-client data, so it lives in seed/ and is run by hand
-- against whichever environment you mean to configure. Safe to re-run.
-- =============================================================================


-- =============================================================================
-- PREFLIGHT — fail loudly if the slug is wrong (same guard as budclub_config.sql)
-- =============================================================================
do $$
declare
  v_id  uuid;
  v_old text;
begin
  select id, store_base_url into v_id, v_old from clients where slug = 'budmember001';
  if v_id is null then
    raise exception 'No client with slug "budmember001". Nothing was configured.';
  end if;
  raise notice 'Repointing client % (budmember001) from % to https://budclubshop.com', v_id, v_old;
end;
$$;


-- =============================================================================
-- UPDATE — store_base_url only. No trailing slash, matching every other row
-- (see seed_clients.sql).
-- =============================================================================
update clients
   set store_base_url = 'https://budclubshop.com'
 where slug = 'budmember001';


-- =============================================================================
-- VERIFY
-- =============================================================================
select slug, store_platform, store_base_url
  from clients
 where slug = 'budmember001';

-- Then re-sync the catalog against the new domain (public Store API, no key
-- required unless store_credentials_ref is set):
--
--   curl -X POST "$FUNCTIONS_URL/product-sync" \
--     -H "x-voice-tool-secret: $VOICE_TOOL_SECRET" \
--     -H 'content-type: application/json' \
--     -d '{"client_slug":"budmember001"}'
--
-- A healthy response has "complete": true and an empty warnings array.

select count(*)                          as products,
       count(*) filter (where available) as in_stock,
       max(fetched_at)                   as last_sync
  from products_cache
 where client_id = (select id from clients where slug = 'budmember001');

select * from product_sync_health where slug = 'budmember001';
