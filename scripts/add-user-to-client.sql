-- =============================================================================
-- add-user-to-client.sql — give someone a login on an EXISTING client.
--
-- Supabase Dashboard -> SQL Editor. Run the steps in order.
--
-- WHY THIS IS NOT JUST "SIGN UP". The handle_new_user trigger (0004) fires on
-- every new auth user and ALWAYS creates a fresh client:
--
--     insert into public.clients (name, slug) values (v_business, v_slug)
--     returning id into v_client_id;
--
-- There is no branch that joins an existing tenant. So signing up with the
-- business name "Bud Club" produces a SECOND client with slug 'bud-club',
-- separate from 'budmember001', with its own empty orders and settings. The
-- person then logs into a workspace that looks broken, and the real one still
-- has nobody who can reach it.
--
-- The trigger's one escape hatch is at the top:
--
--     if exists (select 1 from public.users where id = new.id) then return new;
--
-- which cannot help here, because public.users.id is a foreign key to
-- auth.users — the row cannot exist before the auth user does.
--
-- So the working sequence is: let the trigger do its thing, then repoint the
-- user at the real client and remove the tenant it made.
-- =============================================================================


-- =============================================================================
-- STEP 1 — create the auth user (Dashboard, not SQL)
-- =============================================================================
-- Authentication -> Users -> Add user.
--   * "Auto Confirm User" ON, unless you want them to get a confirmation email
--     (which needs custom SMTP configured, see docs/launch-readiness.md).
--   * Do NOT bother setting user metadata; the client it creates is discarded.
--
-- Then copy the new user's UUID.


-- =============================================================================
-- STEP 2 — see what the trigger did
-- =============================================================================
-- Replace the UUID throughout. The stray client is the one you are about to
-- delete, so look at it before you do.
select u.id            as auth_user_id,
       u.email,
       u.role,
       u.client_id     as stray_client_id,
       c.slug          as stray_slug,
       c.name          as stray_name,
       c.created_at
  from users u
  join clients c on c.id = u.client_id
 where u.id = '00000000-0000-0000-0000-000000000000';


-- =============================================================================
-- STEP 3 — confirm the stray tenant is genuinely empty
-- =============================================================================
-- It should be seconds old with nothing attached. If any count is non-zero you
-- have the wrong id: STOP, because step 5 cascades.
select
  (select count(*) from conversations      where client_id = '<stray_client_id>') as conversations,
  (select count(*) from orders_cache       where client_id = '<stray_client_id>') as orders,
  (select count(*) from entitlements       where client_id = '<stray_client_id>') as entitlements,
  (select count(*) from users              where client_id = '<stray_client_id>') as users;


-- =============================================================================
-- STEP 4 — repoint the user at the real client
-- =============================================================================
-- role is user_role_t: 'admin' | 'agent' | 'viewer'.
--   admin  — can edit Settings (updateClientSettings refuses anyone else)
--   agent  — day-to-day use, no settings
--   viewer — read only
update users
   set client_id = (select id from clients where slug = 'budmember001'),
       role      = 'admin'
 where id = '00000000-0000-0000-0000-000000000000';


-- =============================================================================
-- STEP 5 — delete the stray client
-- =============================================================================
-- Only after step 4. Deleting first would cascade the users row away with it,
-- because users.client_id is ON DELETE CASCADE — and then the auth user exists
-- with no public.users row at all, which means current_client_id() returns null
-- and every RLS policy denies them everything. They can sign in and see nothing.
delete from clients
 where id = '<stray_client_id>'
   and not exists (select 1 from users where client_id = '<stray_client_id>');


-- =============================================================================
-- STEP 6 — verify
-- =============================================================================
select u.email, u.role, c.slug, c.name
  from users u join clients c on c.id = u.client_id
 where c.slug = 'budmember001';

-- Then have them sign in at /login. current_client_id() resolves from
-- public.users, so RLS scopes them to Bud Club immediately — no redeploy, no
-- cache to clear.


-- =============================================================================
-- WORTH FIXING PROPERLY AT SOME POINT
-- =============================================================================
-- There is no way to invite a teammate to an existing workspace. Every signup
-- is a new tenant, so a second person at the same business either does this
-- dance or shares one login.
--
-- The shape of the fix: an invite token carrying client_id, and a branch in
-- handle_new_user that joins that client instead of creating one when the
-- token is present in raw_user_meta_data. Small change to the trigger, plus an
-- invite screen. Worth doing before any client has more than one employee.
