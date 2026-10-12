-- =============================================================================
-- 0089_gbp_description_only.sql — LumiLink stops editing Business Profile
-- categories. The description is the only profile field it writes.
--
-- WHY. 0081 let a client pick additional categories and seo-publish wrote
-- them. Google has no update mask for additional categories alone, so each
-- write sent the whole categories object back with the primary copied from a
-- read a moment earlier; the primary was only checked AFTER the write. And a
-- category change is the kind of edit Google can answer with re-verification
-- or a suspension review, which for a regulated business (PACKS) can take a
-- listing down. Decision (2026-10-12): don't edit anything that could put a
-- listing or its main details at risk.
--
-- WHAT THIS DOES
--   1. Cancels every category change that hasn't reached Google: draft,
--      pending_approval, approved, manual_required -> rejected, with a note.
--      In-flight rows ('publishing', 'rolling_back', 'rollback_requested')
--      are left alone: seo-publish (GBP_WRITABLE no longer lists
--      categories) refuses them without calling Google. A category change
--      that was already published stays on the profile; the owner can change
--      it on Google directly.
--   2. Allowlist CHECK back to gbp_description only. NOT VALID, so the
--      history rows for categories stay as they are; every new row is held
--      to it.
--   3. Drops propose_seo_gbp_categories (the picker's RPC). /seo Settings now
--      shows the categories read-only.
--
-- Pairs with: seo-publish (gbp.ts GBP_WRITABLE), redeployed with
-- --no-verify-jwt. Test: scripts/test_seo_gbp_write_path.sql.
-- Idempotent / safe to re-apply.
-- =============================================================================

update seo_actions
   set status = 'rejected',
       error  = 'LumiLink no longer edits Business Profile categories (0089). Change them on Google if needed.'
 where action_type = 'gbp_field_update'
   and target_field = 'gbp_additional_categories'
   and status in ('draft', 'pending_approval', 'approved', 'manual_required');

alter table seo_actions drop constraint if exists seo_actions_gbp_field_allowlist;
alter table seo_actions add constraint seo_actions_gbp_field_allowlist check (
  action_type <> 'gbp_field_update'
  or target_field = 'gbp_description'
) not valid;

drop function if exists propose_seo_gbp_categories(uuid, jsonb);

-- End of 0089.
