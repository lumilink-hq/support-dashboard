-- =============================================================================
-- budclub_credentials_domain_fix_2026_09.sql — fix the STALE domain inside Bud
-- Club's (budmember001) WooCommerce credentials, not the clients table.
--
-- WHY THIS EXISTS: budclub_domain_update_2026_09.sql updated clients.store_base_url
-- to https://budclubshop.com. That column is only consulted as a FALLBACK —
-- product-sync/index.ts uses `creds.base_url || storeBaseUrl`, and budclub
-- actually has real WooCommerce API keys (store_credentials_ref is set), so
-- creds.base_url wins every time. That value lives inside the Vault secret the
-- ref points to, still says https://budclub.com, and is what actually broke:
--
--   product sync crashed: TypeError: error sending request for url
--   (https://budclub.com/wp-json/wc/v3/products?...): tls handshake eof
--
-- This script patches ONLY the base_url key inside that secret's JSON, via a
-- jsonb merge, so the consumer_key/consumer_secret already in there are never
-- read, printed, or retyped.
--
-- NOT a migration. Per-client data, run by hand against whichever environment
-- you mean to configure. Safe to re-run (patching base_url to the same value
-- twice is a no-op).
--
-- ⚠️ The verify query at the bottom returns the FULL decrypted secret, which
-- includes the live consumer_key/consumer_secret. Fine to look at in the SQL
-- editor to confirm base_url changed — don't paste that output anywhere.
-- =============================================================================


-- =============================================================================
-- PREFLIGHT — fail loudly if the slug, ref, or vault secret is missing.
-- =============================================================================
do $$
declare
  v_client_id uuid;
  v_ref       text;
  v_secret_id uuid;
  v_current   text;
  v_new       jsonb;
begin
  select id, store_credentials_ref into v_client_id, v_ref
    from clients where slug = 'budmember001';

  if v_client_id is null then
    raise exception 'No client with slug "budmember001". Nothing was configured.';
  end if;

  if v_ref is null then
    raise exception
      'budmember001 has no store_credentials_ref — there is no Vault secret to '
      'patch. (If it turns out this client has no real API keys after all, the '
      'fix is clients.store_base_url instead, already done in '
      'budclub_domain_update_2026_09.sql, and this script has nothing to do.)';
  end if;

  select id, decrypted_secret into v_secret_id, v_current
    from vault.decrypted_secrets where name = v_ref;

  if v_secret_id is null then
    raise exception 'store_credentials_ref "%" does not match any Vault secret.', v_ref;
  end if;

  -- Merge, not replace — keeps consumer_key/consumer_secret exactly as they are.
  v_new := coalesce(v_current::jsonb, '{}'::jsonb)
           || jsonb_build_object('base_url', 'https://budclubshop.com');

  perform vault.update_secret(v_secret_id, v_new::text);

  raise notice 'Vault secret "%" (client %) base_url patched to https://budclubshop.com',
    v_ref, v_client_id;
end;
$$;


-- =============================================================================
-- VERIFY — confirm base_url changed. Ignore consumer_key/consumer_secret in the
-- output; they're unchanged and are shown only because the secret is one blob.
-- =============================================================================
select decrypted_secret::jsonb ->> 'base_url' as base_url
  from vault.decrypted_secrets
 where name = (select store_credentials_ref from clients where slug = 'budmember001');


-- =============================================================================
-- Then retry the sync for this one client:
--
--   select request_product_sync('503bea0f-c319-4d78-9dd4-ef32e4830583');
--
-- followed by:
--
--   select id, status_code, content::text, created
--     from net._http_response order by created desc limit 5;
--
--   select * from product_sync_health where slug = 'budmember001';
-- =============================================================================
