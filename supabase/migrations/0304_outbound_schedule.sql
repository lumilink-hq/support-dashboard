-- =============================================================================
-- 0304_outbound_schedule.sql
-- Outbound engine (docs/OUTBOUND-PLAN.md), Phase 1 step 5: run the lead
-- pipeline on its own. Same pg_cron -> pg_net -> edge function shape as every
-- other scheduled job (0023, 0046, 0068).
--
--   outbound-source  daily at 14:00 UTC   (the function itself also skips a
--                                          profile sourced in the last 20h,
--                                          exhausted, or backlogged)
--   outbound-enrich  every 10 minutes     (batch of 10 'sourced' leads)
--   outbound-verify  every 10 minutes, offset by 5 (batch of 10 'email_found')
--
-- ONLY WHEN THERE'S WORK. request_outbound_job() checks the database before
-- calling the function: an active profile for source, unclaimed 'sourced'
-- leads for enrich, unclaimed 'email_found' leads for verify. With no active
-- profile nothing is ever bought and nothing is called, so this is safe to
-- apply before Phase 0 (accounts, keys) is done. Making a profile active is
-- the switch.
--
-- VAULT. Each job reads its function URL plus the shared voice_tool_secret:
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/outbound-source', 'outbound_source_url', '');
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/outbound-enrich', 'outbound_enrich_url', '');
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/outbound-verify', 'outbound_verify_url', '');
-- A missing secret means a notice and no call, never an error.
--
-- NOT DONE HERE: adding these three secrets and cron jobs to
-- system_health_snapshot() (0068). That function belongs to main; editing it
-- from this branch would conflict with main's own changes. Do it in a main
-- migration once this branch merges (docs/OUTBOUND-MIGRATIONS.md).
--
-- Service-role only. Test: scripts/test_outbound_schedule.sql.
-- Idempotent / safe to re-apply.
-- =============================================================================

create or replace function request_outbound_job(p_job text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url    text;
  v_secret text;
  v_req    bigint;
  v_work   boolean;
begin
  if p_job not in ('source', 'enrich', 'verify') then
    raise exception 'request_outbound_job: unknown job %', p_job;
  end if;

  v_work := case p_job
    when 'source' then exists (select 1 from outbound_profiles where status = 'active')
    when 'enrich' then exists (select 1 from outbound_leads
                                where stage = 'sourced' and (claimed_until is null or claimed_until < now()))
    when 'verify' then exists (select 1 from outbound_leads
                                where stage = 'email_found' and (claimed_until is null or claimed_until < now()))
  end;
  if not v_work then
    return null;
  end if;

  if to_regproc('net.http_post') is null then
    raise notice 'pg_net not installed — cannot request outbound-%', p_job;
    return null;
  end if;

  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'outbound_' || p_job || '_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'voice_tool_secret';
  if v_url is null or v_secret is null then
    raise notice 'outbound_%_url / voice_tool_secret not in Vault — cannot request outbound-%', p_job, p_job;
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 150000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      '{}'::jsonb;
  return v_req;
end;
$$;

revoke all on function request_outbound_job(text) from public, anon, authenticated;
grant execute on function request_outbound_job(text) to service_role;


do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — the outbound jobs are NOT scheduled.';
    return;
  end if;
  begin perform cron.unschedule('outbound-source-daily'); exception when others then null; end;
  begin perform cron.unschedule('outbound-enrich-due');   exception when others then null; end;
  begin perform cron.unschedule('outbound-verify-due');   exception when others then null; end;
  perform cron.schedule('outbound-source-daily', '0 14 * * *',     $cron$select request_outbound_job('source');$cron$);
  perform cron.schedule('outbound-enrich-due',   '*/10 * * * *',   $cron$select request_outbound_job('enrich');$cron$);
  perform cron.schedule('outbound-verify-due',   '5-59/10 * * * *', $cron$select request_outbound_job('verify');$cron$);
end $$;
