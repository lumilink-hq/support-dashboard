-- =============================================================================
-- 0070_seo_shared_websites.sql — module 29 (plan.md): audit a website ONCE when
-- several locations share it.
--
-- PACKS has four stores on one site. Until now the crawl, the technical audit
-- and link opportunities ran per location, so the same site was audited four
-- times (1,000 open findings, 419 distinct), every page fix was drafted up to
-- four times, each with one store's name on a page shared by all of them, and
-- the store-specific rules (LocalBusiness schema, phone) ran on the homepage
-- for every store.
--
-- From here:
--   * A website is its host without www. (seo_site_key). Of the active
--     locations of one client on one website, the oldest is the PRIMARY
--     (seo_site_locations). seo-crawl/stores.ts uses the same key and order.
--   * Only the primary is due for the site-wide jobs: seo_crawl,
--     seo_technical_audit and seo_link_opportunities. The edge functions
--     write each store page's findings to that store's own location, so
--     seo_draft_targets (driven by open findings) needs no change: the
--     primary drafts the site's pages, each store drafts its own page.
--   * Backlinks and competitor gaps already reuse a sibling's result
--     (0052/0063), so they stay per location.
--
-- ONE-TIME CLEANUP for websites shared by 2+ active locations: open findings
-- and drafts nobody has approved yet are deleted (the next crawl and drafting
-- run recreate them correctly), crawl state is cleared so the primary starts a
-- fresh run that includes every store page, and the primary's crawl and
-- technical audit are made due now. Approved, published and rejected work is
-- untouched. A single-location website is not touched at all.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The website key and the primary location
-- -----------------------------------------------------------------------------
create or replace function seo_site_key(p_url text)
returns text
language sql
immutable
as $$
  -- Host of an http(s) URL (a bare "acme.com" counts as one), lower-case,
  -- without userinfo, a leading www. or a default port. Null otherwise.
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          lower(split_part(split_part(split_part(
            regexp_replace(btrim(coalesce(p_url, '')), '^https?://', '', 'i'),
          '/', 1), '?', 1), '#', 1)),
        '^.*@', ''),
      '^www\.', ''),
    ':(80|443)$', ''),
  '')
  -- Any other scheme ("mailto:", "ftp://") isn't a website; "acme.com:8080"
  -- is a host and port, not a scheme.
  where btrim(coalesce(p_url, '')) !~* '^[a-z][a-z0-9+.-]*:[^0-9]' or btrim(p_url) ~* '^https?://';
$$;

comment on function seo_site_key(text) is
  'Module 29: the website a URL belongs to (host, no www., no default port). Mirrors siteKey() in supabase/functions/seo-crawl/stores.ts.';

-- security_invoker: a signed-in user sees only their own client's locations
-- (seo_locations' RLS), so the dashboard can read it too.
create or replace view seo_site_locations with (security_invoker = true) as
select
  l.id        as location_id,
  l.client_id,
  seo_site_key(l.website_url) as site_key,
  first_value(l.id) over w    as primary_location_id,
  (first_value(l.id) over w) = l.id as is_primary,
  count(*) over (partition by l.client_id, seo_site_key(l.website_url)) as site_location_count
from seo_locations l
where l.is_active
  and seo_site_key(l.website_url) is not null
window w as (partition by l.client_id, seo_site_key(l.website_url) order by l.created_at, l.id);

revoke all on seo_site_locations from anon;
grant select on seo_site_locations to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Site-wide jobs: only the primary is a target
--    (same columns as before, so create or replace is enough)
-- -----------------------------------------------------------------------------
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
  and l.website_url is not null;

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
  and l.website_url is not null;

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
  and l.website_url is not null;

revoke all on seo_crawl_targets from authenticated, anon;
grant select on seo_crawl_targets to service_role;
revoke all on seo_technical_audit_targets from authenticated, anon;
grant select on seo_technical_audit_targets to service_role;
revoke all on seo_link_opportunity_targets from authenticated, anon;
grant select on seo_link_opportunity_targets to service_role;

-- -----------------------------------------------------------------------------
-- 3. One-time cleanup of websites shared by 2+ active locations
-- -----------------------------------------------------------------------------
-- A function rather than a bare block so test_seo_shared_websites.sql can
-- exercise it; also safe to run again by hand (service role only), e.g. after
-- moving a location onto a website another location already uses.
create or replace function seo_reset_shared_websites()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_drafts   int;
  v_findings int;
  v_links    int;
  v_due      int;
begin
  create temp table if not exists _seo_shared (location_id uuid, client_id uuid, is_primary boolean) on commit drop;
  truncate _seo_shared;
  insert into _seo_shared
    select location_id, client_id, is_primary
      from seo_site_locations
     where site_location_count > 1;

  -- Page-fix drafts nobody has approved: wrong store name on shared pages,
  -- or one copy per store of the same fix.
  delete from seo_actions a
   using _seo_shared s
   where a.location_id = s.location_id
     and a.action_type = 'onpage_fix'
     and a.status in ('draft', 'pending_approval');
  get diagnostics v_drafts = row_count;

  -- Open findings, and findings marked actioned by a draft that's now gone.
  delete from seo_findings f
   using _seo_shared s
   where f.location_id = s.location_id
     and f.module in ('crawl', 'technical', 'backlinks')
     and (
       f.status = 'open'
       or (f.status = 'actioned' and not exists (select 1 from seo_actions a where a.finding_id = f.id))
     );
  get diagnostics v_findings = row_count;

  -- Crawl state: the primary starts over (now with the store pages), the
  -- others never crawl again.
  delete from seo_crawl_link_checks c using _seo_shared s where c.location_id = s.location_id;
  delete from seo_crawl_pages p using _seo_shared s where p.location_id = s.location_id;
  delete from seo_crawl_runs r using _seo_shared s where r.location_id = s.location_id;

  -- Link opportunities belong to the website; only the primary's are kept.
  delete from seo_link_opportunities o using _seo_shared s where o.location_id = s.location_id and not s.is_primary;
  get diagnostics v_links = row_count;

  update job_attempts ja
     set next_run_at = now()
    from _seo_shared s
   where s.is_primary
     and ja.entity_id = s.location_id
     and ja.client_id = s.client_id
     and ja.job_type in ('seo_crawl', 'seo_technical_audit')
     and ja.status <> 'running';
  get diagnostics v_due = row_count;

  return jsonb_build_object('drafts', v_drafts, 'findings', v_findings, 'link_rows', v_links, 'jobs_made_due', v_due);
end;
$$;

revoke execute on function seo_reset_shared_websites() from public, authenticated;
grant execute on function seo_reset_shared_websites() to service_role;

do $$
begin
  raise notice '0070: shared-website cleanup: %', seo_reset_shared_websites();
end;
$$;

-- SETUP AFTER APPLYING:
--   supabase functions deploy seo-crawl --no-verify-jwt
--   supabase functions deploy seo-technical-audit --no-verify-jwt
--   supabase functions deploy seo-draft --no-verify-jwt
--   supabase functions deploy seo-link-opportunities --no-verify-jwt
--   (all four import seo-crawl/stores.ts). The primary's crawl is due at once;
--   check it with:  select * from seo_site_locations;
--                   select * from seo_crawl_targets where is_due;

-- End of 0070.
