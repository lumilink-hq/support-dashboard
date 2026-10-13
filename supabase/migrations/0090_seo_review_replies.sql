-- =============================================================================
-- 0090_seo_review_replies.sql
-- Module 4 part 3 (plan.md): replies to Google reviews, drafted by seo-draft
-- (seo-draft/reviews.ts), approved on /seo-approvals, posted by seo-publish
-- (seo-publish/reviews.ts).
--
-- OFF BY DEFAULT. seo_client_settings.review_replies_enabled (false) gates
-- every step: this view only makes a location due when its client has it on,
-- seo-draft checks it again, and seo-publish refuses to post while it's off.
-- Decision 2026-10-13: built now, switched on per client from November 2026,
-- once the previous SEO team's offboarding is done. To switch on:
--   insert into seo_client_settings (client_id, review_replies_enabled)
--   select id, true from clients where slug = '<slug>'
--   on conflict (client_id) do update set review_replies_enabled = true;
-- The column is operator-set: seo_client_settings is tenant read-only (0061).
--
-- ROWS. A reply is seo_actions action_type 'review_reply', target_field
-- 'gbp_review_reply', resource_ref {account_name, location_name, review_id},
-- proposed_value {value: reply text, review: {stars, comment, created}}.
--   * 3-5 stars: model draft, status 'pending_approval'.
--   * 1-2 stars or no rating: status 'escalated', no draft; a person writes the
--     reply on /seo-approvals (which then counts as approved) or declines.
-- idempotency_key 'review-reply:<location>:<review>' is unique (0042), so a
-- review gets one reply action ever: a declined review is not re-asked.
--
-- RULE 2: a reply is not a profile field. 0079/0089's allowlist applies to
-- action_type 'gbp_field_update' only and is unchanged.
--
-- Test: scripts/test_seo_review_replies.sql. Idempotent / safe to re-apply.
-- =============================================================================

alter table seo_client_settings
  add column if not exists review_replies_enabled boolean not null default false;

-- The drafting schedule (last defined in 0079): also due when replies are on
-- for the client and a linked store has an unanswered review from the last 30
-- days (seo-draft/reviews.ts REPLY_WINDOW_DAYS) with no reply action yet.
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
  and (
    exists (
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
                or (f.module = 'gbp_profile' and a.target_field = 'gbp_description')
              )
              and (
                a.status in ('draft', 'pending_approval', 'approved', 'publishing', 'manual_required')
                or (a.status = 'published' and a.updated_at > now() - interval '14 days')
                or (a.status = 'rejected'  and a.updated_at > now() - interval '30 days')
              )
         )
    )
    -- 0090: review replies, only where the client has them switched on.
    or exists (
      select 1
        from seo_gbp_reviews r
        join seo_client_settings s on s.client_id = l.client_id and s.review_replies_enabled
       where r.location_id = l.id
         and r.reply_comment is null
         and r.created_at_google > now() - interval '30 days'
         and not exists (
           select 1 from seo_actions a
            where a.idempotency_key = 'review-reply:' || r.location_name || ':' || r.review_id
         )
    )
  );

revoke all on seo_draft_targets from authenticated, anon;
grant select on seo_draft_targets to service_role;

-- SETUP AFTER APPLYING: redeploy seo-draft and seo-publish (--no-verify-jwt).
-- Nothing runs until a client's review_replies_enabled is set to true.

-- End of 0090.
