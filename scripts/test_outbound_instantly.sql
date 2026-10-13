-- =============================================================================
-- test_outbound_instantly.sql — non-destructive test of 0306: the push claim
-- picks only verified, unsuppressed leads not yet in Instantly, valid ones
-- first; today's push count and the held-in-Instantly count are right;
-- outbound_suppress_lead suppresses the address but leaves a person's
-- won/booked outcome alone; request_outbound_job knows the 'instantly' job;
-- browser roles are refused.
--
-- Run:  npm run test:sql -- outbound   (local stack only)
-- To see it FAIL:
--   * drop `and not outbound_is_suppressed(...)` from outbound_claim_pushable
--     → "push: a suppressed address is never claimed" fails.
--   * drop the stage guard in outbound_suppress_lead → "suppress: a won lead
--     keeps its outcome" fails.
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_profile uuid;
  v_other   uuid;
  v_client  uuid;
  v_user    uuid := gen_random_uuid();
  v_l1      uuid;
  v_l2      uuid;
  v_n       int;
  v_out     text;
  v_denied  boolean;
  v_first   text;
begin
  -- Known state inside the transaction.
  update outbound_leads set removed_from_instantly_at = now() where instantly_lead_id is not null and removed_from_instantly_at is null;
  update outbound_profiles set status = 'paused' where status = 'active';

  insert into outbound_profiles (name, product, instantly_campaign_id, status)
  values ('Instantly test', 'seo', 'camp-test', 'active') returning id into v_profile;
  insert into outbound_profiles (name, product) values ('Instantly other', 'voice') returning id into v_other;

  -- Pushable candidates (created oldest first: unknown, valid, catch_all, valid).
  insert into outbound_leads (profile_id, source_ref, business_name, website_url, email, email_found_at, verification, stage, created_at)
  values
    (v_profile, 'p-unknown', 'Unknown Co',  'https://unknown-ins-test.com', 'a@unknown-ins-test.com', now(), 'unknown',   'verified', now() - interval '9 min'),
    (v_profile, 'p-valid1',  'Valid One',   'https://valid1-ins-test.com',  'a@valid1-ins-test.com',  now(), 'valid',     'verified', now() - interval '8 min'),
    (v_profile, 'p-catch',   'Catch Co',    'https://catch-ins-test.com',   'a@catch-ins-test.com',   now(), 'catch_all', 'verified', now() - interval '7 min'),
    (v_profile, 'p-valid2',  'Valid Two',   'https://valid2-ins-test.com',  'a@valid2-ins-test.com',  now(), 'valid',     'verified', now() - interval '6 min'),
  -- Not pushable: suppressed address, already in Instantly, wrong stage, other profile.
    (v_profile, 'p-supp',    'Suppressed',  'https://supp-ins-test.com',    'a@supp-ins-test.com',    now(), 'valid',     'verified', now() - interval '10 min'),
    (v_profile, 'p-held',    'Held',        'https://held-ins-test.com',    'a@held-ins-test.com',    now(), 'valid',     'queued',   now() - interval '11 min'),
    (v_profile, 'p-found',   'Found only',  'https://found-ins-test.com',   'a@found-ins-test.com',   now(), null,        'email_found', now() - interval '12 min'),
    (v_other,   'o-valid',   'Other prof',  'https://other-ins-test.com',   'a@other-ins-test.com',   now(), 'valid',     'verified', now() - interval '13 min');
  insert into outbound_suppressions (email, reason) values ('a@supp-ins-test.com', 'unsubscribed');
  update outbound_leads set instantly_lead_id = 'ins-held', pushed_at = now() where source_ref = 'p-held';

  -- ---------------------------------------------------------------------------
  -- Claim.
  -- ---------------------------------------------------------------------------
  perform 1 from outbound_claim_pushable(v_profile, 10, 300);
  select count(*) into v_n from outbound_leads where profile_id = v_profile and claimed_until > now();
  assert v_n = 4, format('push: exactly the 4 pushable leads are claimed (%s)', v_n);
  select count(*) into v_n from outbound_leads where source_ref in ('p-supp', 'p-held', 'p-found', 'o-valid') and claimed_until > now();
  assert v_n = 0, 'push: a suppressed address is never claimed, nor held, unverified or other-profile leads';

  -- Ordering: valid first (oldest valid first), then catch_all/unknown by age.
  update outbound_leads set claimed_until = null where profile_id = v_profile;
  select string_agg(c.source_ref, ',') into v_first from outbound_claim_pushable(v_profile, 2, 300) c;
  assert v_first in ('p-valid1,p-valid2', 'p-valid2,p-valid1'), format('push: valid addresses go first (%s)', v_first);
  update outbound_leads set claimed_until = null where profile_id = v_profile;

  -- ---------------------------------------------------------------------------
  -- Counts.
  -- ---------------------------------------------------------------------------
  assert outbound_in_instantly() = 1, format('in Instantly: 1 held (%s)', outbound_in_instantly());
  assert outbound_pushed_today(v_profile) = 1, format('pushed today: the held lead reached queued today (%s)', outbound_pushed_today(v_profile));
  update outbound_leads set stage = 'queued', instantly_lead_id = 'ins-v1', pushed_at = now() where source_ref = 'p-valid1';
  assert outbound_pushed_today(v_profile) = 2, 'pushed today: counts each lead once';
  assert outbound_pushed_today(v_other) = 0, 'pushed today: per profile';
  update outbound_leads set removed_from_instantly_at = now() where source_ref = 'p-held';
  assert outbound_in_instantly() = 1, 'in Instantly: removed leads don''t count';

  -- ---------------------------------------------------------------------------
  -- Suppress.
  -- ---------------------------------------------------------------------------
  select id into v_l1 from outbound_leads where source_ref = 'p-valid1';
  v_out := outbound_suppress_lead(v_l1, 'unsubscribed', 'instantly', null);
  assert v_out = 'suppressed', 'suppress: done';
  select count(*) into v_n from outbound_leads where id = v_l1 and stage = 'suppressed';
  assert v_n = 1, 'suppress: lead moves to suppressed';
  select count(*) into v_n from outbound_suppressions where lower(email) = 'a@valid1-ins-test.com' and reason = 'unsubscribed' and source = 'instantly';
  assert v_n = 1, 'suppress: address on the list';
  perform outbound_suppress_lead(v_l1, 'bounced', 'instantly', null);
  select count(*) into v_n from outbound_suppressions where lower(email) = 'a@valid1-ins-test.com';
  assert v_n = 1, 'suppress: twice is harmless';

  select id into v_l2 from outbound_leads where source_ref = 'p-valid2';
  update outbound_leads set stage = 'won' where id = v_l2;
  perform outbound_suppress_lead(v_l2, 'unsubscribed', 'instantly', null);
  select count(*) into v_n from outbound_leads where id = v_l2 and stage = 'won';
  assert v_n = 1, 'suppress: a won lead keeps its outcome';
  select count(*) into v_n from outbound_suppressions where lower(email) = 'a@valid2-ins-test.com';
  assert v_n = 1, 'suppress: but its address is still suppressed';

  begin
    perform outbound_suppress_lead(v_l2, 'client');
    v_denied := false;
  exception when raise_exception then v_denied := true;
  end;
  assert v_denied, 'suppress: unknown reason rejected';

  -- ---------------------------------------------------------------------------
  -- Dispatch.
  -- ---------------------------------------------------------------------------
  delete from vault.secrets where name = 'outbound_instantly_url';
  if not exists (select 1 from vault.decrypted_secrets where name = 'voice_tool_secret') then
    perform vault.create_secret('test-secret', 'voice_tool_secret', '');
  end if;
  assert request_outbound_job('instantly') is null, 'dispatch: no URL in Vault, no call';
  perform vault.create_secret('http://127.0.0.1:9/outbound-instantly', 'outbound_instantly_url', '');
  assert request_outbound_job('instantly') is not null, 'dispatch: active profile with a campaign is work';
  update outbound_profiles set status = 'paused' where id = v_profile;
  update outbound_leads set removed_from_instantly_at = now() where instantly_lead_id is not null;
  assert request_outbound_job('instantly') is null, 'dispatch: nothing active and nothing held, no call';
  assert request_outbound_job('source') is null, 'dispatch: older jobs still work';

  -- ---------------------------------------------------------------------------
  -- Isolation.
  -- ---------------------------------------------------------------------------
  insert into clients (name, slug, is_active) values ('Instantly Test Client', 'instantly-test-client', true) returning id into v_client;
  insert into auth.users (id, email) values (v_user, 'outbound-instantly-test@example.com');
  update users set client_id = v_client, role = 'admin' where id = v_user;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;
  begin
    perform outbound_claim_pushable(v_profile, 1, 60);
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a signed-in client can''t claim leads for push';
  begin
    perform outbound_suppress_lead(v_l1, 'manual');
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a signed-in client can''t suppress leads';
  reset role;

  raise notice 'test_outbound_instantly: all assertions passed';
end;
$$;

rollback;
