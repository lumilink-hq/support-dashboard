-- =============================================================================
-- 0060 — seo_keywords.is_active: "stop tracking" a keyword without losing its
-- ranking history.
--
-- WHY. Keywords could only be managed in onboarding, where removing one was a
-- DELETE, and seo_rankings / seo_competitor_rankings / seo_rank_tasks all
-- reference seo_keywords ON DELETE CASCADE, so removing a keyword erased every
-- ranking ever recorded for it. The new Keywords card on /seo stops tracking
-- the same way competitors (0042's is_active) and AI questions (0053) do: turn
-- it off, keep the rows, and re-adding the same keyword turns it back on with
-- its history intact.
--
-- WHAT CHANGES
--   * seo_keywords.is_active (default true, so every existing keyword stays
--     tracked).
--   * Every view that decides what gets checked or reported now ignores
--     inactive keywords: seo_rank_submit_targets (0051), seo_keyword_gaps and
--     seo_content_targets (0056), seo_location_overview (0042). Same columns,
--     so CREATE OR REPLACE is enough; grants are re-stated per rule 4.
--   * The edge functions that read seo_keywords directly (seo-rank-tracking,
--     seo-report) filter on is_active in the same change. REDEPLOY BOTH after
--     applying this, with --no-verify-jwt.
--
-- No RLS change: seo_keywords_tenant (0042) already gives a tenant full CRUD
-- on its own rows, which covers updating is_active.
-- =============================================================================

alter table seo_keywords
  add column if not exists is_active boolean not null default true;

comment on column seo_keywords.is_active is
  'false = the client stopped tracking it. Kept (not deleted) so its rankings, '
  'which cascade on delete, stay in the history. Nothing checks or reports an '
  'inactive keyword.';

create index if not exists idx_seo_keywords_location_active
  on seo_keywords(location_id) where is_active;

-- -----------------------------------------------------------------------------
-- 0051: a location is only worth a rank submit if it has an ACTIVE keyword.
-- -----------------------------------------------------------------------------
create or replace view seo_rank_submit_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  ja.next_run_at,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from seo_locations l
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_rank_submit' and ja.entity_id = l.id
where l.is_active
  and exists (select 1 from seo_keywords k where k.location_id = l.id and k.is_active);

revoke all on seo_rank_submit_targets from authenticated, anon;
grant select on seo_rank_submit_targets to service_role;

-- -----------------------------------------------------------------------------
-- 0056: content gap analysis only considers active keywords.
-- -----------------------------------------------------------------------------
create or replace view seo_keyword_gaps with (security_invoker = true) as
select
  k.id            as keyword_id,
  k.client_id,
  k.location_id,
  k.keyword,
  own.position    as own_position,
  (own.check_date is not null) as has_rank_data,
  comp.best_position as best_competitor_position,
  coalesce(comp.ranking_count, 0) as competitors_ranking
from seo_keywords k
join seo_locations l on l.id = k.location_id and l.is_active and l.website_url is not null
left join lateral (
  select r.position, r.check_date
    from seo_rankings r
   where r.keyword_id = k.id and r.rank_type = 'organic'
   order by r.check_date desc
   limit 1
) own on true
left join lateral (
  select min(cr.position) as best_position,
         count(*) filter (where cr.position is not null) as ranking_count
    from seo_competitor_rankings cr
   where cr.keyword_id = k.id
     and cr.rank_type = 'organic'
     and cr.check_date = (
       select max(c2.check_date) from seo_competitor_rankings c2
        where c2.keyword_id = k.id and c2.rank_type = 'organic'
     )
) comp on true
where k.is_active;

revoke all on seo_keyword_gaps from authenticated, anon;
grant select on seo_keyword_gaps to service_role;

create or replace view seo_content_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_content' and ja.entity_id is null
where exists (select 1 from entitlements e where e.client_id = c.id and e.feature = 'seo' and e.status = 'active')
  and exists (
    select 1 from seo_locations l
     where l.client_id = c.id and l.is_active and l.website_url is not null
       and exists (select 1 from seo_keywords k where k.location_id = l.id and k.is_active)
  );

revoke all on seo_content_targets from authenticated, anon;
grant select on seo_content_targets to service_role;

-- -----------------------------------------------------------------------------
-- 0042: the overview counts only active keywords.
-- -----------------------------------------------------------------------------
create or replace view seo_location_overview with (security_invoker = true) as
select
  l.id                as location_id,
  l.client_id,
  l.name,
  count(distinct k.id)                                             as keyword_count,
  count(distinct k.id) filter (where k.is_geo_grid_enabled)        as geo_grid_keyword_count,
  count(distinct f.id) filter (where f.status = 'open')            as open_findings_count,
  count(distinct f.id) filter (where f.status = 'open'
                                 and f.severity = 'critical')       as critical_findings_count,
  count(distinct a.id) filter (where a.status = 'pending_approval') as pending_actions_count
from seo_locations l
left join seo_keywords k on k.location_id = l.id and k.is_active
left join seo_findings f on f.location_id = l.id
left join seo_actions  a on a.location_id = l.id
group by l.id, l.client_id, l.name;

revoke all on seo_location_overview from authenticated, anon;
grant select on seo_location_overview to authenticated, service_role;
