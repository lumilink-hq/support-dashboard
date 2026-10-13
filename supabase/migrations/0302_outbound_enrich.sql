-- =============================================================================
-- 0302_outbound_enrich.sql
-- Outbound engine (docs/OUTBOUND-PLAN.md), Phase 1 step 3: what
-- outbound-enrich (and, next, outbound-verify) need from the database.
--
--   1. outbound_claim_leads(stage, limit, lease): hands out a batch of leads
--      at one stage and leases them (claimed_until) so two overlapping runs
--      never work the same lead. A crashed run's lease simply expires.
--   2. outbound_record_email(lead, email, source_url): the one place an
--      email lands on a lead, in a single statement-safe function:
--        no email found          -> stage no_email
--        suppressed address      -> stage suppressed
--        another lead has it     -> stage no_email + 'duplicate_email' event
--        otherwise               -> email saved, stage email_found
--      It only acts on a lead still at 'sourced', so a lead moved on by a
--      person in the meantime isn't overwritten.
--
-- Service-role only, like 0300/0301.
-- Test: scripts/test_outbound_enrich.sql. Idempotent / safe to re-apply.
-- =============================================================================

alter table outbound_leads add column if not exists claimed_until timestamptz;

create index if not exists idx_outbound_leads_stage_claim
  on outbound_leads (stage, created_at) where claimed_until is null;


create or replace function outbound_claim_leads(p_stage text, p_limit int, p_lease_seconds int default 300)
returns setof outbound_leads
language sql
set search_path = public, pg_temp
as $$
  update outbound_leads l
     set claimed_until = now() + make_interval(secs => greatest(p_lease_seconds, 30))
   where l.id in (
     select id
       from outbound_leads
      where stage = p_stage
        and (claimed_until is null or claimed_until < now())
      order by created_at
      limit greatest(least(p_limit, 100), 0)
      for update skip locked
   )
  returning l.*;
$$;


create or replace function outbound_record_email(p_lead_id uuid, p_email text, p_source_url text default null)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_lead   outbound_leads%rowtype;
  v_email  text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_other  uuid;
begin
  select * into v_lead from outbound_leads where id = p_lead_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_lead.stage <> 'sourced' then
    update outbound_leads set claimed_until = null where id = p_lead_id;
    return 'stage_changed';
  end if;

  if v_email is null then
    update outbound_leads set stage = 'no_email', claimed_until = null where id = p_lead_id;
    return 'no_email';
  end if;

  if outbound_is_suppressed(v_email, v_lead.website_url) then
    update outbound_leads set stage = 'suppressed', claimed_until = null where id = p_lead_id;
    insert into outbound_events (lead_id, profile_id, type, detail)
    values (p_lead_id, v_lead.profile_id, 'email_suppressed', jsonb_build_object('email', v_email));
    return 'suppressed';
  end if;

  select id into v_other from outbound_leads where lower(email) = v_email and id <> p_lead_id limit 1;
  if v_other is not null then
    update outbound_leads set stage = 'no_email', claimed_until = null where id = p_lead_id;
    insert into outbound_events (lead_id, profile_id, type, detail)
    values (p_lead_id, v_lead.profile_id, 'duplicate_email',
            jsonb_build_object('email', v_email, 'other_lead_id', v_other));
    return 'duplicate';
  end if;

  begin
    update outbound_leads
       set email = v_email,
           email_source_url = p_source_url,
           email_found_at = now(),
           stage = 'email_found',
           claimed_until = null
     where id = p_lead_id;
  exception when unique_violation then
    -- Another run saved the same address between the check above and here.
    update outbound_leads set stage = 'no_email', claimed_until = null where id = p_lead_id;
    insert into outbound_events (lead_id, profile_id, type, detail)
    values (p_lead_id, v_lead.profile_id, 'duplicate_email', jsonb_build_object('email', v_email));
    return 'duplicate';
  end;
  return 'found';
end;
$$;

revoke all on function outbound_claim_leads(text, int, int) from public, anon, authenticated;
revoke all on function outbound_record_email(uuid, text, text) from public, anon, authenticated;
