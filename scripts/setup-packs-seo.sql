-- =============================================================================
-- scripts/setup-packs-seo.sql — set up PACKS's live SEO workspace (2026-10-06)
-- and remove the old "Packs OC (Rec)" test location from the "demo test"
-- workspace.
--
-- HOW TO USE
--   1. Run this whole file in the Supabase SQL editor (production) as-is.
--      v_dry_run is true: it does everything, prints what it did, then raises
--      "DRY RUN" and Postgres rolls the lot back. Nothing changes.
--   2. If the output looks right, set v_dry_run := false and run it again.
--
-- WHAT IT DOES
--   * PACKS workspace (signed up as emmanuel@packsglobal.com): sets products
--     to SEO only (PACKS doesn't use the phone agent; 2026-10-09), an active trial SEO entitlement for 4 locations, brand term
--     'packs' and $2 per click, and the 5 AI queries (active).
--   * 4 locations on https://www.packsclub.com, each with 3 keywords (local
--     phrase, plus "dispensary near me" and "packs dispensary" on the map
--     grid) and 4 competitors. Hollywood has no store page yet: the homepage
--     links it to /menu/south-los-angeles, which is a different store.
--     lat/lng are left empty for the geocode job.
--   * Deletes the "Packs OC (Rec)" location (its keywords, rankings, findings
--     etc. cascade) and the SEO entitlement on "demo test". The demo test
--     workspace and its login stay.
--
-- THIS REACHES VENDORS. Every SEO job is due on its next tick for the new
-- locations: crawl, audit, rank checks + geo grids, AI visibility, backlinks,
-- drafting (Anthropic) and geocoding.
-- =============================================================================

do $$
declare
  v_dry_run boolean := true;   -- set to false for the real run
  v_packs   uuid := '91fec91b-b0a4-419a-a85b-743aae18073a';
  v_demo    uuid := 'd662df65-bfe6-4ce1-a356-960135c62b98';
  v_old_loc uuid := 'a12a265d-3af1-46ba-b438-8c075187fe86';
  v_site    text := 'https://www.packsclub.com';
  v_comps   text[] := array['catalyst-cannabis.com', 'stiiizy.com', 'cookiesdispensary.com', 'gowonderland.com'];
  v_ai      text[] := array['Best dispensary orange county', 'packs dispensary', 'dispensary in santa ana',
                            'recreational dispensary orange county', 'dispensary near me'];
  -- name, address, city, zip, phone, store page (null = none), local keyword
  v_locs    text[][] := array[
    array['PACKS OC – Santa Ana',      '2840 S Croddy Way',    'Santa Ana',      '92704', '6573859975', '/menu/orange-county',      'dispensary santa ana'],
    array['PACKS SGV – El Monte',      '3551 Peck Rd',         'El Monte',       '91731', '6264064822', '/menu/san-gabriel-valley', 'dispensary el monte'],
    array['PACKS SB – San Bernardino', '2211 S Hunts Ln',      'San Bernardino', '92408', '9095334074', '/menu/san-bernardino',     'dispensary san bernardino'],
    array['PACKS Hollywood',           '1944 Cahuenga Blvd N', 'Los Angeles',    '90068', '3238537714', null,                       'dispensary hollywood']
  ];
  v_loc_id  uuid;
  v_n       int;
  i         int;
begin
  if not exists (select 1 from clients where id = v_packs and name = 'PACKS') then
    raise exception 'PACKS client % not found', v_packs;
  end if;
  if exists (select 1 from seo_locations where client_id = v_packs) then
    raise exception 'PACKS already has SEO locations; this script only sets up an empty workspace';
  end if;

  -- SEO only, not appended: signup defaults products to {voice}, and keeping
  -- it gave PACKS the Phone Agent pages and its onboarding steps (2026-10-09).
  update clients set products = array['seo'] where id = v_packs;

  insert into entitlements (client_id, feature, status, source, seat_count, started_at, activated_at)
  values (v_packs, 'seo', 'active', 'trial', 4, now(), now());

  insert into seo_client_settings (client_id, brand_terms, value_per_click_cents)
  values (v_packs, array['packs'], 200)
  on conflict (client_id) do update
    set brand_terms = excluded.brand_terms, value_per_click_cents = excluded.value_per_click_cents;

  for i in 1 .. array_length(v_locs, 1) loop
    insert into seo_locations (client_id, name, address_line1, city, region, postal_code, country_code,
                               phone_number, website_url, store_page_url, is_active)
    values (v_packs, v_locs[i][1], v_locs[i][2], v_locs[i][3], 'CA', v_locs[i][4], 'US',
            v_locs[i][5], v_site, case when v_locs[i][6] is null then null else v_site || v_locs[i][6] end, true)
    returning id into v_loc_id;

    insert into seo_keywords (client_id, location_id, keyword, is_geo_grid_enabled, is_active)
    values (v_packs, v_loc_id, v_locs[i][7],         false, true),
           (v_packs, v_loc_id, 'dispensary near me', true,  true),
           (v_packs, v_loc_id, 'packs dispensary',   true,  true);

    insert into seo_competitors (client_id, location_id, domain, is_active)
    select v_packs, v_loc_id, d, true from unnest(v_comps) d;

    raise notice 'added location % (%)', v_locs[i][1], v_loc_id;
  end loop;

  insert into seo_ai_queries (client_id, query, is_active)
  select v_packs, q, true from unnest(v_ai) q;

  -- cleanup: the old test location on "demo test"
  delete from seo_locations where id = v_old_loc and client_id = v_demo;
  get diagnostics v_n = row_count;
  raise notice 'deleted old OC test location: %', v_n;

  delete from entitlements where client_id = v_demo and feature = 'seo';
  get diagnostics v_n = row_count;
  raise notice 'deleted demo test SEO entitlement: %', v_n;

  raise notice 'PACKS now: % locations, % keywords, % competitors, % AI queries',
    (select count(*) from seo_locations   where client_id = v_packs),
    (select count(*) from seo_keywords    where client_id = v_packs),
    (select count(*) from seo_competitors where client_id = v_packs),
    (select count(*) from seo_ai_queries  where client_id = v_packs);

  if v_dry_run then
    raise exception 'DRY RUN: everything above was rolled back. Set v_dry_run := false to apply.';
  end if;
end $$;
