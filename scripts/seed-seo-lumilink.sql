-- =============================================================================
-- scripts/seed-seo-lumilink.sql — turn the SEO demo workspace into LumiLink's
-- own, live SEO workspace (dogfooding; the real data for the Google OAuth
-- scope-verification demo video).
--
-- REPLACES scripts/seed-seo-demo.sql's data for the same account. Don't run
-- the demo seed on this account again afterwards: it would wipe everything
-- this sets up and park the jobs again.
--
-- HOW TO USE
--   1. Edit the keyword, competitor and AI question lists below if you want.
--   2. Run this whole file in the Supabase SQL editor (production) as-is.
--      v_dry_run is true, so it does everything, reports what it found and
--      created, then raises "DRY RUN" and Postgres rolls the lot back.
--      Nothing changes.
--   3. If the report looks right, set v_dry_run := false and run it again.
--
-- WHAT IT DOES
--   * Wipes the workspace's SEO data (the fictional Harbor & Pine history)
--     and the parked 'infinity' job rows the demo seed created.
--   * Creates ONE location: LumiLink, https://www.lumilinkhub.com (www, not
--     the apex: the apex is a Squarespace forward that drops the path), with
--     search_console_site_url = sc-domain:lumilinkhub.com so URL Inspection
--     runs through the Google account already connected in Settings.
--   * Leaves the Google connection, the users, and billing alone.
--
-- THIS ONE REACHES VENDORS. With no job_attempts rows, every SEO job counts
-- as due on its next scheduled tick: crawl, technical audit (Search Console +
-- PageSpeed), rank checks and backlinks (DataForSEO), AI visibility, fix and
-- article drafting (Anthropic; Replicate for images), geocoding, and the
-- monthly report email to this account. All of it counts against the same
-- vendor budgets as clients. Publishing can't happen: the site isn't a
-- connected Shopify store, so approved fixes come back as hand-apply steps.
-- =============================================================================

do $$
declare
  v_dry_run  boolean := true;   -- set to false for the real run
  v_email    text := 'lumilinkhq@gmail.com';
  v_site     text := 'https://www.lumilinkhub.com';
  v_sc_site  text := 'sc-domain:lumilinkhub.com';

  -- EDIT THESE. Keywords are what you want LumiLink to be found for;
  -- is_geo_grid_enabled stays off (LumiLink isn't a storefront business, so a
  -- map-pack grid around an address means nothing).
  v_keywords    text[] := array[
    'ai receptionist for small business',
    'ai phone answering service',
    'ai answering service for home services',
    'local seo software for small business',
    'ai search visibility'
  ];
  v_competitors text[][] := array[
    array['smith.ai', 'Smith.ai']
  ];
  v_ai_queries  text[] := array[
    'best ai receptionist for a small business',
    'what is the best ai phone answering service',
    'how can a small business show up in chatgpt answers'
  ];

  v_client uuid;
  v_loc    uuid;
  v_i      int;
  v_report text;
begin
  select u.client_id into v_client from users u where lower(u.email) = lower(v_email) limit 1;
  if v_client is null then
    raise exception 'No user with email %.', v_email;
  end if;

  -- What's there before the wipe, so the dry run shows exactly what goes.
  select format('BEFORE: workspace "%s"; %s locations (%s); %s keywords; %s rankings; %s findings; %s actions; %s AI questions; %s reports; %s SEO job rows',
           (select name from clients where id = v_client),
           (select count(*) from seo_locations where client_id = v_client),
           (select string_agg(name, ', ') from seo_locations where client_id = v_client),
           (select count(*) from seo_keywords where client_id = v_client),
           (select count(*) from seo_rankings where client_id = v_client),
           (select count(*) from seo_findings where client_id = v_client),
           (select count(*) from seo_actions where client_id = v_client),
           (select count(*) from seo_ai_queries where client_id = v_client),
           (select count(*) from seo_reports where client_id = v_client),
           (select count(*) from job_attempts where client_id = v_client and job_type like 'seo\_%'))
    into v_report;
  raise notice '%', v_report;

  -- ---------------------------------------------------------------------------
  -- Wipe the demo (children cascade from seo_locations), including the
  -- parked job rows, so the real jobs become due.
  -- ---------------------------------------------------------------------------
  delete from seo_reports     where client_id = v_client;
  delete from seo_ai_queries  where client_id = v_client;
  delete from seo_locations   where client_id = v_client;
  delete from job_attempts    where client_id = v_client and job_type like 'seo\_%';

  update clients set name = 'LumiLink', products = '{seo}' where id = v_client;

  insert into entitlements (client_id, feature, status, source, seat_count, activated_at)
  values (v_client, 'seo', 'active', 'manual', 1, now())
  on conflict (client_id, feature) do update
    set status = 'active', source = 'manual', seat_count = 1, canceled_at = null;

  -- ---------------------------------------------------------------------------
  -- The one location. No street address or phone: LumiLink is online-only.
  -- lat/lng left null so the geocode job fills them from the city.
  -- ---------------------------------------------------------------------------
  insert into seo_locations (client_id, name, city, region, country_code,
                             website_url, search_console_site_url, primary_category)
  values (v_client, 'LumiLink', 'Los Angeles', 'CA', 'US',
          v_site, v_sc_site, 'Software company')
  returning id into v_loc;

  insert into seo_keywords (client_id, location_id, keyword)
  select v_client, v_loc, k from unnest(v_keywords) k;

  for v_i in 1..array_length(v_competitors, 1) loop
    insert into seo_competitors (client_id, location_id, domain, label)
    values (v_client, v_loc, v_competitors[v_i][1], v_competitors[v_i][2]);
  end loop;

  insert into seo_ai_queries (client_id, query)
  select v_client, q from unnest(v_ai_queries) q;

  if not exists (select 1 from google_oauth_connections
                  where client_id = v_client and status = 'connected') then
    raise notice 'Heads up: no connected Google account for this workspace, so URL Inspection will be skipped until you connect one in Settings.';
  end if;

  select format('AFTER: workspace "%s"; %s locations; %s keywords; %s competitors; %s AI questions; %s rankings/findings/actions/reports left; %s SEO job rows; Google connected: %s',
           (select name from clients where id = v_client),
           (select count(*) from seo_locations where client_id = v_client),
           (select count(*) from seo_keywords where client_id = v_client),
           (select count(*) from seo_competitors where client_id = v_client),
           (select count(*) from seo_ai_queries where client_id = v_client),
           (select count(*) from seo_rankings where client_id = v_client)
             + (select count(*) from seo_findings where client_id = v_client)
             + (select count(*) from seo_actions where client_id = v_client)
             + (select count(*) from seo_reports where client_id = v_client),
           (select count(*) from job_attempts where client_id = v_client and job_type like 'seo\_%'),
           exists (select 1 from google_oauth_connections where client_id = v_client and status = 'connected'))
    into v_report;
  raise notice '%', v_report;

  if v_dry_run then
    -- Raising aborts the DO block, and Postgres rolls back every change above.
    raise exception 'DRY RUN, nothing was changed. Check the BEFORE/AFTER notices, then set v_dry_run := false and run again.';
  end if;

  raise notice 'LumiLink SEO workspace ready: client %, location %.', v_client, v_loc;
end $$;
