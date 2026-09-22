-- =============================================================================
-- 0047_google_oauth_self_access_token.sql
-- One small addition to 0046: the disconnect flow (app/(dashboard)/settings/
-- actions.ts) wants to call Google's own /revoke endpoint before forgetting
-- the connection locally — otherwise the grant lingers in the user's Google
-- Account "connected apps" list even though LumiLink can no longer use it.
--
-- Google's revoke endpoint accepts either an access or refresh token.
-- google_oauth_tokens (0046) is deliberately unreadable by `authenticated`
-- at all — but the disconnect action runs under the signed-in user's own
-- session (no service-role client, same rule every other onboarding/settings
-- action follows), so it has no other way to get a token to revoke.
--
-- SELF-SCOPED, LOW SENSITIVITY, SAME IDIOM AS has_feature/store_google_oauth_
-- tokens/disconnect_google_oauth: no client_id parameter, resolves
-- current_client_id() internally, so a tenant can only ever read its OWN
-- cached access token — never another tenant's, and never the refresh token
-- itself (which stays Vault-only, reachable solely by get_google_refresh_token,
-- service_role). The access token is already the "plaintext is an accepted
-- tradeoff" column per 0046's own comment (short-lived, low blast radius) —
-- this just adds one more reader of that same value, the token's own owner.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

create or replace function get_my_google_access_token()
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select access_token_cache from google_oauth_tokens
   where client_id = current_client_id();
$$;

revoke execute on function get_my_google_access_token() from public;
grant execute on function get_my_google_access_token() to authenticated, service_role;

comment on function get_my_google_access_token() is
  'Self-scoped: returns the CALLING tenant''s own cached Google access token, '
  'or null. Used only to revoke it with Google on disconnect. Never exposes '
  'the refresh token or another tenant''s token.';

-- End of 0047.
