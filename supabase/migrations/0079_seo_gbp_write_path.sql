-- =============================================================================
-- 0079_seo_gbp_write_path.sql
-- Module 4 (plan.md, Phase 4): approved edits to a Google Business Profile.
-- First field: the business description, drafted by seo-draft (seo-draft/gbp.ts),
-- approved on /seo-approvals, written by seo-publish (seo-publish/gbp.ts).
--
-- 1. RULE 2 AT THE DATABASE. 0042 already refuses target_field name / address /
--    phone / primary_category. A profile edit ('gbp_field_update') may now ONLY
--    target the fields in this allowlist, the same list as GBP_WRITABLE in
--    seo-publish/gbp.ts. Adding a field means changing both, on purpose.
--
-- 2. DRAFTING SCHEDULE. seo_draft_targets (last defined in 0064) also treats a
--    location as due when an open 'gbp_profile' finding a description draft
--    answers has no live draft. Same "don't draft again" windows as page fixes:
--    a live or in-flight draft, a publish in the last 14 days, a rejection in
--    the last 30.
--
-- Nothing else changes: approved actions are already picked up per location by
-- seo_site_job_targets (0055) for 'publish', whatever their action_type, and
-- seo-publish routes 'gbp_field_update' to the Google adapter.
--
-- Test: scripts/test_seo_gbp_write_path.sql. Idempotent / safe to re-apply.
-- =============================================================================

alter table seo_actions drop constraint if exists seo_actions_gbp_field_allowlist;
alter table seo_actions add constraint seo_actions_gbp_field_allowlist check (
  action_type <> 'gbp_field_update'
  or target_field in ('gbp_description')
);

create or replace view seo_draft_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from seo_locations l
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_draft' and ja.entity_id = l.id
where l.is_active
  and exists (
    select 1
      from seo_findings f
     where f.location_id = l.id
       and f.status = 'open'
       and (
         (f.module = 'crawl' and f.finding_type in (
           'missing_title', 'title_length',
           'missing_meta_description', 'meta_description_length',
           'missing_h1',
           'missing_local_business_schema',
           'duplicate_title', 'duplicate_meta_description'
         ))
         -- 0079: Business Profile description (seo-draft/gbp.ts GBP_DRAFTABLE).
         or (f.module = 'gbp_profile' and f.finding_type in (
           'gbp_missing_description', 'gbp_short_description'
         ))
       )
       and not exists (
         select 1
           from seo_actions a
          where a.location_id = f.location_id
            and coalesce(a.target_url, '') = coalesce(f.target_url, '')
            and (
              a.finding_type = f.finding_type
              -- Either description finding is answered by any description draft.
              or (f.module = 'gbp_profile' and a.target_field = 'gbp_description')
            )
            and (
              a.status in ('draft', 'pending_approval', 'approved', 'publishing', 'manual_required')
              or (a.status = 'published' and a.updated_at > now() - interval '14 days')
              or (a.status = 'rejected'  and a.updated_at > now() - interval '30 days')
            )
       )
  );

revoke all on seo_draft_targets from authenticated, anon;
grant select on seo_draft_targets to service_role;

-- SETUP AFTER APPLYING: redeploy seo-draft and seo-publish (--no-verify-jwt).
-- The Google connection needs business.manage (Settings > Connect Google).

-- End of 0079.
