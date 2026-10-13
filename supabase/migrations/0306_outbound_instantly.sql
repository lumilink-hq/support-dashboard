-- =============================================================================
-- 0306_outbound_instantly.sql
-- Outbound engine (docs/OUTBOUND-PLAN.md), Phase 2: what outbound-instantly
-- needs from the database to push verified leads into Instantly campaigns,
-- follow them there, and take finished ones back out.
--
--   outbound_claim_pushable(profile, limit)  verified, unsuppressed leads not
--       yet in Instantly, valid addresses before catch-all/unknown ones,
--       oldest first; leased like outbound_claim_leads (0302).
--   outbound_pushed_today(profile)            leads that reached 'queued'
--       today (UTC), so a profile never exceeds its daily_lead_target.
--   outbound_in_instantly()                  leads currently held in
--       Instantly. Instantly's uploaded-contacts limit is a running total
--       (1,000 on Growth) that only deleting frees, so the push stops short
--       of it and cleanup deletes finished leads.
--   outbound_suppress_lead(lead, reason, source, note)  unsubscribes,
--       bounces and complaints: the address goes on the suppression list and
--       the lead moves to 'suppressed', with an event.
--
-- request_outbound_job (0304) gains an 'instantly' job, scheduled every 15
-- minutes, dispatched only when an active profile has a campaign or leads
-- are still held in Instantly.
--
-- Service-role only, like 0300-0305.
-- Test: scripts/test_outbound_instantly.sql. Idempotent / safe to re-apply.
-- =============================================================================

create index if not exists idx_outbound_leads_in_instantly
  on outbound_leads (pushed_at) where instantly_lead_id is not null and removed_from_instantly_at is null;


create or replace function outbound_claim_pushable(p_profile_id uuid, p_limit int, p_lease_seconds int default 300)
returns setof outbound_leads
language sql
set search_path = public, pg_temp
as $$
  update outbound_leads l
     set claimed_until = now() + make_interval(secs => greatest(p_lease_seconds, 30))
   where l.id in (
     select c.id
       from outbound_leads c
      where c.profile_id = p_profile_id
        and c.stage = 'verified'
        and c.email is not null
        and c.instantly_lead_id is null
        and (c.claimed_until is null or c.claimed_until < now())
        and not outbound_is_suppressed(c.email, c.website_url)
      order by case c.verification when 'valid' then 0 else 1 end, c.created_at
      limit greatest(least(p_limit, 1000), 0)
      for update skip locked
   )
  returning l.*;
$$;


create or replace function outbound_pushed_today(p_profile_id uuid)
returns int
language sql
stable
set search_path = public, pg_temp
as $$
  select count(distinct e.lead_id)::int
    from outbound_events e
   where e.profile_id = p_profile_id
     and e.type = 'stage'
     and e.to_stage = 'queued'
     and e.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
$$;


create or replace function outbound_in_instantly()
returns int
language sql
stable
set search_path = public, pg_temp
as $$
  select count(*)::int
    from outbound_leads
   where instantly_lead_id is not null and removed_from_instantly_at is null;
$$;


create or replace function outbound_suppress_lead(p_lead_id uuid, p_reason text, p_source text default 'instantly', p_note text default null)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_lead outbound_leads%rowtype;
begin
  if p_reason not in ('unsubscribed', 'bounced', 'complained', 'invalid', 'manual') then
    raise exception 'outbound_suppress_lead: unknown reason %', p_reason;
  end if;
  select * into v_lead from outbound_leads where id = p_lead_id for update;
  if not found then
    return 'not_found';
  end if;

  if v_lead.email is not null then
    insert into outbound_suppressions (email, reason, source, note)
    values (v_lead.email, p_reason, p_source, p_note)
    on conflict do nothing;
  end if;

  insert into outbound_events (lead_id, profile_id, type, detail)
  values (p_lead_id, v_lead.profile_id, 'suppressed',
          jsonb_build_object('reason', p_reason, 'source', p_source, 'note', p_note));

  -- A lead a person already moved to won/lost/booked keeps that outcome;
  -- the suppression row alone stops any further email.
  if v_lead.stage not in ('won', 'lost', 'booked', 'called', 'suppressed') then
    update outbound_leads set stage = 'suppressed', claimed_until = null where id = p_lead_id;
  end if;
  return 'suppressed';
end;
$$;


-- request_outbound_job (0304) with an 'instantly' branch. Body otherwise
-- identical to 0304's.
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
  if p_job not in ('source', 'enrich', 'verify', 'instantly') then
    raise exception 'request_outbound_job: unknown job %', p_job;
  end if;

  v_work := case p_job
    when 'source' then exists (select 1 from outbound_profiles where status = 'active')
    when 'enrich' then exists (select 1 from outbound_leads
                                where stage = 'sourced' and (claimed_until is null or claimed_until < now()))
    when 'verify' then exists (select 1 from outbound_leads
                                where stage = 'email_found' and (claimed_until is null or claimed_until < now()))
    when 'instantly' then exists (select 1 from outbound_profiles
                                   where status = 'active' and instantly_campaign_id is not null)
                       or outbound_in_instantly() > 0
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
revoke all on function outbound_claim_pushable(uuid, int, int) from public, anon, authenticated;
revoke all on function outbound_pushed_today(uuid) from public, anon, authenticated;
revoke all on function outbound_in_instantly() from public, anon, authenticated;
revoke all on function outbound_suppress_lead(uuid, text, text, text) from public, anon, authenticated;


do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — the outbound-instantly job is NOT scheduled.';
    return;
  end if;
  begin perform cron.unschedule('outbound-instantly-due'); exception when others then null; end;
  perform cron.schedule('outbound-instantly-due', '2-59/15 * * * *', $cron$select request_outbound_job('instantly');$cron$);
end $$;
