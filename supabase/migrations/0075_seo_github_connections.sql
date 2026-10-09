-- =============================================================================
-- 0075_seo_github_connections.sql
-- A site connection can be a GitHub repository, not only a Shopify store
-- (2026-10-09). Built for LumiLink's own site, a Next.js app whose repository
-- Railway deploys from: approved articles and title/description fixes are
-- committed to it by seo-publish (github.ts, github-lib.ts) instead of coming
-- back as "Do by hand".
--
--   platform     'shopify' (unchanged) or 'github'
--   shop_domain  for GitHub: the site's public host (www.lumilinkhub.com). Kept
--                in the same column so the dashboard's connection banners and
--                the publisher's "is this URL on the site?" check need no
--                second code path.
--   repo         GitHub only: owner/name
--   branch       GitHub only: the branch the site deploys from
--
-- The credential stays in Vault, referenced by seo_site_credentials, as JSON
-- {"access_token": "github_pat_..."}: a fine-grained token for that one
-- repository with Contents read and write. See scripts/connect-github-site.sql.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

alter table seo_site_connections
  add column if not exists repo   text,
  add column if not exists branch text;

alter table seo_site_connections drop constraint if exists seo_site_connections_platform_check;
alter table seo_site_connections add constraint seo_site_connections_platform_check
  check (platform in ('shopify', 'github'));

-- 0055's unnamed check, by its generated name.
alter table seo_site_connections drop constraint if exists seo_site_connections_shop_domain_check;
alter table seo_site_connections drop constraint if exists seo_site_connections_target_check;
alter table seo_site_connections add constraint seo_site_connections_target_check check (
  (platform = 'shopify'
     and shop_domain ~* '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
     and repo is null)
  or
  (platform = 'github'
     and shop_domain ~* '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
     and repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
     and coalesce(branch, '') ~ '^[A-Za-z0-9._/-]{1,100}$')
);

-- 0055's credential lookup, now also telling the publisher which platform.
create or replace function get_seo_site_credentials(p_location_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_conn seo_site_connections%rowtype;
  v_ref  text;
begin
  select * into v_conn from seo_site_connections where location_id = p_location_id;
  if not found then
    return null;
  end if;
  select credentials_ref into v_ref from seo_site_credentials where connection_id = v_conn.id;

  return jsonb_build_object(
    'connection_id',  v_conn.id,
    'platform',       v_conn.platform,
    'repo',           v_conn.repo,
    'branch',         v_conn.branch,
    'shop_domain',    v_conn.shop_domain,
    'primary_domain', v_conn.primary_domain,
    'status',         v_conn.status,
    'granted_scopes', to_jsonb(v_conn.granted_scopes),
    'credentials',    (select decrypted_secret from vault.decrypted_secrets where name = v_ref)
  );
end;
$$;

revoke execute on function get_seo_site_credentials(uuid) from public, authenticated;
grant execute on function get_seo_site_credentials(uuid) to service_role;

-- End of 0075.
