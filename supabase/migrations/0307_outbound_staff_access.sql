-- =============================================================================
-- 0307_outbound_staff_access.sql
-- Outbound engine (docs/OUTBOUND-PLAN.md): the staff access model, which 0300
-- left on hold until the loyalty branch's staff concept landed. It has (0206
-- platform_staff, 0210 MFA), so outbound adopts it instead of inventing one.
--
-- THE MODEL, SAME AS LOYALTY. Outbound is LumiLink's own sales pipeline, so
-- only LumiLink staff (platform_staff) see it, never a workspace role: a
-- client's own "admin" is not staff. Staff need an MFA-verified session
-- (aal2). Tables stay as 0300 left them, RLS on with NO policies and no
-- browser grants. The Phase 3 portal reads and writes through SECURITY
-- DEFINER RPCs that each start with outbound_require_staff(), so a bug in a
-- page can show an error, never data.
--
-- ONE RULE, ONE PLACE. outbound_require_staff() delegates to
-- loyalty_require_staff() rather than copying it, so a change to who counts
-- as staff (or the MFA rule) applies to both areas at once. Pages use
-- loyalty_staff_access() for the same reason (lib/staff-access.ts).
--
-- Adding staff: scripts/add-platform-staff.sql (it grants outbound too).
--
-- Test: scripts/test_outbound_staff_access.sql. Idempotent / safe to re-apply.
-- =============================================================================

-- outbound_require_staff — raises 'not_staff' or 'mfa_required' (42501)
-- unless the caller is staff on an aal2 session; returns their email.
-- Only for use inside SECURITY DEFINER RPCs: nobody can call it directly.
create or replace function outbound_require_staff()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select loyalty_require_staff();
$$;

revoke execute on function outbound_require_staff() from public, anon, authenticated;
