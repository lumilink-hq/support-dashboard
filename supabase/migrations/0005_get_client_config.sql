-- 0005_get_client_config.sql
-- One read-side RPC the orchestration layer (Zapier/Make/n8n) calls once per run to
-- pull a client's NON-SECRET config out of the `clients` row, so the Zap stops
-- hardcoding brand/tone, store platform/url, and reply-from address.
--
-- Secrets (store API keys, ShipStation) are deliberately NOT returned here — those
-- come from get_client_integration_secrets (Vault). This function is safe to expose
-- with the service_role key the orchestration already holds.
--
-- Shape returned (jsonb):
--   {
--     "client_id": "...", "name": "...", "slug": "...", "is_active": true,
--     "store_platform": "shopify" | "woocommerce" | null,
--     "store_base_url": "https://..." | null,
--     "support_emails": ["support@store.com", ...],   -- always an array; primary is [0]
--     "brand_tone_config": { "voice": "...", "sign_off": "...", "use_emoji": false },
--     "business_hours": { ... },
--     "abnormal_status_rules": { "abnormal_statuses": [...], "stale_after_hours": 24 }
--   }
-- Unknown client_id -> NULL (the caller should stop).

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
    'abnormal_status_rules', coalesce(c.abnormal_status_rules, '{}'::jsonb)
  )
  from clients c
  where c.id = p_client_id;
$$;

-- Orchestration RPC: lock to service_role, same as the others in 0002.
revoke execute on function get_client_config(uuid) from public;
grant  execute on function get_client_config(uuid) to service_role;
