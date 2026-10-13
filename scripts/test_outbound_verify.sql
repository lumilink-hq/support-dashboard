-- =============================================================================
-- test_outbound_verify.sql — non-destructive test of 0303:
-- outbound_record_verification moves each result to the right stage, adds a
-- suppression only when asked, logs a 'verify' event every time, leaves leads
-- that moved on alone, honours a suppression added after the address was
-- found, and is refused to browser roles.
--
-- Run:  npm run test:sql -- outbound   (local stack only)
-- To see it FAIL:
--   * map 'catch_all' to 'invalid' in the v_stage case → "catch_all stays
--     verified" fails.
--   * drop the outbound_is_suppressed check → "an address suppressed since
--     it was found" fails.
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_profile uuid;
  v_client  uuid;
  v_user    uuid := gen_random_uuid();
  v_ids     uuid[] := array[]::uuid[];
  v_id      uuid;
  v_out     text;
  v_n       int;
  v_denied  boolean;
  i         int;
begin
  insert into outbound_profiles (name, product) values ('Verify test', 'seo') returning id into v_profile;
  for i in 1..7 loop
    insert into outbound_leads (profile_id, source_ref, business_name, website_url, email, email_found_at, stage)
    values (v_profile, 'v-' || i, 'Biz ' || i, format('https://v%s-verify-test.com', i),
            format('info@v%s-verify-test.com', i), now(), 'email_found')
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;

  v_out := outbound_record_verification(v_ids[1], 'valid', false, '{"status":"safe","overall_score":98}');
  assert v_out = 'verified', format('valid: verified (%s)', v_out);
  select count(*) into v_n from outbound_leads where id = v_ids[1] and verification = 'valid' and verified_at is not null;
  assert v_n = 1, 'valid: verification and time saved';
  select count(*) into v_n from outbound_events where lead_id = v_ids[1] and type = 'verify'
     and detail->>'status' = 'safe' and detail->>'verification' = 'valid' and detail->>'email' = 'info@v1-verify-test.com';
  assert v_n = 1, 'valid: verify event logged with vendor detail';

  v_out := outbound_record_verification(v_ids[2], 'catch_all', false, '{"status":"catch_all"}');
  assert v_out = 'verified', format('catch_all stays verified (%s)', v_out);
  v_out := outbound_record_verification(v_ids[3], 'unknown');
  assert v_out = 'verified', format('unknown stays verified (%s)', v_out);

  v_out := outbound_record_verification(v_ids[4], 'invalid', true, '{"status":"invalid"}');
  assert v_out = 'invalid', format('invalid: stage invalid (%s)', v_out);
  select count(*) into v_n from outbound_suppressions
   where lower(email) = 'info@v4-verify-test.com' and reason = 'invalid' and source = 'reoon' and note = 'invalid';
  assert v_n = 1, 'invalid: address suppressed with the vendor status';

  v_out := outbound_record_verification(v_ids[5], 'invalid', false, '{"status":"inbox_full"}');
  assert v_out = 'invalid', format('inbox_full: stage invalid (%s)', v_out);
  select count(*) into v_n from outbound_suppressions where lower(email) = 'info@v5-verify-test.com';
  assert v_n = 0, 'inbox_full: not suppressed';

  insert into outbound_suppressions (email, reason) values ('info@v6-verify-test.com', 'unsubscribed');
  v_out := outbound_record_verification(v_ids[6], 'valid', false, '{"status":"safe"}');
  assert v_out = 'suppressed', format('an address suppressed since it was found (%s)', v_out);
  select count(*) into v_n from outbound_leads where id = v_ids[6] and stage = 'suppressed' and verification is null;
  assert v_n = 1, 'suppressed: the result is not applied';

  update outbound_leads set stage = 'won' where id = v_ids[7];
  v_out := outbound_record_verification(v_ids[7], 'valid');
  assert v_out = 'stage_changed', format('stage_changed (%s)', v_out);
  select count(*) into v_n from outbound_events where lead_id = v_ids[7] and type = 'verify';
  assert v_n = 0, 'stage_changed: no verify event';

  v_out := outbound_record_verification(gen_random_uuid(), 'valid');
  assert v_out = 'not_found', 'unknown lead';

  begin
    perform outbound_record_verification(v_ids[1], 'maybe');
    v_denied := false;
  exception when raise_exception then v_denied := true;
  end;
  assert v_denied, 'an unknown verification value is rejected';

  -- Isolation.
  insert into clients (name, slug, is_active) values ('Verify Test Client', 'verify-test-client', true) returning id into v_client;
  insert into auth.users (id, email) values (v_user, 'outbound-verify-test@example.com');
  update users set client_id = v_client, role = 'admin' where id = v_user;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;
  begin
    perform outbound_record_verification(v_ids[1], 'valid');
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a signed-in client can''t record verification';
  reset role;

  raise notice 'test_outbound_verify: all assertions passed';
end;
$$;

rollback;
