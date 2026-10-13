-- =============================================================================
-- test_outbound_source.sql — non-destructive test of 0301: one call to
-- outbound_insert_leads saves new listings and skips, without failing the
-- batch, rows that collide on any of 0300's dedupe rules, suppressed and
-- client domains, and rows with no id or name. Browser roles can't call it.
--
-- Run:  npm run test:sql -- outbound   (local stack only)
-- To see it FAIL:
--   * change `on conflict do nothing` to a plain insert → the whole batch
--     errors on the first duplicate.
--   * grant execute on function outbound_insert_leads(uuid, jsonb, text) to
--     authenticated; → "isolation" fails.
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_profile  uuid;
  v_profile2 uuid;
  v_client   uuid;
  v_user     uuid := gen_random_uuid();
  v_res      jsonb;
  v_n        int;
  v_denied   boolean;
begin
  insert into outbound_profiles (name, product, audience)
  values ('Source test A', 'seo', '{"categories":["cannabis_store"]}') returning id into v_profile;
  insert into outbound_profiles (name, product) values ('Source test B', 'voice') returning id into v_profile2;

  -- Cursor columns exist.
  update outbound_profiles
     set source_cursor_key = 'k', source_offset_token = 't', source_total_count = 10,
         source_exhausted_at = null, last_sourced_at = now()
   where id = v_profile;

  -- Existing state the batch must respect.
  insert into outbound_leads (profile_id, source_ref, business_name, website_url)
  values (v_profile2, 'cid-taken', 'Already here', 'https://taken-test.com');
  insert into outbound_suppressions (domain, reason) values ('blocked-src-test.com', 'manual');
  insert into clients (name, slug, is_active) values ('Src Test Client', 'src-test-client', true) returning id into v_client;
  insert into seo_locations (client_id, name, website_url) values (v_client, 'Main', 'https://www.client-src-test.com');

  v_res := outbound_insert_leads(v_profile, jsonb_build_array(
    jsonb_build_object('source_ref', 'cid-new-1', 'business_name', 'New One',  'website_url', 'https://new1-test.com',
                       'city', 'Detroit', 'region', 'MI', 'rating', 4.66, 'review_count', 120, 'raw', '{"cid":"cid-new-1"}'::jsonb),
    jsonb_build_object('source_ref', 'cid-new-2', 'business_name', 'New Two',  'website_url', null),
    jsonb_build_object('source_ref', 'cid-new-3', 'business_name', 'No Site',  'website_url', null),
    jsonb_build_object('source_ref', 'cid-taken', 'business_name', 'Dup listing'),                          -- same listing
    jsonb_build_object('source_ref', 'cid-dupdom','business_name', 'Dup domain', 'website_url', 'http://www.taken-test.com/x'),
    jsonb_build_object('source_ref', 'cid-new-1', 'business_name', 'Dup in batch', 'website_url', 'https://other-test.com'),
    jsonb_build_object('source_ref', 'cid-block', 'business_name', 'Blocked',  'website_url', 'https://blocked-src-test.com'),
    jsonb_build_object('source_ref', 'cid-client','business_name', 'Client',   'website_url', 'https://client-src-test.com/'),
    jsonb_build_object('source_ref', '',          'business_name', 'No id'),
    jsonb_build_object('source_ref', 'cid-noname','business_name', '  ')
  ));

  assert (v_res->>'received')::int = 10, format('counts: received 10 (%s)', v_res);
  assert (v_res->>'inserted')::int = 3,  format('counts: inserted 3 (%s)', v_res);
  assert (v_res->>'suppressed')::int = 2, format('counts: suppressed 2, a blocked domain and a client (%s)', v_res);
  assert (v_res->>'invalid')::int = 2,  format('counts: invalid 2, no id and no name (%s)', v_res);
  assert (v_res->>'duplicates')::int = 3, format('counts: duplicates 3, listing, domain and in-batch (%s)', v_res);

  select count(*) into v_n from outbound_leads
   where profile_id = v_profile and source_ref = 'cid-new-1'
     and domain = 'new1-test.com' and rating = 4.7 and review_count = 120 and country_code = 'US'
     and raw->>'cid' = 'cid-new-1' and stage = 'sourced';
  assert v_n = 1, 'insert: fields saved, rating rounded to 1 place, country defaults to US, stage sourced';

  select count(*) into v_n from outbound_events e join outbound_leads l on l.id = e.lead_id
   where l.profile_id = v_profile and e.to_stage = 'sourced';
  assert v_n = 3, 'insert: each new lead logs a sourced event';

  -- An empty page is fine.
  v_res := outbound_insert_leads(v_profile, '[]'::jsonb);
  assert (v_res->>'inserted')::int = 0 and (v_res->>'received')::int = 0, 'empty: nothing to do';

  begin
    perform outbound_insert_leads(v_profile, '{"not":"an array"}'::jsonb);
    v_denied := false;
  exception when raise_exception then v_denied := true;
  end;
  assert v_denied, 'input: a non-array is rejected';

  -- Isolation.
  insert into auth.users (id, email) values (v_user, 'outbound-source-test@example.com');
  update users set client_id = v_client, role = 'admin' where id = v_user;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;
  begin
    perform outbound_insert_leads(v_profile, '[]'::jsonb);
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a signed-in client can''t insert leads';
  reset role;

  raise notice 'test_outbound_source: all assertions passed';
end;
$$;

rollback;
