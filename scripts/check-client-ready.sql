-- =============================================================================
-- check-client-ready.sql — can THIS client actually buy and be served?
--
-- Supabase Dashboard -> SQL Editor. Run before pointing a real client at
-- checkout. Every column below has caused a stuck purchase at least once.
-- =============================================================================

select
  c.name,
  c.slug,
  c.id as client_id,

  -- 1. CAN THEY SIGN IN?
  -- Checkout only routes when checkoutUrl() can append client_reference_id, and
  -- that needs a signed-in session. A client seeded by SQL has a clients row but
  -- NO auth user, so nobody can log in as them, so their payment arrives with no
  -- tenant and parks as 'unmapped'.
  (select count(*) from users u where u.client_id = c.id) as login_accounts,

  -- 2. CAN PROVISIONING FINISH?
  -- No phone number means provision-feature parks at needs_human and the client
  -- sits on "Setting up your plan" while being billed.
  coalesce(c.phone_number, '(none — provisioning will park)') as phone_number,

  -- 3. WILL THEY GET THE MINUTES THEY PAID FOR?
  -- 0025 backfilled every pre-existing client at the old default of 200.
  -- set_plan_voice_caps refuses to overwrite an explicit cap, so a Starter
  -- purchase leaves them on 200 minutes instead of 100. Silent, and it costs us.
  c.settings -> 'voice_caps' ->> 'monthly_minutes' as minutes_cap,
  c.settings -> 'voice_caps' ->> 'max_call_secs'   as max_call_secs,

  -- 4. STORE-BACKED CLIENTS NEED CREDENTIALS
  -- provisionVoice refuses when store_platform is set without a credentials ref.
  coalesce(c.store_platform, '(none)')        as store_platform,
  coalesce(c.store_credentials_ref, '(none)') as store_credentials_ref,

  -- 5. EXISTING BILLING STATE
  (select e.status from entitlements e
    where e.client_id = c.id and e.feature = 'voice') as voice_entitlement

from clients c
order by c.name;


-- =============================================================================
-- READ IT LIKE THIS
-- =============================================================================
-- login_accounts = 0        -> they cannot sign in, so they cannot check out.
--                              Have them sign up at /signup with the business
--                              name, or create the auth user first. A payment
--                              made without signing in has to be granted by hand.
--
-- phone_number = none       -> provisioning parks. Set a number before they buy,
--                              or accept a manual step after.
--
-- minutes_cap = 200         -> they will get double the Starter allowance.
--                              Fix before they buy:
--   update clients
--      set settings = coalesce(settings,'{}'::jsonb) || jsonb_build_object(
--            'voice_caps',
--            coalesce(settings->'voice_caps','{}'::jsonb)
--              || jsonb_build_object('monthly_minutes', 100, 'max_call_secs', 105))
--    where id = '<client id>';
--
-- max_call_secs > 105       -> 0027 was not applied, or this client has an
--                              explicit override. Calls get cut off mid-sentence.
--
-- store_platform set but
-- store_credentials_ref none-> provisioning parks with a credentials error.
--
-- voice_entitlement not null-> they already have one. Buying again is handled
--                              (0011 re-grants on a new subscription ref) but
--                              check it is what you expect first.
