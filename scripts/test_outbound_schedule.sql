-- =============================================================================
-- test_outbound_schedule.sql — non-destructive test of 0304:
-- request_outbound_job() calls nothing when there's no work, calls nothing
-- (and doesn't error) when its Vault secret is missing, dispatches once work
-- and secrets exist, ignores leads another run has leased, rejects unknown
-- jobs, and is refused to browser roles.
--
-- Run:  npm run test:sql -- outbound   (local stack only; the runner enables
-- pg_net. pg_cron isn't installed locally, so the cron block is skipped and
-- the schedule itself is checked on production, docs/OUTBOUND-PLAN.md §8.)
-- To see it FAIL:
--   * drop the `if not v_work then return null` early exit → "no active
--     profile: source isn't called" fails.
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_profile uuid;
  v_lead    uuid;
  v_client  uuid;
  v_user    uuid := gen_random_uuid();
  v_denied  boolean;
begin
  -- Start from a known state inside the transaction.
  update outbound_profiles set status = 'paused' where status = 'active';
  update outbound_leads set claimed_until = now() + interval '1 hour' where stage in ('sourced', 'email_found');
  delete from vault.secrets where name in ('outbound_source_url', 'outbound_enrich_url', 'outbound_verify_url');
  if not exists (select 1 from vault.decrypted_secrets where name = 'voice_tool_secret') then
    perform vault.create_secret('test-secret', 'voice_tool_secret', '');
  end if;

  -- No work: nothing is called, even with secrets in place.
  perform vault.create_secret('http://127.0.0.1:9/outbound-source', 'outbound_source_url', '');
  perform vault.create_secret('http://127.0.0.1:9/outbound-enrich', 'outbound_enrich_url', '');
  assert request_outbound_job('source') is null, 'no active profile: source isn''t called';
  assert request_outbound_job('enrich') is null, 'no sourced leads: enrich isn''t called';
  assert request_outbound_job('verify') is null, 'no found emails: verify isn''t called';

  -- Work exists: dispatched.
  insert into outbound_profiles (name, product, instantly_campaign_id, status)
  values ('Schedule test', 'seo', 'camp-1', 'active') returning id into v_profile;
  assert request_outbound_job('source') is not null, 'active profile: source is called';

  insert into outbound_leads (profile_id, source_ref, business_name) values (v_profile, 's-1', 'S1') returning id into v_lead;
  assert request_outbound_job('enrich') is not null, 'a sourced lead: enrich is called';

  -- A lead another run has leased isn't work.
  update outbound_leads set claimed_until = now() + interval '5 min' where id = v_lead;
  assert request_outbound_job('enrich') is null, 'a leased lead isn''t work';

  -- Work but no Vault secret: a notice, no call, no error.
  update outbound_leads set stage = 'email_found', email = 'a@s1-schedule-test.com', email_found_at = now(),
                            claimed_until = null
   where id = v_lead;
  assert request_outbound_job('verify') is null, 'verify secret missing: no call, no error';
  perform vault.create_secret('http://127.0.0.1:9/outbound-verify', 'outbound_verify_url', '');
  assert request_outbound_job('verify') is not null, 'verify secret present: called';

  begin
    perform request_outbound_job('publish');
    v_denied := false;
  exception when raise_exception then v_denied := true;
  end;
  assert v_denied, 'an unknown job is rejected';

  -- Isolation.
  insert into clients (name, slug, is_active) values ('Schedule Test Client', 'schedule-test-client', true)
  returning id into v_client;
  insert into auth.users (id, email) values (v_user, 'outbound-schedule-test@example.com');
  update users set client_id = v_client, role = 'admin' where id = v_user;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;
  begin
    perform request_outbound_job('source');
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a signed-in client can''t trigger outbound jobs';
  reset role;

  raise notice 'test_outbound_schedule: all assertions passed';
end;
$$;

rollback;
