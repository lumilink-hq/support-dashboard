// The client's Google access token, for server code only (0088).
//
// The token carries business.manage, which can edit everything the connecting
// Google account can on its Business Profiles. LumiLink only ever writes the
// description, and only after an approval (seo-publish/gbp.ts), so the token
// must never reach a browser where it could be used without those limits. It
// used to come from get_my_google_access_token over PostgREST, which any
// signed-in admin or agent could call directly; 0088 dropped that function.
//
// Its one use is revoking the grant with Google on disconnect (admin only).
// The category search that also needed it went with 0089.
//
// The role check happens HERE, before the service-role read, the same pattern
// as lib/services/team-invites.ts. Never return the token to a client
// component or put it in a response.

import { getMembership, isAdmin } from "@/lib/roles";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * The signed-in admin's client's cached Google access token, or null when
 * signed out, not an admin, or Google isn't connected.
 */
export async function googleAccessTokenForAdmin(): Promise<string | null> {
  const member = await getMembership();
  if (!member || !isAdmin(member.role)) return null;

  const { data } = await createServiceClient()
    .from("google_oauth_tokens")
    .select("access_token_cache")
    .eq("client_id", member.clientId)
    .maybeSingle();
  return (data?.access_token_cache as string | null | undefined) ?? null;
}
