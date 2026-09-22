-- =============================================================================
-- 0050_seo_technical_audit.sql
-- Module 17 (plan.md): technical SEO audit — PageSpeed Insights, Search
-- Console URL Inspection, status/redirect/robots/sitemap checks. Weekly, per
-- location, on the same job_attempts + vendor_budgets shared layer 0049
-- built for module 6 (no further schema widening needed — this is the payoff
-- of that work).
--
-- MANUAL ACTIONS IS NOT BUILT. Plan.md's module 17 also lists "monthly check
-- for manual actions" — checked developers.google.com before writing any
-- code (see supabase/functions/seo-technical-audit/lib.ts's header): the
-- Search Console API only exposes Search Analytics, Sitemaps, Sites and URL
-- Inspection. There is no Manual Actions resource in the public API — that
-- report is Search-Console-UI-only. Nothing here fakes an endpoint that
-- doesn't exist; this is a real gap for module 13's report to carry as an
-- explicit "check Search Console by hand monthly" reminder, not a silent one.
--
-- SEARCH CONSOLE PROPERTY MATCHING. URL Inspection needs a `siteUrl` — the
-- verified Search Console PROPERTY, which is account-wide and can be a
-- domain property (sc-domain:example.com) or a URL-prefix property
-- (https://example.com/), neither of which is reliably derivable from
-- seo_locations.website_url alone. search_console_site_url lets a human
-- (or a future auto-match against the Sites API) pin the right one;
-- left null, the edge function skips URL Inspection for that location
-- rather than guessing.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

alter table seo_locations
  add column if not exists search_console_site_url text;

comment on column seo_locations.search_console_site_url is
  'The verified Search Console property to run URL Inspection against — '
  '"https://example.com/" (URL-prefix) or "sc-domain:example.com" (domain '
  'property). NULL means URL Inspection is skipped for this location (module '
  '17); nothing auto-guesses this today.';

-- PageSpeed Insights uses a plain API key (Deno.env's PAGESPEED_API_KEY on
-- the edge function), separate from the OAuth-based 'google' budget in 0048
-- — Google meters the two independently, so conflating them would let one
-- exhaust budget the other still has headroom for.
insert into vendor_budgets (vendor, max_requests, window_seconds, note) values
  ('google_pagespeed', 25, 60, 'PageSpeed Insights API default quota is 25000/day; this is a conservative per-minute placeholder, tune once real usage exists.')
on conflict (vendor) do nothing;

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
left join job_attempts ja
  on ja.client_id = l.client_id and ja.job_type = 'seo_technical_audit' and ja.entity_id = l.id
where l.is_active
  and l.website_url is not null;

revoke all on seo_technical_audit_targets from authenticated, anon;
grant select on seo_technical_audit_targets to service_role;

create or replace function request_seo_technical_audit(p_location_id uuid)
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
    raise notice 'pg_net not installed — cannot request a technical audit';
    return null;
  end if;

  if not start_job_attempt(v_client_id, 'seo_technical_audit', p_location_id) then
    return null;  -- not due yet, or already in flight
  end if;

  -- No vendor-budget check here for the DISPATCH itself: the budget that
  -- matters (google_pagespeed, and the OAuth-based 'google' budget for URL
  -- Inspection) is spent INSIDE the edge function per external call, not per
  -- dispatch — a location can need zero, one or two vendor calls depending
  -- on whether search_console_site_url is set.

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_technical_audit_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_technical_audit_url / voice_tool_secret not in Vault — cannot request an audit';
    perform complete_job_attempt(v_client_id, 'seo_technical_audit', false, 'missing_vault_secret',
                                  10080, 1440, p_location_id);
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
   where client_id = v_client_id and job_type = 'seo_technical_audit' and entity_id = p_location_id;

  return v_req;
end;
$$;

revoke execute on function request_seo_technical_audit(uuid) from public, authenticated;
grant execute on function request_seo_technical_audit(uuid) to service_role;

create or replace function run_due_seo_technical_audits(p_max_per_run int default 25)
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
    select location_id from seo_technical_audit_targets
     where is_due
     order by next_run_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_technical_audit(v_row.location_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_technical_audits(int) from public, authenticated;
grant execute on function run_due_seo_technical_audits(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic technical audit NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-technical-audit-due');
  exception when others then null;
  end;
  -- Weekly, per plan.md's §4 scheduled-jobs table ("Site crawl + technical
  -- audit | Weekly, per site") — same hourly-tick-weekly-interval shape as
  -- seo-crawl's own schedule, for the same reason (a client added mid-week
  -- is picked up within the hour, not stuck waiting for a fixed weekly slot).
  perform cron.schedule('seo-technical-audit-due', '20 * * * *',
    $cron$select run_due_seo_technical_audits();$cron$);
end;
$$;

-- SETUP AFTER APPLYING (once per project):
--   1. supabase secrets set PAGESPEED_API_KEY=<key>   -- edge function env,
--      NOT Vault: this key is only ever used inside the edge function, never
--      read by the database dispatch layer, unlike the URL/shared-secret
--      pair below.
--   2. select vault.create_secret(
--        'https://<ref>.functions.supabase.co/seo-technical-audit',
--        'seo_technical_audit_url', '');
--   3. Deploy with --no-verify-jwt (see google-token-refresh/seo-crawl for
--      why — every admin/scheduled function in this project needs this flag,
--      the deploy succeeds either way but every dispatch silently 401s
--      without it).
-- Then verify with:  select * from seo_technical_audit_targets;
--                    select run_due_seo_technical_audits();

-- End of 0050.
