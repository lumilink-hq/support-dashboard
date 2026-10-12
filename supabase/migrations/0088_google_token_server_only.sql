-- =============================================================================
-- 0088_google_token_server_only.sql — the Google access token never leaves
-- the server.
--
-- get_my_google_access_token (0047, narrowed to admins/agents by 0084) handed
-- the client's cached Google access token to any signed-in admin or agent
-- through PostgREST. That token carries business.manage, Google's only
-- Business Profile scope, which can edit or delete everything the connecting
-- Google account can: name, address, hours, posts, photos, managers. The app
-- only ever wrote two fields (seo-publish/gbp.ts GBP_WRITABLE, 0079's CHECK),
-- but a user with the raw token could skip both. The privacy policy promises
-- that connecting Google is not permission to edit a listing; this makes the
-- token unreachable from a browser so the promise holds.
--
-- Its one remaining caller (revoke-on-disconnect in Settings) now reads the
-- token server-side: lib/services/google-token.ts checks the signed-in user is
-- an admin, then reads google_oauth_tokens with the service role. (The other
-- caller, the category search on /seo, went with 0089.)
-- google_oauth_tokens itself was never readable by `authenticated` (0046).
--
-- DEPLOY ORDER: ship the app first (it no longer calls this function), then
-- push this migration. Pushed first, the old app's disconnect skips the
-- Google revoke (and its category search fails) until the new app is live.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

drop function if exists get_my_google_access_token();

-- Verify: scripts/test_seo_role_checks.sql (runs in a rolled-back transaction).

-- End of 0088.
