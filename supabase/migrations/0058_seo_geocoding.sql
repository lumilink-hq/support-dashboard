-- =============================================================================
-- 0058_seo_geocoding.sql — fills module 7's missing piece (plan.md: "the
-- wizard does not collect latitude/longitude and geocoding isn't built, so
-- there is no geo grid for a location until its lat/lng is filled in by
-- hand"). US only, via the free Census Bureau Geocoder (no vendor account, no
-- API key, no cost) — see supabase/functions/seo-geocode.
--
-- Scheduling only: no new table or columns. seo_locations.lat/lng (0042) are
-- the write target, filled ONLY when both are still null — never overwrites a
-- hand-entered or already-geocoded value. A location drops out of the
-- scheduling view the instant it has coordinates, whether the function set
-- them or a person did, so there is nothing to "turn off" once it succeeds.
--
-- Idempotent where practical so it can be re-applied in a fresh environment.
-- =============================================================================

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
  -- Census is US-only; the column is free text and optional (onboarding
  -- collects it as a plain 2-char field), so blank counts as domestic.
  and (l.country_code is null or upper(btrim(l.country_code)) in ('', 'US', 'USA'));

revoke all on seo_geocode_targets from authenticated, anon;
grant select on seo_geocode_targets to service_role;

create or replace function request_seo_geocode(p_location_id uuid)
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
    raise notice 'pg_net not installed — cannot request geocoding';
    return null;
  end if;

  if not start_job_attempt(v_client_id, 'seo_geocode', p_location_id) then
    return null;  -- not due yet, or already in flight
  end if;

  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'seo_geocode_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_geocode_url / voice_tool_secret not in Vault — cannot request geocoding';
    perform complete_job_attempt(v_client_id, 'seo_geocode', false, 'missing_vault_secret', 1440, 240, p_location_id);
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 20000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('location_id', p_location_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = v_client_id and job_type = 'seo_geocode' and entity_id = p_location_id;

  return v_req;
end;
$$;

revoke execute on function request_seo_geocode(uuid) from public, authenticated;
grant execute on function request_seo_geocode(uuid) to service_role;

create or replace function run_due_seo_geocodes(p_max_per_run int default 25)
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
    select location_id from seo_geocode_targets
     where is_due
     order by next_run_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_geocode(v_row.location_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;
  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_geocodes(int) from public, authenticated;
grant execute on function run_due_seo_geocodes(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic geocoding NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-geocode-due');
  exception when others then null;
  end;
  perform cron.schedule('seo-geocode-due', '10 * * * *', $cron$select run_due_seo_geocodes();$cron$);
end;
$$;

comment on view seo_geocode_targets is
  'Service-only scheduling view for seo-geocode. A location leaves this view the instant it has coordinates.';

-- End of 0058.
