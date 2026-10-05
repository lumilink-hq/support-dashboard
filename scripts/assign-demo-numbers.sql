-- =============================================================================
-- assign-demo-numbers.sql — give each demo vertical its own dialable line.
--
-- Run this in the SAME change as the lib/demo.ts edit. The page printing a
-- number and the database resolving it are two halves of one fact; ship one
-- without the other and a caller hears "This phone line isn't configured for a
-- store."
--
--   ecommerce  (213) 261-0528  +12132610528  ->  northlake-demo
--   service    (213) 787-1585  +12137871585  ->  comfort-air-demo
--
-- WHAT THIS REPLACES:
--   • comfort-air-demo held +14155550123 — a reserved 555 number that cannot be
--     dialled, so the HVAC demo had no working phone path at all.
--   • /demo/hvac advertised +12135332469, which belongs to TSUNAMI. Public demo
--     traffic was landing on a paying client's line. Nothing in the database
--     caused that and nothing in the database fixes it — see lib/demo.ts — but
--     it is the reason this script exists, so it is recorded here.
--
-- ORDER MATTERS (PROJECT-STATUS gotcha 7). clients.phone_number carries a
-- unique index and resolve_client_by_number filters on is_active. Assigning a
-- number still held by another row fails with a unique violation, so every
-- reassignment nulls the previous holder first, in one transaction.
-- =============================================================================

-- PREREQUISITE — RUN THE SEEDS FIRST. Both demo tenants are created by seed
-- files, not by a migration, so a fresh or partially-seeded database has one or
-- neither of them:
--
--   psql "$DATABASE_URL" -f supabase/seed/demo_orders_client.sql  -- northlake-demo
--   psql "$DATABASE_URL" -f supabase/seed_hvac_client.sql         -- comfort-air-demo
--
-- Note the paths differ: the HVAC seed sits at supabase/ root, the orders seed
-- in supabase/seed/. Both are idempotent on the slug, so re-running is safe.

begin;

-- 0) FAIL LOUDLY IF A TENANT IS MISSING.
--
--    Without this the UPDATEs below simply match zero rows and the script
--    reports success. You would then deploy a page printing a number that
--    resolves to nothing, and the first person to call it hears "This phone
--    line isn't configured for a store." An UPDATE that matches nothing is the
--    single most common silent failure in this repo's history — make it an
--    error instead.
do $$
declare
  missing text;
begin
  select string_agg(s, ', ')
    into missing
    from unnest(array['northlake-demo', 'comfort-air-demo']) as s
   where not exists (select 1 from clients where slug = s);

  if missing is not null then
    raise exception
      'Demo tenant(s) missing: %. Run the seed files listed at the top of this script first.',
      missing;
  end if;
end $$;

-- 1) Release any row currently holding either number, whoever it is. No-op on a
--    clean database; the point is that re-running this script is safe.
update clients
   set phone_number = null
 where phone_number in ('+12132610528', '+12137871585')
   and slug not in ('northlake-demo', 'comfort-air-demo');

-- 2) Assign.
update clients
   set phone_number = '+12132610528'
 where slug = 'northlake-demo';

update clients
   set phone_number = '+12137871585'
 where slug = 'comfort-air-demo';

-- 3) Cap them. THIS IS THE PART NOT TO SKIP.
--
--    A demo line is a phone number printed on a public page: it will be dialled
--    by strangers, by bots, and by anyone who finds the page. The CFO model
--    budgets 200 demo minutes a month across ONE demo number; there are two now,
--    so each gets half rather than the budget being quietly doubled.
--
--    max_call_secs 105 matches every other tenant — below the 120s ElevenLabs
--    hard cut, so the agent closes the call itself instead of being severed.
--
--    jsonb || merges, so this preserves any other settings key.
update clients
   set settings = coalesce(settings, '{}'::jsonb)
                  || jsonb_build_object(
                       'voice_caps',
                       coalesce(settings -> 'voice_caps', '{}'::jsonb)
                       || jsonb_build_object(
                            'monthly_minutes', 100,
                            'max_call_secs', 105
                          )
                     )
 where slug in ('northlake-demo', 'comfort-air-demo');

-- 4) Both must be active AND demo-flagged. is_demo is what lets the browser
--    widget resolve them by slug (voice-order-lookup §1, web path); is_active is
--    what lets resolve_client_by_number return them at all. A demo that is one
--    but not the other half-works, which is worse than not working.
update clients
   set is_active = true,
       settings = coalesce(settings, '{}'::jsonb)
                  || jsonb_build_object('is_demo', true)
 where slug in ('northlake-demo', 'comfort-air-demo');

commit;

-- -----------------------------------------------------------------------------
-- VERIFY. Every row must come back populated, and the two numbers must differ.
-- -----------------------------------------------------------------------------
select slug,
       phone_number,
       is_active,
       settings ->> 'is_demo'                            as is_demo,
       settings -> 'voice_caps' ->> 'monthly_minutes'    as minutes,
       settings -> 'voice_caps' ->> 'max_call_secs'      as max_call_secs
  from clients
 where slug in ('northlake-demo', 'comfort-air-demo')
 order by slug;

-- The routing check that actually matters — each number must resolve to the
-- tenant whose demo page prints it:
select 'ecommerce' as vertical,
       resolve_client_by_number('+12132610528') = (select id from clients where slug = 'northlake-demo')   as routes_correctly
union all
select 'service',
       resolve_client_by_number('+12137871585') = (select id from clients where slug = 'comfort-air-demo');

-- And the one that stops the old bug coming back: no demo page number may
-- resolve to a paying client.
select slug, phone_number
  from clients
 where phone_number in ('+12132610528', '+12137871585')
   and coalesce(settings ->> 'is_demo', 'false') <> 'true';
-- Expect ZERO rows.
