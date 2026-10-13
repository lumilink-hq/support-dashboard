-- =============================================================================
-- 0303_outbound_verify.sql
-- Outbound engine (docs/OUTBOUND-PLAN.md), Phase 1 step 4: the one writer
-- for outbound-verify's results.
--
--   outbound_record_verification(lead, verification, suppress, detail)
--     verification 'valid' / 'catch_all' / 'unknown'  -> stage verified
--     verification 'invalid' / 'disposable'           -> stage invalid
--     suppress = true                                  -> the address also goes
--                                                         on the suppression list
--                                                         (reason 'invalid')
--   Acts only on a lead still at 'email_found'. An address suppressed since it
--   was found (e.g. an unsubscribe from another channel) moves the lead to
--   'suppressed' without using the result. Every call logs a 'verify' event
--   with the vendor's detail.
--
-- Catch-all and unknown addresses are kept at 'verified' but flagged by
-- `verification`, so the Instantly push can send them last (plan, Phase 1).
--
-- Service-role only, like 0300-0302.
-- Test: scripts/test_outbound_verify.sql. Idempotent / safe to re-apply.
-- =============================================================================

create or replace function outbound_record_verification(
  p_lead_id      uuid,
  p_verification text,
  p_suppress     boolean default false,
  p_detail       jsonb   default '{}'::jsonb
)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_lead  outbound_leads%rowtype;
  v_stage text;
begin
  if p_verification not in ('valid', 'invalid', 'catch_all', 'unknown', 'disposable') then
    raise exception 'outbound_record_verification: unknown verification %', p_verification;
  end if;

  select * into v_lead from outbound_leads where id = p_lead_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_lead.stage <> 'email_found' or v_lead.email is null then
    update outbound_leads set claimed_until = null where id = p_lead_id;
    return 'stage_changed';
  end if;

  insert into outbound_events (lead_id, profile_id, type, detail)
  values (p_lead_id, v_lead.profile_id, 'verify',
          coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('verification', p_verification, 'email', v_lead.email));

  if outbound_is_suppressed(v_lead.email, v_lead.website_url) then
    update outbound_leads set stage = 'suppressed', claimed_until = null where id = p_lead_id;
    return 'suppressed';
  end if;

  v_stage := case when p_verification in ('valid', 'catch_all', 'unknown') then 'verified' else 'invalid' end;

  update outbound_leads
     set verification = p_verification,
         verified_at = now(),
         stage = v_stage,
         claimed_until = null
   where id = p_lead_id;

  if p_suppress then
    insert into outbound_suppressions (email, reason, source, note)
    values (v_lead.email, 'invalid', 'reoon', p_detail->>'status')
    on conflict do nothing;
  end if;

  return v_stage;
end;
$$;

revoke all on function outbound_record_verification(uuid, text, boolean, jsonb) from public, anon, authenticated;
