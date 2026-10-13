-- =============================================================================
-- 0091_seo_gbp_posts.sql
-- Google Business Profile posts: drafted weekly by seo-draft
-- (seo-draft/posts.ts), approved on /seo-approvals, published by seo-publish
-- (seo-publish/posts.ts).
--
-- OFF BY DEFAULT. seo_client_settings.gbp_posts_enabled (false) gates
-- drafting (this view, and seo-draft again) and publishing. Decision
-- 2026-10-13: built now, switched on per client from November 2026, together
-- with review replies. Operator-set only (seo_client_settings is tenant
-- read-only, 0061):
--   insert into seo_client_settings (client_id, gbp_posts_enabled)
--   select id, true from clients where slug = '<slug>'
--   on conflict (client_id) do update set gbp_posts_enabled = true;
--
-- SAFE POSTS ONLY. A post is a plain text 'update' about the store, never a
-- product, price, deal or call to action: Google's restricted-content policy
-- forbids those for regulated goods (seo-draft/posts.ts).
--
-- ROWS: seo_actions action_type 'gbp_post', target_field 'gbp_post',
-- proposed_value {value: text, theme}, idempotency_key
-- 'gbp-post:<location>:w<week>' (one draft per store per week). The publish
-- result keeps the Google post's name for "Delete the post".
--
-- Test: scripts/test_seo_gbp_posts.sql. Idempotent / safe to re-apply.
-- =============================================================================

alter table seo_client_settings
  add column if not exists gbp_posts_enabled boolean not null default false;

-- The drafting schedule (last defined in 0090), plus a posts branch.
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
    -- 0091: Business Profile posts, only where the client has them switched
    -- on and the store is linked to a profile: one draft a week, and only
    -- once the last one has been dealt with.
    or (
      exists (select 1 from seo_client_settings s where s.client_id = l.client_id and s.gbp_posts_enabled)
      and exists (select 1 from seo_gbp_locations g where g.linked_location_id = l.id)
      and not exists (
        select 1 from seo_actions a
         where a.location_id = l.id and a.action_type = 'gbp_post'
           and (a.created_at > now() - interval '7 days'
                or a.status in ('draft', 'pending_approval', 'approved', 'publishing', 'manual_required'))
      )
    )
  );

revoke all on seo_draft_targets from authenticated, anon;
grant select on seo_draft_targets to service_role;

-- SETUP AFTER APPLYING: redeploy seo-draft and seo-publish (--no-verify-jwt).
-- Nothing runs until a client's gbp_posts_enabled is set to true.

-- End of 0091.
