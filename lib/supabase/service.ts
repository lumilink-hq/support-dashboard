import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — bypasses RLS entirely.
 *
 * CONFINE THIS TO lib/services/billing.ts. Per app/onboarding/actions.ts:
 * "a wizard that could write as service_role is a wizard one bug away from
 * writing to somebody else's row." Every other Server Component/Action/Route
 * Handler in this app uses lib/supabase/server.ts instead, which runs under
 * the signed-in user's own RLS. This one exists only because the Stripe
 * webhook has no signed-in user at all, and the billing services need to
 * write columns (clients.stripe_*) that 0041 deliberately revokes from
 * `authenticated`.
 *
 * Mirrors the pattern already used in
 * supabase/functions/billing-webhook/index.ts — same shape, different
 * runtime (Node/Next instead of Deno).
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

  return createSupabaseClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
