-- =============================================================================
-- test_google_oauth_connections.sql — non-destructive test of 0046's Google
-- OAuth schema: connect/incremental-auth/refresh/error/revoke/disconnect
-- lifecycle, plus the RLS split between google_oauth_connections (tenant-
-- readable) and google_oauth_tokens (never tenant-readable — 0043's lesson
-- applied to a second table). Requires Supabase Vault (extension
-- supabase_vault) to be enabled — confirmed enabled on this project
-- 2026-09-17.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_google_oauth_connections.sql
--   or: supabase db execute --file scripts/test_google_oauth_connections.sql
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client_a uuid;
  v_client_b uuid;
  v_user_a   uuid;
  v_user_b   uuid;
  v_res      jsonb;
  v_row      google_oauth_connections%rowtype;
  v_secret   text;
  v_secret_id uuid;
  v_seen     int;
  v_denied   boolean;
begin
  insert into clients (name, slug, is_active) values ('OAuth Tenant A', 'oauth-tenant-a', true)
  returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('OAuth Tenant B', 'oauth-tenant-b', true)
  returning id into v_client_b;

  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'oauth-a@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  -- 1) First connect: Search Console scope only.
  v_res := store_google_oauth_tokens(
    'refresh-token-abc', 'access-token-1', now() + interval '1 hour',
    array['https://www.googleapis.com/auth/webmasters.readonly'], 'owner@example.com');
  assert (v_res ->> 'ok')::boolean, 'connect: first connect succeeds';

  select * into v_row from google_oauth_connections where client_id = v_client_a;
  assert v_row.status = 'connected', 'connect: status connected';
  assert v_row.google_account_email = 'owner@example.com', 'connect: email stored';
  assert v_row.granted_scopes = array['https://www.googleapis.com/auth/webmasters.readonly'],
    'connect: scope stored';

  -- 2) Incremental auth: Business Profile scope added later must UNION, not
  --    overwrite, and a fresh refresh token must replace the old one.
  v_res := store_google_oauth_tokens(
    'refresh-token-xyz', 'access-token-2', now() + interval '1 hour',
    array['https://www.googleapis.com/auth/business.manage'], 'owner@example.com');
  select * into v_row from google_oauth_connections where client_id = v_client_a;
  assert array_length(v_row.granted_scopes, 1) = 2,
    format('incremental: expected 2 scopes, got %s', array_length(v_row.granted_scopes, 1));
  assert 'https://www.googleapis.com/auth/webmasters.readonly' = any(v_row.granted_scopes),
    'incremental: original scope preserved';
  assert 'https://www.googleapis.com/auth/business.manage' = any(v_row.granted_scopes),
    'incremental: new scope added';

  -- 3) Re-connect WITHOUT a refresh token (Google's normal re-auth behavior
  --    when prompt=consent isn't forced) must not wipe the stored one.
  v_res := store_google_oauth_tokens(
    null, 'access-token-3', now() + interval '1 hour', array[]::text[], 'owner@example.com');
  assert (v_res ->> 'ok')::boolean, 'reconnect: no-refresh-token path still succeeds';

  -- 4) Tenant cannot read the secret table at all — not the token, not even
  --    the row's existence — regardless of RLS, because the grant itself is
  --    revoked (0043's lesson: RLS alone isn't enough to demonstrate this).
  begin
    perform 1 from google_oauth_tokens where client_id = v_client_a;
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  assert v_denied, 'rls: authenticated must not be able to query google_oauth_tokens at all';

  -- 5) Tenant CAN read its own connection metadata, not another tenant's.
  select count(*) into v_seen from google_oauth_connections;
  assert v_seen = 1, 'rls: tenant sees only its own connection';

  -- 6) Tenant cannot write the connections table directly (writes are
  --    RPC-only).
  begin
    update google_oauth_connections set status = 'connected' where client_id = v_client_a;
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  assert v_denied, 'rls: authenticated must not be able to UPDATE google_oauth_connections directly';

  reset role;

  -- 7) service_role: read the refresh token back out of Vault via the RPC.
  select get_google_refresh_token(v_client_a) into v_secret;
  assert v_secret = 'refresh-token-xyz',
    format('vault: expected the SECOND connect''s refresh token to have replaced the first, got %s', v_secret);

  -- 8) service_role: the scheduled-refresh write path.
  perform update_google_access_token(v_client_a, 'access-token-refreshed', now() + interval '1 hour');
  select status, last_error into v_row.status, v_row.last_error
    from google_oauth_connections where client_id = v_client_a;
  assert v_row.status = 'connected', 'refresh: status stays connected';

  -- 9) service_role: a revoked grant (Google's invalid_grant) surfaces as
  --    status='revoked', distinct from a transient error.
  perform mark_google_oauth_error(v_client_a, 'invalid_grant', true);
  select status, last_error into v_row.status, v_row.last_error
    from google_oauth_connections where client_id = v_client_a;
  assert v_row.status = 'revoked', 'revoke: status becomes revoked';
  assert v_row.last_error = 'invalid_grant', 'revoke: error message stored';

  -- 10) A revoked connection drops out of the refresh scheduler's targets —
  --     no point retrying a dead grant every 15 minutes.
  select count(*) into v_seen from google_oauth_refresh_targets where client_id = v_client_a;
  assert v_seen = 0, 'scheduler: revoked connections are not refresh targets';

  -- 11) A transient error (not revoked) — set up client B fresh, mark error,
  --     confirm it DOES still show up as a target (worth retrying).
  v_user_b := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_b, 'oauth-b@example.com');
  update users set client_id = v_client_b, role = 'admin' where id = v_user_b;
  perform set_config('request.jwt.claim.sub', v_user_b::text, true);
  set local role authenticated;
  v_res := store_google_oauth_tokens(
    'refresh-token-b', 'access-token-b', now() + interval '1 hour',
    array['https://www.googleapis.com/auth/webmasters.readonly'], 'ownerb@example.com');
  assert (v_res ->> 'ok')::boolean, 'setup: client B connect succeeds';
  reset role;
  perform mark_google_oauth_error(v_client_b, 'temporary_network_error', false);
  select count(*) into v_seen from google_oauth_refresh_targets where client_id = v_client_b and is_due;
  assert v_seen = 1, 'scheduler: a non-revoked error is still a due target (retried)';

  -- 12) Disconnect removes both rows and the Vault secret.
  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;
  v_res := disconnect_google_oauth();
  assert (v_res ->> 'ok')::boolean, 'disconnect: succeeds';
  reset role;

  select count(*) into v_seen from google_oauth_connections where client_id = v_client_a;
  assert v_seen = 0, 'disconnect: connection row removed';
  select count(*) into v_seen from google_oauth_tokens where client_id = v_client_a;
  assert v_seen = 0, 'disconnect: token row removed';
  select get_google_refresh_token(v_client_a) into v_secret;
  assert v_secret is null, 'disconnect: vault secret is gone';

  raise notice 'ALL 0046 GOOGLE OAUTH TESTS PASSED';
end;
$$;

rollback;
