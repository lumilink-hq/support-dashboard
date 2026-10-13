-- =============================================================================
-- test_outbound_schema.sql — non-destructive test of 0300: domain
-- normalisation, global dedupe (listing, domain, email), stage events,
-- suppression lookups (email, domain, LumiLink client sites), and that
-- nothing outbound is reachable with the anon key or a signed-in client's JWT.
--
-- Run:  npm run test:sql -- outbound   (local stack only)
-- To see it FAIL:
--   * drop uq_outbound_leads_domain → "dedupe: a second lead on the same
--     domain is rejected" fails.
--   * grant select on outbound_leads to authenticated; plus a permissive
--     policy → "isolation: a signed-in client can't read leads" fails.
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_profile  uuid;
  v_profile2 uuid;
  v_lead     uuid;
  v_client   uuid;
  v_user     uuid := gen_random_uuid();
  v_n        int;
  v_denied   boolean;
begin
  -- ---------------------------------------------------------------------------
  -- Domain normalisation.
  -- ---------------------------------------------------------------------------
  assert outbound_normalize_domain('https://WWW.Example.com:8080/contact?x=1#top') = 'example.com',
    'normalize: scheme, www, port, path, query and fragment are stripped';
  assert outbound_normalize_domain('example.com') = 'example.com', 'normalize: bare host is kept';
  assert outbound_normalize_domain('Info@Example.COM') = 'example.com', 'normalize: email gives its domain';
  assert outbound_normalize_domain('http://shop.example.co.uk/') = 'shop.example.co.uk',
    'normalize: subdomains other than www are kept';
  assert outbound_normalize_domain('') is null and outbound_normalize_domain(null) is null,
    'normalize: empty and null give null';

  -- ---------------------------------------------------------------------------
  -- Profiles.
  -- ---------------------------------------------------------------------------
  insert into outbound_profiles (name, product, audience)
  values ('Test dispensaries x SEO', 'seo', '{"categories":["cannabis_store"]}')
  returning id into v_profile;
  insert into outbound_profiles (name, product) values ('Test HVAC x Phone Agent', 'voice')
  returning id into v_profile2;

  begin
    update outbound_profiles set status = 'active' where id = v_profile;
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'profiles: active without an Instantly campaign is rejected';

  begin
    insert into outbound_profiles (name, product) values ('Bad product', 'email');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'profiles: product must be voice or seo';

  -- ---------------------------------------------------------------------------
  -- Leads: domain set by trigger, global dedupe.
  -- ---------------------------------------------------------------------------
  insert into outbound_leads (profile_id, source_ref, business_name, website_url)
  values (v_profile, 'cid-1', 'Green Leaf', 'https://www.GreenLeaf-test.com/menu')
  returning id into v_lead;
  select count(*) into v_n from outbound_leads where id = v_lead and domain = 'greenleaf-test.com';
  assert v_n = 1, 'leads: domain is derived from website_url';

  begin
    insert into outbound_leads (profile_id, source_ref, business_name) values (v_profile2, 'cid-1', 'Dup listing');
    v_denied := false;
  exception when unique_violation then v_denied := true;
  end;
  assert v_denied, 'dedupe: the same listing is rejected, even from another profile';

  begin
    insert into outbound_leads (profile_id, source_ref, business_name, website_url)
    values (v_profile2, 'cid-2', 'Green Leaf East', 'http://greenleaf-test.com');
    v_denied := false;
  exception when unique_violation then v_denied := true;
  end;
  assert v_denied, 'dedupe: a second lead on the same domain is rejected';

  update outbound_leads set email = 'Hello@GreenLeaf-test.com', email_found_at = now(), stage = 'email_found'
   where id = v_lead;
  begin
    insert into outbound_leads (profile_id, source_ref, business_name, email, email_found_at)
    values (v_profile2, 'cid-3', 'No site', 'hello@greenleaf-test.com', now());
    v_denied := false;
  exception when unique_violation then v_denied := true;
  end;
  assert v_denied, 'dedupe: the same email (any case) is rejected';

  -- Leads without a website don't collide on domain.
  insert into outbound_leads (profile_id, source_ref, business_name) values (v_profile, 'cid-4', 'No site A');
  insert into outbound_leads (profile_id, source_ref, business_name) values (v_profile, 'cid-5', 'No site B');

  begin
    update outbound_leads set verification = 'valid' where source_ref = 'cid-4';
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'leads: verification needs an email';

  -- ---------------------------------------------------------------------------
  -- Stage events.
  -- ---------------------------------------------------------------------------
  update outbound_leads set verification = 'valid', verified_at = now(), stage = 'verified' where id = v_lead;
  update outbound_leads set notes = 'no stage change' where id = v_lead;
  select count(*) into v_n from outbound_events where lead_id = v_lead and type = 'stage';
  assert v_n = 3, format('events: insert + 2 stage changes logged, not the notes edit (saw %s)', v_n);
  select count(*) into v_n from outbound_events
   where lead_id = v_lead and from_stage = 'email_found' and to_stage = 'verified';
  assert v_n = 1, 'events: from/to stages are recorded';

  select count(*) into v_n from outbound_funnel where profile_id = v_profile and stage = 'verified' and leads = 1;
  assert v_n = 1, 'funnel: counts leads per profile and stage';

  -- ---------------------------------------------------------------------------
  -- Suppressions.
  -- ---------------------------------------------------------------------------
  assert not outbound_is_suppressed('owner@fresh-test.com', 'https://fresh-test.com'), 'suppress: clean address passes';

  insert into outbound_suppressions (email, reason, source) values ('Owner@Fresh-Test.com', 'unsubscribed', 'instantly');
  assert outbound_is_suppressed('owner@fresh-test.com'), 'suppress: exact email matches, any case';
  assert not outbound_is_suppressed('sales@fresh-test.com'), 'suppress: an email suppression does not block the domain';

  insert into outbound_suppressions (domain, reason) values ('https://www.blocked-test.com', 'manual');
  assert outbound_is_suppressed('anyone@blocked-test.com'), 'suppress: domain-wide block matches the email domain';
  assert outbound_is_suppressed('owner@gmail.com', 'blocked-test.com/contact'),
    'suppress: domain-wide block matches the website domain';

  begin
    insert into outbound_suppressions (reason) values ('manual');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'suppress: needs an email or a domain';

  -- A LumiLink client's site is never contacted.
  insert into clients (name, slug, is_active) values ('Outbound Test Client', 'outbound-test-client', true)
  returning id into v_client;
  insert into seo_locations (client_id, name, website_url) values (v_client, 'Main', 'https://client-test.com');
  assert outbound_is_suppressed('info@client-test.com'), 'suppress: an existing client domain is blocked';

  -- ---------------------------------------------------------------------------
  -- Isolation: anon and a signed-in client see nothing and write nothing.
  -- ---------------------------------------------------------------------------
  insert into auth.users (id, email) values (v_user, 'outbound-isolation-test@example.com');
  update users set client_id = v_client, role = 'admin' where id = v_user;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;

  begin
    perform 1 from outbound_leads limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a signed-in client can''t read leads';

  begin
    insert into outbound_suppressions (email, reason) values ('x@y-test.com', 'manual');
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a signed-in client can''t write suppressions';

  begin
    perform outbound_is_suppressed('x@y-test.com');
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a signed-in client can''t call outbound functions';

  begin
    perform 1 from outbound_funnel limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a signed-in client can''t read the funnel';

  reset role;
  set local role anon;
  begin
    perform 1 from outbound_profiles limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: anon can''t read profiles';
  reset role;

  raise notice 'test_outbound_schema: all assertions passed';
end;
$$;

rollback;
