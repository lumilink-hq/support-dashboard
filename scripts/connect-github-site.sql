-- =============================================================================
-- connect-github-site.sql — connect a location to its site's GitHub repository
-- so approved SEO changes are committed instead of coming back as "Do by hand"
-- (0075, seo-publish github.ts). Written for LumiLink's own site.
--
-- BEFORE RUNNING
--   1. Apply 0075_seo_github_connections.sql and deploy seo-publish:
--        npx supabase functions deploy seo-publish --no-verify-jwt
--   2. On GitHub, create a fine-grained personal access token:
--        Settings > Developer settings > Fine-grained tokens > Generate new token
--        Resource owner: lumilink-hq. Repository access: Only select repositories
--        > support-dashboard. Permissions: Contents = Read and write (Metadata
--        read-only is added automatically). Pick an expiry and note the date.
--   3. Replace PASTE_TOKEN_HERE below with the token (in the SQL editor only; it
--      goes straight into Vault and isn't stored anywhere else).
--
-- WHAT IT DOES: stores the token in Vault, creates the connection for the
-- location below, and makes its first heartbeat due. Within about 5 minutes the
-- connection should read 'healthy' (select status, last_error from
-- seo_site_connections where repo = 'lumilink-hq/support-dashboard';).
--
-- TO DISCONNECT: delete from seo_site_connections where repo = '...'; then
-- delete from vault.secrets where name = 'seo_github_lumilink';
-- and revoke the token on GitHub.
-- =============================================================================

do $$
declare
  -- LumiLink's own SEO location (lumilinkhq@gmail.com workspace).
  v_location uuid := '49d595e8-5987-4d96-80ba-f1c152fea234';
  v_token    text := 'PASTE_TOKEN_HERE';
  v_client   uuid;
  v_conn     uuid;
begin
  if v_token = 'PASTE_TOKEN_HERE' or v_token !~ '^(github_pat_|ghp_)' then
    raise exception 'Paste the GitHub token into v_token first.';
  end if;
  select client_id into v_client from seo_locations where id = v_location;
  if v_client is null then
    raise exception 'Location % not found.', v_location;
  end if;

  delete from vault.secrets where name = 'seo_github_lumilink';
  perform vault.create_secret(json_build_object('access_token', v_token)::text, 'seo_github_lumilink', 'GitHub token for the LumiLink site SEO publisher');

  insert into seo_site_connections (client_id, location_id, platform, shop_domain, repo, branch, status)
  values (v_client, v_location, 'github', 'www.lumilinkhub.com', 'lumilink-hq/support-dashboard', 'main', 'unchecked')
  on conflict (location_id) do update
    set platform = 'github', shop_domain = excluded.shop_domain, repo = excluded.repo, branch = excluded.branch,
        status = 'unchecked', granted_scopes = '{}', last_error = null
  returning id into v_conn;

  insert into seo_site_credentials (connection_id, credentials_ref) values (v_conn, 'seo_github_lumilink')
  on conflict (connection_id) do update set credentials_ref = excluded.credentials_ref;

  -- First heartbeat at the next 5-minute tick.
  update job_attempts set next_run_at = now()
   where client_id = v_client and job_type = 'seo_site_check' and entity_id = v_location;

  raise notice 'Connected location % to lumilink-hq/support-dashboard (connection %).', v_location, v_conn;
end;
$$;
