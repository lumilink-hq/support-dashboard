-- =============================================================================
-- 0092_seo_billing_gate.sql
-- Scheduled SEO work only for clients who pay for SEO, and no more locations
-- than they pay for. Written 2026-10-15 for the public launch (2026-10-19).
--
-- WHY. Until now only seo_content_targets and seo_report_targets checked the
-- 'seo' entitlement. Every other *_targets view ran for any active location,
-- and onboarding saves locations BEFORE checkout, so a signup that never paid,
-- or a client who cancelled, kept spending DataForSEO / Anthropic / Google
-- quota for as long as the row existed.
--
-- 1. seo_billing_active(client): an 'seo' entitlement that is active or
--    past_due (past_due keeps working through Stripe's retry window; the
--    webhook moves it to canceled when Stripe gives up). Hand-granted trials
--    are status 'active', so PACKS and the LumiLink workspace keep running.
--    Every seo_*_targets view now requires it. One exception: rolling back a
--    change we already published stays allowed after cancelling, so a client
--    can always undo our edits to their site.
--
-- 2. Location cap. Once a client pays, a signed-in user can't add or
--    re-activate a location beyond seo_location_seat_limit(client):
--    greatest(seat_count, 1), since the Website plan bills 0 profile
--    locations but still needs one row for its website. NULL seat_count (a
--    hand grant with no count) and no paid entitlement (still onboarding)
--    mean no cap. The service role / SQL editor is not capped, so operators
--    can still set clients up by hand. The checkout route refuses to sell
--    fewer locations than are already active (app/api/billing/seo-checkout).
--
-- NOT HANDLED: a quantity cut in the Stripe customer portal leaves the extra
-- locations active. Keep "update quantity" off in the portal configuration.
--
-- When you next replace one of these views, copy its body from HERE, not from
-- the earlier migration, or the gate is lost. scripts/test_seo_billing_gate.sql
-- fails if any seo_%_targets view lets an unpaid client through.
--
-- Test: scripts/test_seo_billing_gate.sql. Idempotent / safe to re-apply.
-- =============================================================================

create or replace function seo_billing_active(p_client_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from entitlements e
     where e.client_id = p_client_id
       and e.feature = 'seo'
       and e.status in ('active', 'past_due')
  );
$$;

comment on function seo_billing_active(uuid) is
  'True when the client has an active or past_due seo entitlement. Every seo_*_targets view requires it (0092).';

revoke execute on function seo_billing_active(uuid) from public, anon;
grant execute on function seo_billing_active(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Location cap
-- -----------------------------------------------------------------------------

create or replace function seo_location_seat_limit(p_client_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select greatest(e.seat_count, 1)
    from entitlements e
   where e.client_id = p_client_id
     and e.feature = 'seo'
     and e.status in ('active', 'past_due')
     and e.seat_count is not null
   order by e.seat_count desc
   limit 1;
$$;

comment on function seo_location_seat_limit(uuid) is
  'Active locations a paying client may have: greatest(seat_count, 1). NULL = no cap (not paid yet, or a hand grant without a count). 0092.';

revoke execute on function seo_location_seat_limit(uuid) from public, anon;
grant execute on function seo_location_seat_limit(uuid) to authenticated, service_role;

create or replace function enforce_seo_location_seats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit  int;
  v_active int;
begin
  if not new.is_active then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.is_active and old.client_id = new.client_id then
    return new;
  end if;
  -- Operators (service role, SQL editor) have no auth.uid() and aren't capped.
  if auth.uid() is null then
    return new;
  end if;

  v_limit := seo_location_seat_limit(new.client_id);
  if v_limit is null then
    return new;
  end if;

  -- Serialise concurrent adds for the same client so two can't both squeeze
  -- into the last seat.
  perform 1 from clients where id = new.client_id for update;

  select count(*) into v_active
    from seo_locations
   where client_id = new.client_id and is_active and id <> new.id;

  if v_active >= v_limit then
    raise exception 'seo_location_limit'
      using errcode = 'P0001',
            detail = format('Your SEO plan covers %s location%s.', v_limit, case when v_limit = 1 then '' else 's' end),
            hint = 'Add locations to your plan on the Billing page first.';
  end if;
  return new;
end;
$$;

revoke execute on function enforce_seo_location_seats() from public, anon, authenticated;

drop trigger if exists seo_locations_enforce_seats on seo_locations;
create trigger seo_locations_enforce_seats
  before insert or update of is_active, client_id on seo_locations
  for each row execute function enforce_seo_location_seats();

-- -----------------------------------------------------------------------------
-- The gated views. Bodies are the latest definitions (migration noted on each)
-- plus "and seo_billing_active(...)". Column lists are unchanged.
-- -----------------------------------------------------------------------------

-- 0065
create or replace view seo_ai_responses_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_ai_responses' and ja.entity_id is null
where seo_billing_active(c.id)
  and exists (select 1 from seo_ai_queries q where q.client_id = c.id and q.is_active)
  and exists (
    select 1 from seo_locations l
     where l.client_id = c.id and l.is_active and l.website_url is not null
  );

-- 0053
create or replace view seo_ai_visibility_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_ai_visibility' and ja.entity_id is null
where seo_billing_active(c.id)
  and exists (select 1 from seo_ai_queries q where q.client_id = c.id and q.is_active)
  and exists (
    select 1 from seo_locations l
     where l.client_id = c.id and l.is_active and l.website_url is not null
  );

-- 0052
create or replace view seo_backlink_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  l.website_url,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from seo_locations l
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_backlinks' and ja.entity_id = l.id
where l.is_active
  and l.website_url is not null
  and seo_billing_active(l.client_id);

-- 0063
create or replace view seo_competitor_gap_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from seo_locations l
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_competitor_gaps' and ja.entity_id = l.id
where l.is_active
  and l.website_url is not null
  and exists (select 1 from seo_competitors c where c.location_id = l.id and c.is_active)
  and seo_billing_active(l.client_id);

-- 0060 (was: status = 'active' only; now the shared helper, so past_due too)
create or replace view seo_content_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_content' and ja.entity_id is null
where seo_billing_active(c.id)
  and exists (
    select 1 from seo_locations l
     where l.client_id = c.id and l.is_active and l.website_url is not null
       and exists (select 1 from seo_keywords k where k.location_id = l.id and k.is_active)
  );

-- 0070
create or replace view seo_crawl_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  l.website_url,
  l.last_crawled_at,
  l.crawl_status,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from seo_locations l
join seo_site_locations s on s.location_id = l.id and s.is_primary
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_crawl' and ja.entity_id = l.id
where l.is_active
  and l.website_url is not null
  and seo_billing_active(l.client_id);

-- 0071
create or replace view seo_detail_suggestion_targets with (security_invoker = true) as
select
  s.location_id,
  s.client_id,
  r.finished_at as crawl_finished_at,
  ja.next_run_at,
  ja.status as job_status,
  ((ja.next_run_at is null or ja.next_run_at <= now())
   and (ja.last_success_at is null or ja.last_success_at < r.finished_at)) as is_due
from seo_site_locations s
join seo_crawl_runs r
  on r.location_id = s.location_id and r.phase = 'done' and r.finished_at is not null
left join job_attempts ja
  on ja.client_id = s.client_id and ja.job_type = 'seo_detail_suggestions' and ja.entity_id = s.location_id
where s.is_primary
  and seo_billing_active(s.client_id);

-- 0091
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
  and seo_billing_active(l.client_id)
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

-- 0076
create or replace view seo_gbp_sync_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_gbp_sync' and ja.entity_id is null
where seo_billing_active(c.id)
  and exists (select 1 from seo_locations l where l.client_id = c.id and l.is_active);

-- 0058
create or replace view seo_geocode_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from seo_locations l
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_geocode' and ja.entity_id = l.id
where l.is_active
  and l.lat is null and l.lng is null
  and coalesce(l.address_line1, '') <> ''
  and coalesce(l.city, '') <> ''
  and coalesce(l.region, '') <> ''
  and (l.country_code is null or upper(btrim(l.country_code)) in ('', 'US', 'USA'))
  and seo_billing_active(l.client_id);

-- 0062
create or replace view seo_keyword_research_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_keyword_research' and ja.entity_id is null
where seo_billing_active(c.id)
  and exists (
    select 1 from seo_locations l
     where l.client_id = c.id and l.is_active and l.website_url is not null
       and (
         exists (select 1 from seo_keywords k where k.location_id = l.id and k.is_active)
         or nullif(btrim(l.search_console_site_url), '') is not null
       )
  );

-- 0070
create or replace view seo_link_opportunity_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from seo_locations l
join seo_site_locations s on s.location_id = l.id and s.is_primary
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_link_opportunities' and ja.entity_id = l.id
where l.is_active
  and l.website_url is not null
  and seo_billing_active(l.client_id);

-- 0060
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
  and exists (select 1 from seo_keywords k where k.location_id = l.id and k.is_active)
  and seo_billing_active(l.client_id);

-- 0057 (was: status = 'active' only; now the shared helper, so past_due too)
create or replace view seo_report_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  ((ja.next_run_at is null or ja.next_run_at <= now())
   and not exists (
     select 1 from seo_reports r
      where r.client_id = c.id
        and r.period_start = (date_trunc('month', now() at time zone 'utc') - interval '1 month')::date
        and r.email_status not in ('pending', 'failed')
   )) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_report' and ja.entity_id is null
where seo_billing_active(c.id)
  and exists (select 1 from seo_locations l where l.client_id = c.id and l.is_active);

-- 0061
create or replace view seo_search_console_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_search_console' and ja.entity_id is null
where seo_billing_active(c.id)
  and exists (
    select 1 from seo_locations l
     where l.client_id = c.id and l.is_active
       and nullif(btrim(l.search_console_site_url), '') is not null
  );

-- 0055. Publishing an approved change and the daily connection check need a
-- paying client; a rollback of something already published does not.
create or replace view seo_site_job_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  'publish'::text as task
from seo_locations l
where l.is_active
  and exists (
    select 1 from seo_actions a
     where a.location_id = l.id
       and (
         (seo_billing_active(l.client_id)
          and (a.status = 'approved'
               or (a.status = 'publishing' and a.updated_at < now() - interval '15 minutes')))
         or a.status = 'rollback_requested'
         or (a.status = 'rolling_back' and a.updated_at < now() - interval '15 minutes')
       )
  )
union all
select
  c.location_id,
  c.client_id,
  'check'::text as task
from seo_site_connections c
where (c.last_checked_at is null or c.last_checked_at < now() - interval '1 day')
  and seo_billing_active(c.client_id);

-- 0070
create or replace view seo_technical_audit_targets with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  l.website_url,
  l.search_console_site_url,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from seo_locations l
join seo_site_locations s on s.location_id = l.id and s.is_primary
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_technical_audit' and ja.entity_id = l.id
where l.is_active
  and l.website_url is not null
  and seo_billing_active(l.client_id);
