-- =============================================================================
-- test_outbound_enrich.sql — non-destructive test of 0302: claiming leases a
-- batch and skips leads already leased, an expired lease can be claimed
-- again, and outbound_record_email lands every outcome correctly (found,
-- no_email, suppressed, duplicate, stage_changed). Browser roles can't call
-- either function.
--
-- Run:  npm run test:sql -- outbound   (local stack only)
-- To see it FAIL:
--   * drop the `claimed_until is null or claimed_until < now()` condition in
--     outbound_claim_leads → "claim: leased leads aren't handed out twice" fails.
--   * remove the stage check in outbound_record_email → "record: a lead moved
--     on by a person is left alone" fails.
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_profile uuid;
  v_client  uuid;
  v_user    uuid := gen_random_uuid();
  v_a uuid; v_b uuid; v_c uuid; v_d uuid; v_e uuid; v_f uuid;
  v_n       int;
  v_out     text;
  v_denied  boolean;
begin
  insert into outbound_profiles (name, product) values ('Enrich test', 'seo') returning id into v_profile;
  insert into outbound_leads (profile_id, source_ref, business_name, website_url, created_at)
  values (v_profile, 'e-a', 'A', 'https://a-enrich-test.com', now() - interval '6 min') returning id into v_a;
  insert into outbound_leads (profile_id, source_ref, business_name, website_url, created_at)
  values (v_profile, 'e-b', 'B', 'https://b-enrich-test.com', now() - interval '5 min') returning id into v_b;
  insert into outbound_leads (profile_id, source_ref, business_name, website_url, created_at)
  values (v_profile, 'e-c', 'C', 'https://c-enrich-test.com', now() - interval '4 min') returning id into v_c;
  insert into outbound_leads (profile_id, source_ref, business_name, website_url, created_at)
  values (v_profile, 'e-d', 'D', 'https://d-enrich-test.com', now() - interval '3 min') returning id into v_d;
  insert into outbound_leads (profile_id, source_ref, business_name, website_url, created_at)
  values (v_profile, 'e-e', 'E', 'https://e-enrich-test.com', now() - interval '2 min') returning id into v_e;
  insert into outbound_leads (profile_id, source_ref, business_name, website_url, created_at)
  values (v_profile, 'e-f', 'F', 'https://f-enrich-test.com', now() - interval '1 min') returning id into v_f;

  -- ---------------------------------------------------------------------------
  -- Claiming. Other 'sourced' leads may exist locally, so count only ours.
  -- ---------------------------------------------------------------------------
  update outbound_leads set claimed_until = null where stage = 'sourced';
  select count(*) into v_n from outbound_claim_leads('sourced', 100, 300) c where c.profile_id = v_profile;
  assert v_n = 6, format('claim: all six sourced leads are handed out (%s)', v_n);
  select count(*) into v_n from outbound_leads
   where profile_id = v_profile and claimed_until > now() + interval '4 min';
  assert v_n = 6, 'claim: each claimed lead is leased for the requested time';

  select count(*) into v_n from outbound_claim_leads('sourced', 100, 300) c where c.profile_id = v_profile;
  assert v_n = 0, 'claim: leased leads aren''t handed out twice';

  update outbound_leads set claimed_until = now() - interval '1 second' where id = v_b;
  select count(*) into v_n from outbound_claim_leads('sourced', 100, 300) c where c.id = v_b;
  assert v_n = 1, 'claim: an expired lease can be claimed again';

  select count(*) into v_n from outbound_claim_leads('email_found', 100, 300) c where c.profile_id = v_profile;
  assert v_n = 0, 'claim: only the requested stage is handed out';

  -- ---------------------------------------------------------------------------
  -- Recording.
  -- ---------------------------------------------------------------------------
  v_out := outbound_record_email(v_a, ' Info@A-Enrich-Test.com ', 'https://a-enrich-test.com/contact');
  assert v_out = 'found', format('record: found (%s)', v_out);
  select count(*) into v_n from outbound_leads
   where id = v_a and email = 'info@a-enrich-test.com' and stage = 'email_found'
     and email_source_url = 'https://a-enrich-test.com/contact' and email_found_at is not null
     and claimed_until is null;
  assert v_n = 1, 'record: email lower-cased and saved with its page, lease cleared';

  v_out := outbound_record_email(v_b, null);
  assert v_out = 'no_email', format('record: no_email (%s)', v_out);
  select count(*) into v_n from outbound_leads where id = v_b and stage = 'no_email' and claimed_until is null;
  assert v_n = 1, 'record: no address moves the lead to no_email';

  insert into outbound_suppressions (email, reason) values ('owner@c-enrich-test.com', 'unsubscribed');
  v_out := outbound_record_email(v_c, 'owner@c-enrich-test.com');
  assert v_out = 'suppressed', format('record: suppressed (%s)', v_out);
  select count(*) into v_n from outbound_leads where id = v_c and stage = 'suppressed' and email is null;
  assert v_n = 1, 'record: a suppressed address is not saved and the lead is suppressed';

  v_out := outbound_record_email(v_d, 'INFO@a-enrich-test.com');
  assert v_out = 'duplicate', format('record: duplicate (%s)', v_out);
  select count(*) into v_n from outbound_events where lead_id = v_d and type = 'duplicate_email'
     and (detail->>'other_lead_id')::uuid = v_a;
  assert v_n = 1, 'record: a duplicate logs which lead already has the address';

  update outbound_leads set stage = 'won', claimed_until = now() + interval '5 min' where id = v_e;
  v_out := outbound_record_email(v_e, 'boss@e-enrich-test.com');
  assert v_out = 'stage_changed', format('record: stage_changed (%s)', v_out);
  select count(*) into v_n from outbound_leads where id = v_e and stage = 'won' and email is null and claimed_until is null;
  assert v_n = 1, 'record: a lead moved on by a person is left alone (lease released)';

  v_out := outbound_record_email(gen_random_uuid(), 'x@y.com');
  assert v_out = 'not_found', 'record: unknown lead';

  -- Webmail is per address: suppressing one gmail address doesn't block another.
  insert into outbound_suppressions (email, reason) values ('someone@gmail.com', 'unsubscribed');
  v_out := outbound_record_email(v_f, 'fshop@gmail.com');
  assert v_out = 'found', format('record: other gmail addresses still allowed (%s)', v_out);

  -- ---------------------------------------------------------------------------
  -- Isolation.
  -- ---------------------------------------------------------------------------
  insert into clients (name, slug, is_active) values ('Enrich Test Client', 'enrich-test-client', true) returning id into v_client;
  insert into auth.users (id, email) values (v_user, 'outbound-enrich-test@example.com');
  update users set client_id = v_client, role = 'admin' where id = v_user;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;
  begin
    perform outbound_claim_leads('sourced', 1, 60);
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a signed-in client can''t claim leads';
  begin
    perform outbound_record_email(v_a, 'x@y.com');
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a signed-in client can''t record emails';
  reset role;

  raise notice 'test_outbound_enrich: all assertions passed';
end;
$$;

rollback;
