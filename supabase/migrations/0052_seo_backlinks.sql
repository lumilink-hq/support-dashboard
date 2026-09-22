-- =============================================================================
-- 0052_seo_backlinks.sql
-- Module 15 (plan.md): monthly backlink profile per location — referring
-- domains, total backlinks, gained/lost links for the last complete month, and
-- top linked pages — from DataForSEO's Backlinks API into seo_backlink_snapshots
-- (0042). Scheduling reuses the job_attempts + vendor_budgets layer exactly as
-- 0050 does; nothing new is needed in the schema itself.
--
-- MONTHLY, NOT WEEKLY. plan.md §4 lists the backlink pull as monthly. The
-- hourly cron tick is the same shape as the other SEO jobs (a location added
-- mid-month is picked up within the hour); the 30-day interval is set by the
-- edge function when it completes a run.
--
-- DATAFORSEO BACKLINKS MAY NEED ITS OWN SUBSCRIPTION. DataForSEO's pricing
-- page describes pay-as-you-go, but the Backlinks Summary endpoint's own docs
-- say "Subscription access required". Not settled from docs alone, so the
-- edge function treats an access-denied response as a distinct, clearly
-- labelled failure (job_attempts.last_error = 'dataforseo_backlinks_not_subscribed')
-- rather than a generic one. It shares the existing 'dataforseo' vendor budget.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

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
  and l.website_url is not null;

revoke all on seo_backlink_targets from authenticated, anon;
grant select on seo_backlink_targets to service_role;

create or replace function request_seo_backlinks(p_location_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client_id uuid;
  v_url    text;
  v_secret text;
  v_req    bigint;
begin
  select client_id into v_client_id from seo_locations where id = p_location_id;
  if v_client_id is null then
    return null;
  end if;

  if to_regproc('net.http_post') is null then
    raise notice 'pg_net not installed — cannot request a backlink pull';
    return null;
  end if;

  if not start_job_attempt(v_client_id, 'seo_backlinks', p_location_id) then
    return null;  -- not due yet, or already in flight
  end if;

  -- Vendor budget is reserved INSIDE the edge function, per DataForSEO call
  -- (three per location), not per dispatch.

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_backlinks_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_backlinks_url / voice_tool_secret not in Vault — cannot request a backlink pull';
    perform complete_job_attempt(v_client_id, 'seo_backlinks', false, 'missing_vault_secret',
                                  43200, 1440, p_location_id);
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 60000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('location_id', p_location_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = v_client_id and job_type = 'seo_backlinks' and entity_id = p_location_id;

  return v_req;
end;
$$;

revoke execute on function request_seo_backlinks(uuid) from public, authenticated;
grant execute on function request_seo_backlinks(uuid) to service_role;

create or replace function run_due_seo_backlinks(p_max_per_run int default 25)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row       record;
  v_requested int := 0;
  v_skipped   int := 0;
begin
  for v_row in
    select location_id from seo_backlink_targets
     where is_due
     order by next_run_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_backlinks(v_row.location_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_backlinks(int) from public, authenticated;
grant execute on function run_due_seo_backlinks(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic backlink pull NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-backlinks-due');
  exception when others then null;
  end;
  -- Hourly tick at :50 (crawl :00, technical audit :20, rank submit :40);
  -- each location only actually runs once per 30 days.
  perform cron.schedule('seo-backlinks-due', '50 * * * *',
    $cron$select run_due_seo_backlinks();$cron$);
end;
$$;

-- SETUP AFTER APPLYING (once per project):
--   1. DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are already set (module 7).
--   2. select vault.create_secret(
--        'https://<ref>.functions.supabase.co/seo-backlinks',
--        'seo_backlinks_url', '');
--   3. Deploy with --no-verify-jwt.
-- Then verify with:  select * from seo_backlink_targets;
--                    select run_due_seo_backlinks();

-- End of 0052.
