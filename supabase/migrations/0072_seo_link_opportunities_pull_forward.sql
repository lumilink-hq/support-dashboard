-- =============================================================================
-- 0072_seo_link_opportunities_pull_forward.sql
-- Module 26 (plan.md): run link opportunities soon after a competitor is added,
-- instead of waiting up to a month.
--
-- WHY. 0066 runs the link job monthly. Module 23's competitor gaps already pull
-- a location forward when a new competitor appears (0063), so a client who adds
-- competitors sees new gaps within the hour but an empty link list for up to
-- 30 days. Found on LumiLink's own workspace 2026-10-08: four competitors added
-- at 22:2x UTC, gaps at 22:58, link opportunities not due until 2026-11-01.
--
-- RULE. At each :48 tick, before dispatching, a link job is moved to now() when
-- ALL of these hold:
--   * it belongs to a website's PRIMARY location (0070: only the primary runs
--     the site-wide link job, reading every location-on-the-site's competitors);
--   * it is idle, not backing off (attempt_count = 0), and not already due;
--   * its last run was more than 6 hours ago (same guard as 0063);
--   * the website has 2+ active competitors (the gap part needs a pair);
--   * one of those competitors was created after the last run.
-- The run itself sets last_run_at past every existing competitor's created_at,
-- so a location is pulled forward once per batch of additions, not every hour.
--
-- KNOWN GAP. seo_competitors has no updated_at, so switching an old competitor
-- back on (is_active false -> true) doesn't count as new. Re-adding one through
-- the dashboard reactivates the existing row, so that case waits for the
-- monthly run.
--
-- Test: scripts/test_seo_link_pull_forward.sql. Idempotent / safe to re-apply.
-- =============================================================================

create or replace function run_due_seo_link_opportunities(p_max_per_run int default 25)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row       record;
  v_requested int := 0;
  v_skipped   int := 0;
  v_pulled    int := 0;
begin
  update job_attempts ja
     set next_run_at = now()
    from seo_site_locations p
   where ja.job_type = 'seo_link_opportunities'
     and ja.entity_id = p.location_id
     and ja.client_id = p.client_id
     and p.is_primary
     and ja.status = 'idle'
     and ja.attempt_count = 0
     and ja.next_run_at > now()
     and ja.last_run_at < now() - interval '6 hours'
     and (
       select count(distinct lower(c.domain))
         from seo_competitors c
         join seo_site_locations s on s.location_id = c.location_id
        where s.client_id = p.client_id and s.site_key = p.site_key and c.is_active
     ) >= 2
     and exists (
       select 1
         from seo_competitors c
         join seo_site_locations s on s.location_id = c.location_id
        where s.client_id = p.client_id and s.site_key = p.site_key
          and c.is_active
          and c.created_at > ja.last_run_at
     );
  get diagnostics v_pulled = row_count;

  for v_row in
    select location_id from seo_link_opportunity_targets
     where is_due
     order by next_run_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_link_opportunities(v_row.location_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'pulled_forward', v_pulled, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_link_opportunities(int) from public, authenticated;
grant execute on function run_due_seo_link_opportunities(int) to service_role;

-- End of 0072.
