-- =============================================================================
-- test_seo_shared_websites.sql — non-destructive test of 0070 (module 29): the
-- website key, the primary location, the site-wide jobs only targeting the
-- primary, tenant isolation on seo_site_locations, and the one-time cleanup.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_shared_websites.sql
--
-- To see it FAIL:
--   * drop the "join seo_site_locations ... is_primary" line from
--     seo_crawl_targets → "targets: only the primary of a shared site is crawled" fails.
--   * order the window by created_at desc → "view: the oldest active location is primary" fails.
--   * drop "and not s.is_primary" from seo_reset_shared_websites' link delete
--     → "cleanup: the primary keeps its link opportunities" fails.
--   * recreate seo_site_locations without security_invoker
--     → "rls: tenant A sees only its own locations" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_a     uuid;
  v_b     uuid;
  v_old   uuid;  -- A, oldest, but inactive
  v_p     uuid;  -- A, primary of acme.example
  v_s1    uuid;  -- A, sibling (www, trailing path)
  v_s2    uuid;  -- A, sibling (http, no www)
  v_other uuid;  -- A, a second website
  v_solo  uuid;  -- B, single location
  v_user  uuid;
  v_n     int;
  v_r     jsonb;
  v_t     timestamptz;
begin
  -- ---------------------------------------------------------------------------
  -- seo_site_key mirrors stores.ts's siteKey()
  -- ---------------------------------------------------------------------------
  assert seo_site_key('https://WWW.Acme.Example/menu/x') = 'acme.example', 'key: www, case and path ignored';
  assert seo_site_key('http://acme.example') = seo_site_key('https://www.acme.example/'), 'key: http and https are the same site';
  assert seo_site_key('acme.example') = 'acme.example', 'key: a bare domain counts';
  assert seo_site_key('https://acme.example:443/') = 'acme.example', 'key: default port dropped';
  assert seo_site_key('http://localhost:8080/x') = 'localhost:8080', 'key: other port kept';
  assert seo_site_key('localhost:8080') = 'localhost:8080', 'key: bare host:port is not a scheme';
  assert seo_site_key('https://user:pw@acme.example/') = 'acme.example', 'key: userinfo dropped';
  assert seo_site_key('') is null and seo_site_key(null) is null, 'key: empty is no website';
  assert seo_site_key('mailto:a@acme.example') is null, 'key: mailto is not a website';
  assert seo_site_key('ftp://acme.example') is null, 'key: ftp is not a website';
  assert seo_site_key('https://shop.acme.example') <> seo_site_key('https://acme.example'), 'key: a subdomain is another website';

  -- ---------------------------------------------------------------------------
  -- Fixtures
  -- ---------------------------------------------------------------------------
  insert into clients (name, slug, is_active) values ('Shared Site A', 'shared-site-a', true) returning id into v_a;
  insert into clients (name, slug, is_active) values ('Shared Site B', 'shared-site-b', true) returning id into v_b;

  insert into seo_locations (client_id, name, website_url, is_active, created_at)
  values (v_a, 'Old (closed)', 'https://acme.example', false, now() - interval '30 days') returning id into v_old;
  insert into seo_locations (client_id, name, website_url, store_page_url, created_at)
  values (v_a, 'First', 'https://acme.example', 'https://acme.example/menu/first', now() - interval '3 days') returning id into v_p;
  insert into seo_locations (client_id, name, website_url, store_page_url, created_at)
  values (v_a, 'Second', 'https://www.acme.example/', 'https://acme.example/menu/second', now() - interval '2 days') returning id into v_s1;
  insert into seo_locations (client_id, name, website_url, store_page_url, created_at)
  values (v_a, 'Third', 'http://acme.example', 'https://acme.example/menu/third', now() - interval '1 day') returning id into v_s2;
  insert into seo_locations (client_id, name, website_url, created_at)
  values (v_a, 'Other brand', 'https://other.example', now() - interval '10 days') returning id into v_other;
  insert into seo_locations (client_id, name, website_url, created_at)
  values (v_b, 'Solo', 'https://acme.example', now() - interval '40 days') returning id into v_solo;
  -- A location with no website is never on a site.
  insert into seo_locations (client_id, name, website_url) values (v_a, 'No site', null);

  -- ---------------------------------------------------------------------------
  -- The view
  -- ---------------------------------------------------------------------------
  select count(*) into v_n from seo_site_locations where client_id = v_a;
  assert v_n = 4, 'view: active locations with a website only (not the closed one, not the site-less one)';

  select count(*) into v_n from seo_site_locations where client_id = v_a and site_key = 'acme.example' and primary_location_id = v_p;
  assert v_n = 3, 'view: the oldest active location is primary for all three';
  select count(*) into v_n from seo_site_locations where location_id in (v_p, v_s1, v_s2) and site_location_count = 3;
  assert v_n = 3, 'view: each knows the site has 3 locations';
  assert (select is_primary from seo_site_locations where location_id = v_p), 'view: primary flagged';
  assert not (select is_primary from seo_site_locations where location_id = v_s1), 'view: sibling not flagged';

  assert (select is_primary and site_location_count = 1 from seo_site_locations where location_id = v_other), 'view: a second website of the same client is its own';
  assert (select is_primary and site_location_count = 1 from seo_site_locations where location_id = v_solo),
    'view: another client on the same domain is not grouped with A';

  -- ---------------------------------------------------------------------------
  -- Site-wide jobs only target the primary
  -- ---------------------------------------------------------------------------
  select count(*) into v_n from seo_crawl_targets where location_id in (v_p, v_s1, v_s2);
  assert v_n = 1 and exists (select 1 from seo_crawl_targets where location_id = v_p),
    'targets: only the primary of a shared site is crawled';
  select count(*) into v_n from seo_technical_audit_targets where location_id in (v_p, v_s1, v_s2);
  assert v_n = 1 and exists (select 1 from seo_technical_audit_targets where location_id = v_p),
    'targets: only the primary gets the technical audit';
  select count(*) into v_n from seo_link_opportunity_targets where location_id in (v_p, v_s1, v_s2);
  assert v_n = 1 and exists (select 1 from seo_link_opportunity_targets where location_id = v_p),
    'targets: only the primary pulls link opportunities';
  select count(*) into v_n from seo_crawl_targets where location_id in (v_other, v_solo);
  assert v_n = 2, 'targets: single-location websites are unchanged';
  assert not exists (select 1 from seo_crawl_targets where location_id = v_old), 'targets: an inactive location is never a target';

  -- A sibling with a store-page finding still drafts its own page (seo_draft_targets unchanged).
  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, target_url, details)
  values (v_a, v_s1, 'crawl', 'missing_meta_description', 'warning', 'no meta', 'https://acme.example/menu/second', '{"scope": "store"}');
  assert exists (select 1 from seo_draft_targets where location_id = v_s1), 'drafts: a store drafts fixes to its own page';
  delete from seo_findings where location_id = v_s1;

  -- Closing the primary hands the site to the next oldest.
  update seo_locations set is_active = false where id = v_p;
  assert (select primary_location_id from seo_site_locations where location_id = v_s2) = v_s1, 'view: closing the primary hands the site on';
  assert exists (select 1 from seo_crawl_targets where location_id = v_s1), 'targets: the new primary is crawled';
  update seo_locations set is_active = true where id = v_p;

  -- ---------------------------------------------------------------------------
  -- The cleanup
  -- ---------------------------------------------------------------------------
  -- Drafts: pending ones go, approved / published / rejected stay.
  insert into seo_actions (client_id, location_id, action_type, status, idempotency_key, target_url, target_field)
  values (v_a, v_p,  'onpage_fix', 'pending_approval', 't-1', 'https://acme.example/hats', 'meta_description'),
         (v_a, v_s1, 'onpage_fix', 'pending_approval', 't-2', 'https://acme.example/hats', 'meta_description'),
         (v_a, v_s2, 'onpage_fix', 'draft',            't-3', 'https://acme.example/x',    'h1'),
         (v_a, v_s1, 'onpage_fix', 'approved',         't-4', 'https://acme.example/y',    'h1'),
         (v_a, v_p,  'onpage_fix', 'published',        't-5', 'https://acme.example/z',    'h1'),
         (v_a, v_s2, 'content_publish', 'pending_approval', 't-6', null, null),
         (v_b, v_solo, 'onpage_fix', 'pending_approval', 't-7', 'https://acme.example/hats', 'meta_description');

  -- Findings: open go; dismissed stays; actioned stays only while its action does.
  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, target_url, status)
  values (v_a, v_p,  'crawl',     'thin_content',      'warning', 'thin', 'https://acme.example/a', 'open'),
         (v_a, v_s1, 'crawl',     'thin_content',      'warning', 'thin', 'https://acme.example/a', 'open'),
         (v_a, v_s2, 'technical', 'slow_page',         'warning', 'slow', 'https://acme.example/',  'open'),
         (v_a, v_s1, 'backlinks', 'backlinks_to_broken_page', 'warning', 'b', 'https://acme.example/gone', 'open'),
         (v_a, v_s1, 'crawl',     'orphan_page',       'info',    'o',    'https://acme.example/o', 'dismissed'),
         (v_a, v_s1, 'crawl',     'missing_h1',        'warning', 'h',    'https://acme.example/y', 'actioned'),
         (v_a, v_s2, 'crawl',     'missing_h1',        'warning', 'h',    'https://acme.example/x', 'actioned'),
         (v_a, v_s1, 'gbp_profile', 'missing_hours',   'warning', 'g',    null,                     'open'),
         (v_b, v_solo, 'crawl',   'thin_content',      'warning', 'thin', 'https://acme.example/a', 'open');
  -- The approved draft keeps its finding.
  update seo_actions set finding_id = (select id from seo_findings where location_id = v_s1 and status = 'actioned')
   where idempotency_key = 't-4';

  insert into seo_crawl_runs (location_id, client_id, site_host, root_url, page_limit)
  values (v_p, v_a, 'acme.example', 'https://acme.example/', 100), (v_s1, v_a, 'acme.example', 'https://acme.example/', 100),
         (v_solo, v_b, 'acme.example', 'https://acme.example/', 100);

  insert into seo_link_opportunities (client_id, location_id, kind, referring_domain)
  values (v_a, v_p, 'gap', 'links.example'), (v_a, v_s1, 'gap', 'links.example'), (v_a, v_s2, 'lost', 'gone.example');

  v_t := now() + interval '6 days';
  insert into job_attempts (client_id, job_type, entity_id, status, next_run_at)
  values (v_a, 'seo_crawl', v_p, 'idle', v_t), (v_a, 'seo_technical_audit', v_p, 'idle', v_t),
         (v_a, 'seo_crawl', v_s1, 'idle', v_t), (v_a, 'seo_draft', v_p, 'idle', v_t),
         (v_b, 'seo_crawl', v_solo, 'idle', v_t);

  v_r := seo_reset_shared_websites();

  select count(*) into v_n from seo_actions where client_id = v_a and action_type = 'onpage_fix' and status in ('draft', 'pending_approval');
  assert v_n = 0, 'cleanup: unapproved page fixes on the shared site are gone';
  select count(*) into v_n from seo_actions where client_id = v_a and status in ('approved', 'published');
  assert v_n = 2, 'cleanup: approved and published work stays';
  assert exists (select 1 from seo_actions where idempotency_key = 't-6'), 'cleanup: articles are untouched';
  assert exists (select 1 from seo_actions where idempotency_key = 't-7'), 'cleanup: a single-location site''s drafts are untouched';

  select count(*) into v_n from seo_findings where client_id = v_a and status = 'open' and module in ('crawl', 'technical', 'backlinks');
  assert v_n = 0, 'cleanup: open audit findings on the shared site are gone';
  assert exists (select 1 from seo_findings where location_id = v_s1 and status = 'dismissed'), 'cleanup: a dismissal is kept';
  assert exists (select 1 from seo_findings where location_id = v_s1 and status = 'actioned'), 'cleanup: a finding with a live action is kept';
  assert not exists (select 1 from seo_findings where location_id = v_s2 and status = 'actioned'), 'cleanup: a finding whose draft was deleted goes';
  assert exists (select 1 from seo_findings where module = 'gbp_profile' and location_id = v_s1), 'cleanup: profile findings are untouched';
  assert exists (select 1 from seo_findings where location_id = v_solo), 'cleanup: a single-location site''s findings are untouched';

  select count(*) into v_n from seo_crawl_runs where client_id = v_a;
  assert v_n = 0, 'cleanup: crawl state on the shared site is cleared';
  assert exists (select 1 from seo_crawl_runs where location_id = v_solo), 'cleanup: other crawl state is untouched';

  assert exists (select 1 from seo_link_opportunities where location_id = v_p), 'cleanup: the primary keeps its link opportunities';
  select count(*) into v_n from seo_link_opportunities where location_id in (v_s1, v_s2);
  assert v_n = 0, 'cleanup: siblings'' link opportunities are gone';

  select count(*) into v_n from job_attempts where entity_id = v_p and job_type in ('seo_crawl', 'seo_technical_audit') and next_run_at <= now();
  assert v_n = 2, 'cleanup: the primary''s crawl and audit are due now';
  assert (select next_run_at from job_attempts where entity_id = v_p and job_type = 'seo_draft') = v_t, 'cleanup: other jobs keep their schedule';
  assert (select next_run_at from job_attempts where entity_id = v_s1 and job_type = 'seo_crawl') = v_t, 'cleanup: a sibling''s crawl isn''t made due';
  assert (select next_run_at from job_attempts where entity_id = v_solo) = v_t, 'cleanup: other clients keep their schedule';
  assert (v_r->>'drafts')::int = 3 and (v_r->>'link_rows')::int = 2, format('cleanup: reports what it did (%s)', v_r);

  -- Running it again does nothing more.
  v_r := seo_reset_shared_websites();
  assert (v_r->>'drafts')::int = 0 and (v_r->>'findings')::int = 0 and (v_r->>'link_rows')::int = 0, 'cleanup: a second run is a no-op';

  -- ---------------------------------------------------------------------------
  -- As tenant A (authenticated, RLS in effect).
  -- ---------------------------------------------------------------------------
  v_user := gen_random_uuid();
  insert into auth.users (id, email) values (v_user, 'shared-site-test@example.com');
  update users set client_id = v_a, role = 'admin' where id = v_user;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;

  select count(*) into v_n from seo_site_locations;
  assert v_n = 4, format('rls: tenant A sees only its own locations (saw %s)', v_n);
  assert not exists (select 1 from seo_site_locations where location_id = v_solo), 'rls: tenant A must not see tenant B''s location';
  assert (select primary_location_id from seo_site_locations where location_id = v_s2) = v_p, 'rls: the dashboard can find the primary';

  begin
    perform seo_reset_shared_websites();
    assert false, 'rls: a tenant must not run the cleanup';
  exception when insufficient_privilege then
    null;
  end;

  reset role;
  raise notice 'test_seo_shared_websites: all assertions passed';
end;
$$;

rollback;
