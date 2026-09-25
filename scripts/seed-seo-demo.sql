-- =============================================================================
-- scripts/seed-seo-demo.sql — the SEO demo workspace.
--
-- Fills an EXISTING workspace with a believable, fictional SEO history so the
-- whole portal has something to show: two locations, keywords, 12 weeks of
-- organic and map-pack rankings, a 5x5 geo grid, competitors, backlinks, AI
-- search visibility, audit findings, an approval queue (a fix, an article and
-- a hand-apply item), published work, and last month's report.
--
-- HOW TO USE
--   1. Sign up at lumilinkhub.com/signup?product=seo with the demo email below
--      (the account is created the normal way; this script never creates one).
--   2. Run this whole file in the Supabase SQL editor (production). It finds
--      the workspace by the user's email.
--   3. Re-run it any time to refresh: it wipes the workspace's SEO data and
--      re-seeds with dates relative to today.
--
-- NOTHING HERE REACHES A VENDOR. Every scheduled SEO job reads job_attempts'
-- next_run_at; the script parks each of the workspace's jobs at 'infinity', so
-- the crawl, rank checks (DataForSEO), backlinks, AI visibility, article
-- drafting (Anthropic/Replicate), geocoding and the monthly report email never
-- run for it. The website is a lumilinkhub.com subdomain that doesn't exist.
-- A location ADDED later through the UI would get its own jobs; don't add one.
--
-- The entitlement is source 'manual' with no Stripe subscription, so /billing
-- shows it active without a plan name. Google Business Profile metrics are not
-- seeded: that integration isn't live, and the site doesn't claim it.
-- =============================================================================

do $$
declare
  v_email  text := 'lumilinkhq@gmail.com';
  v_client uuid;
  v_site   text := 'https://harborpine.lumilinkhub.com';
  v_loc1   uuid;
  v_loc2   uuid;
  v_loc    uuid;
  v_kw     uuid;
  v_comp   uuid;
  v_q      uuid;
  v_week   int;
  v_i      int;
  v_r      int;
  v_c      int;
  v_ring   int;
  v_start  int;
  v_end    int;
  v_pos    int;
  v_date   date;
  v_prev_month date := (date_trunc('month', current_date) - interval '1 month')::date;
  -- Per location: keyword, organic start->end, local pack start->end (0 = not in pack), geo grid?
  v_kws    jsonb := jsonb_build_array(
    jsonb_build_array(
      jsonb_build_array('plumber santa ana',               14, 4,  7, 2, true),
      jsonb_build_array('emergency plumber santa ana',     22, 8, 16, 3, true),
      jsonb_build_array('water heater repair santa ana',    9, 3,  5, 1, false),
      jsonb_build_array('drain cleaning santa ana',        18, 6,  9, 4, false),
      jsonb_build_array('tankless water heater installation', 31, 12, 0, 0, false)
    ),
    jsonb_build_array(
      jsonb_build_array('plumber irvine',                  19, 7, 15, 3, true),
      jsonb_build_array('emergency plumber irvine',        27, 11, 18, 5, false),
      jsonb_build_array('water heater repair irvine',      12, 5,  8, 2, false),
      jsonb_build_array('leak detection irvine',           16, 9, 19, 6, false),
      jsonb_build_array('repipe specialist irvine',        24, 10, 0, 0, false)
    )
  );
  v_k      jsonb;
begin
  select u.client_id into v_client from users u where lower(u.email) = lower(v_email) limit 1;
  if v_client is null then
    raise exception 'No user with email % — sign up first, then run this again.', v_email;
  end if;

  -- ---------------------------------------------------------------------------
  -- Wipe this workspace's SEO data (children cascade from seo_locations).
  -- ---------------------------------------------------------------------------
  delete from seo_reports     where client_id = v_client;
  delete from seo_ai_queries  where client_id = v_client;
  delete from seo_locations   where client_id = v_client;
  delete from job_attempts    where client_id = v_client and job_type like 'seo\_%';

  -- ---------------------------------------------------------------------------
  -- Workspace: SEO only, onboarding's SEO steps done, entitlement active.
  -- ---------------------------------------------------------------------------
  update clients
     set name = 'Harbor & Pine Plumbing',
         business_type = 'service',
         products = '{seo}',
         settings = jsonb_set(
           coalesce(settings, '{}'::jsonb),
           '{onboarding}',
           jsonb_build_object(
             'started_at', now() - interval '100 days',
             'steps', jsonb_build_object(
               'seo_locations',   jsonb_build_object('done', true, 'skipped', false, 'at', now() - interval '100 days'),
               'seo_keywords',    jsonb_build_object('done', true, 'skipped', false, 'at', now() - interval '100 days'),
               'seo_competitors', jsonb_build_object('done', true, 'skipped', false, 'at', now() - interval '100 days')
             )
           )
         )
   where id = v_client;

  insert into entitlements (client_id, feature, status, source, seat_count, activated_at)
  values (v_client, 'seo', 'active', 'manual', 2, now() - interval '100 days')
  on conflict (client_id, feature) do update
    set status = 'active', source = 'manual', seat_count = 2, canceled_at = null;

  -- ---------------------------------------------------------------------------
  -- Locations (fictional business; lat/lng set so geocoding has nothing to do).
  -- ---------------------------------------------------------------------------
  insert into seo_locations (client_id, name, address_line1, city, region, postal_code, country_code,
                             lat, lng, phone_number, website_url, primary_category, created_at)
  values (v_client, 'Harbor & Pine Plumbing — Santa Ana', '1420 E Edinger Ave', 'Santa Ana', 'CA', '92705', 'US',
          33.717500, -117.852000, '(714) 555-0142', v_site, 'Plumber', now() - interval '100 days')
  returning id into v_loc1;

  insert into seo_locations (client_id, name, address_line1, city, region, postal_code, country_code,
                             lat, lng, phone_number, website_url, primary_category, created_at)
  values (v_client, 'Harbor & Pine Plumbing — Irvine', '17875 Von Karman Ave', 'Irvine', 'CA', '92614', 'US',
          33.684600, -117.826500, '(949) 555-0187', v_site || '/irvine', 'Plumber', now() - interval '100 days')
  returning id into v_loc2;

  -- ---------------------------------------------------------------------------
  -- Park every scheduled SEO job for this workspace, forever.
  -- ---------------------------------------------------------------------------
  insert into job_attempts (client_id, job_type, entity_id, next_run_at)
  select v_client, t, l, 'infinity'::timestamptz
    from unnest(array['seo_crawl','seo_technical_audit','seo_rank_submit','seo_backlinks',
                      'seo_draft','seo_geocode','seo_publish','seo_site_check']) t
   cross join unnest(array[v_loc1, v_loc2]) l;
  insert into job_attempts (client_id, job_type, entity_id, next_run_at)
  select v_client, t, null, 'infinity'::timestamptz
    from unnest(array['seo_ai_visibility','seo_content','seo_report']) t;

  -- ---------------------------------------------------------------------------
  -- Keywords, 12 weekly rank checks, competitors, and the geo grid.
  -- ---------------------------------------------------------------------------
  for v_i in 0..1 loop
    v_loc := case v_i when 0 then v_loc1 else v_loc2 end;

    -- Competitors (fictional names).
    insert into seo_competitors (client_id, location_id, domain, label, created_at)
    values
      (v_client, v_loc, 'coastlinerooterco.com',  'Coastline Rooter Co.',  now() - interval '100 days'),
      (v_client, v_loc, 'orangeblossomplumbing.com', 'Orange Blossom Plumbing', now() - interval '100 days'),
      (v_client, v_loc, 'swiftflowservices.com',  'SwiftFlow Services',    now() - interval '100 days');

    for v_k in select * from jsonb_array_elements(v_kws -> v_i) loop
      insert into seo_keywords (client_id, location_id, keyword, is_geo_grid_enabled, enabled_at, created_at)
      values (v_client, v_loc, v_k ->> 0, (v_k ->> 5)::boolean,
              case when (v_k ->> 5)::boolean then now() - interval '90 days' end, now() - interval '100 days')
      returning id into v_kw;

      for v_week in 0..11 loop
        v_date := current_date - (7 * v_week) - 2;

        -- Organic: straight line from the start position (12 weeks ago) to today's, +/-1 of noise.
        v_start := (v_k ->> 1)::int;  v_end := (v_k ->> 2)::int;
        v_pos := greatest(1, round(v_end + (v_start - v_end) * v_week / 11.0)::int
                             + (abs(hashtext(v_kw::text || v_week)) % 3) - 1);
        insert into seo_rankings (client_id, location_id, keyword_id, rank_type, position, serp_url, check_date, checked_at)
        values (v_client, v_loc, v_kw, 'organic', v_pos, v_site || '/services', v_date, v_date + time '06:00');

        -- Map pack: 0 means "not in the pack" at that end of the range.
        v_start := coalesce(nullif((v_k ->> 3)::int, 0), 25);  v_end := coalesce(nullif((v_k ->> 4)::int, 0), 25);
        v_pos := round(v_end + (v_start - v_end) * v_week / 11.0)::int;
        insert into seo_rankings (client_id, location_id, keyword_id, rank_type, position, check_date, checked_at)
        values (v_client, v_loc, v_kw, 'local_pack', case when v_pos > 20 then null else greatest(v_pos, 1) end,
                v_date, v_date + time '06:00');

        -- Competitors: roughly flat, a little ahead of where the client started.
        v_c := 0;
        for v_comp in select id from seo_competitors where location_id = v_loc order by domain loop
          v_c := v_c + 1;
          insert into seo_competitor_rankings (client_id, location_id, competitor_id, keyword_id, rank_type, position, check_date)
          values (v_client, v_loc, v_comp, v_kw, 'organic',
                  case when v_c = 3 and (v_k ->> 1)::int > 25 then null
                       else greatest(1, (v_k ->> 2)::int + v_c * 2 - 1 + (abs(hashtext(v_comp::text || v_kw::text || v_week)) % 3)) end,
                  v_date);
        end loop;
      end loop;

      -- Geo grid (latest sweep only): strong at the address, fading outward.
      if (v_k ->> 5)::boolean then
        for v_r in 1..5 loop
          for v_c in 1..5 loop
            v_ring := greatest(abs(v_r - 3), abs(v_c - 3));
            v_pos := case v_ring
                       when 0 then 1
                       when 1 then 1 + (abs(hashtext(v_kw::text || v_r || v_c)) % 3)
                       else case when abs(hashtext(v_kw::text || v_r || v_c)) % 4 = 0 then null
                                 else 4 + (abs(hashtext(v_kw::text || v_c || v_r)) % 8) end
                     end;
            insert into seo_rankings (client_id, location_id, keyword_id, rank_type, grid_row, grid_col, position, check_date, checked_at)
            values (v_client, v_loc, v_kw, 'geo_grid', v_r, v_c, v_pos, current_date - 2, (current_date - 2) + time '06:30');
          end loop;
        end loop;
      end if;
    end loop;

    -- Backlinks: six monthly snapshots, growing.
    for v_week in 0..5 loop
      insert into seo_backlink_snapshots (client_id, location_id, snapshot_date, referring_domains_count,
                                          total_backlinks, gained_count, lost_count, top_linked_pages)
      values (v_client, v_loc,
              (date_trunc('month', current_date) - make_interval(months => v_week))::date + 1,
              (61 - v_week * 4) - v_i * 18, (340 - v_week * 26) - v_i * 120,
              7 - (v_week % 3), 2 + (v_week % 2),
              jsonb_build_array(
                jsonb_build_object('url', v_site || '/', 'backlinks', 120 - v_week * 9),
                jsonb_build_object('url', v_site || '/services/water-heaters', 'backlinks', 44 - v_week * 3),
                jsonb_build_object('url', v_site || '/blog/signs-your-water-heater-is-failing', 'backlinks', 21 - v_week * 2)
              ));
    end loop;
  end loop;

  -- ---------------------------------------------------------------------------
  -- Audit findings.
  -- ---------------------------------------------------------------------------
  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, target_url, details, status, detected_at, resolved_at)
  values
    (v_client, v_loc1, 'crawl', 'missing_meta_description', 'warning', 'Page has no meta description',
     v_site || '/services/water-heaters', '{}', 'actioned', now() - interval '6 days', null),
    (v_client, v_loc1, 'crawl', 'missing_local_business_schema', 'warning', 'No LocalBusiness structured data',
     v_site || '/', '{}', 'open', now() - interval '6 days', null),
    (v_client, v_loc1, 'crawl', 'images_missing_alt', 'info', '7 images are missing alt text',
     v_site || '/gallery', '{"count": 7}', 'open', now() - interval '6 days', null),
    (v_client, v_loc1, 'crawl', 'thin_content', 'info', 'Thin content (142 words)',
     v_site || '/about', '{"word_count": 142}', 'open', now() - interval '6 days', null),
    (v_client, v_loc1, 'technical', 'pagespeed_lab_performance', 'warning', 'Mobile performance score is 54',
     v_site || '/', '{"strategy": "mobile", "score": 54}', 'open', now() - interval '5 days', null),
    (v_client, v_loc1, 'crawl', 'title_length', 'info', 'Title is 78 characters (aim for under 60)',
     v_site || '/services/drain-cleaning', '{}', 'resolved', now() - interval '40 days', now() - interval '33 days'),
    (v_client, v_loc2, 'crawl', 'missing_h1', 'warning', 'Page has no H1 heading',
     v_site || '/irvine', '{}', 'actioned', now() - interval '6 days', null),
    (v_client, v_loc2, 'crawl', 'phone_not_on_page', 'warning', 'The location''s phone number isn''t on its page',
     v_site || '/irvine', '{"expected": "(949) 555-0187"}', 'open', now() - interval '6 days', null),
    (v_client, v_loc2, 'technical', 'search_console_not_indexed', 'critical', 'Page is not indexed by Google',
     v_site || '/irvine/leak-detection', '{"coverage_state": "Discovered - currently not indexed"}', 'open', now() - interval '5 days', null);

  -- ---------------------------------------------------------------------------
  -- Work: published (last 60 days), waiting for approval, and hand-apply.
  -- ---------------------------------------------------------------------------
  insert into seo_actions (client_id, location_id, action_type, target_field, target_url, previous_value, proposed_value,
                           diff, status, idempotency_key, drafted_by, apply_mode, publish_result,
                           approved_at, published_at, created_at)
  values
    (v_client, v_loc1, 'onpage_fix', 'title_tag', v_site || '/services/drain-cleaning',
     '"Drain Cleaning Services | Harbor & Pine Plumbing | Santa Ana, Orange County, CA"',
     '{"value": "Drain Cleaning in Santa Ana | Harbor & Pine Plumbing"}',
     '{"field": "title_tag", "before": "Drain Cleaning Services | Harbor & Pine Plumbing | Santa Ana, Orange County, CA", "after": "Drain Cleaning in Santa Ana | Harbor & Pine Plumbing"}',
     'published', 'demo:' || v_client || ':1', 'sonnet-class', 'manual', '{}',
     now() - interval '35 days', now() - interval '33 days', now() - interval '38 days'),
    (v_client, v_loc1, 'content_publish', 'article', v_site || '/blog/signs-your-water-heater-is-failing', null,
     '{"kind": "article", "title": "7 Signs Your Water Heater Is About to Fail", "keyword": "water heater repair santa ana", "word_count": 1180}',
     null, 'published', 'demo:' || v_client || ':2', 'sonnet-class', 'manual', '{}',
     now() - interval '20 days', now() - interval '19 days', now() - interval '22 days'),
    (v_client, v_loc2, 'onpage_fix', 'meta_description', v_site || '/irvine',
     'null',
     '{"value": "Licensed Irvine plumbers for leaks, water heaters and repipes. Same-day service, upfront pricing. Call (949) 555-0187."}',
     '{"field": "meta_description", "before": null, "after": "Licensed Irvine plumbers for leaks, water heaters and repipes. Same-day service, upfront pricing. Call (949) 555-0187."}',
     'published', 'demo:' || v_client || ':3', 'sonnet-class', 'manual', '{}',
     now() - interval '12 days', now() - interval '11 days', now() - interval '14 days');

  -- Waiting for approval: a meta description fix...
  insert into seo_actions (client_id, location_id, finding_id, action_type, target_field, target_url, previous_value,
                           proposed_value, diff, status, idempotency_key, drafted_by, created_at)
  select v_client, v_loc1, f.id, 'onpage_fix', 'meta_description', f.target_url, 'null',
         '{"value": "Water heater repair and replacement in Santa Ana. Tank and tankless, same-day service, 10-year labor warranty. Call (714) 555-0142."}',
         '{"field": "meta_description", "before": null, "after": "Water heater repair and replacement in Santa Ana. Tank and tankless, same-day service, 10-year labor warranty. Call (714) 555-0142."}',
         'pending_approval', 'demo:' || v_client || ':4', 'sonnet-class', now() - interval '5 days'
    from seo_findings f where f.location_id = v_loc1 and f.finding_type = 'missing_meta_description';

  -- ...and an article.
  insert into seo_actions (client_id, location_id, action_type, target_field, target_url, proposed_value, status, idempotency_key, drafted_by, created_at)
  values (v_client, v_loc1, 'content_publish', 'article', null,
    jsonb_build_object(
      'kind', 'article',
      'title', 'Tankless vs. Tank Water Heaters: What Santa Ana Homeowners Should Know',
      'meta_description', 'Comparing tankless and tank water heaters for Santa Ana homes: upfront cost, running cost, lifespan and what fits your household.',
      'keyword', 'tankless water heater installation',
      'word_count', 214,
      'blocks', jsonb_build_array(
        jsonb_build_object('type', 'p',  'text', 'If your water heater is more than ten years old, the question usually isn''t whether to replace it but what to replace it with. Here is how the two main options compare for a typical Santa Ana home.'),
        jsonb_build_object('type', 'h2', 'text', 'How each type works'),
        jsonb_build_object('type', 'p',  'text', 'A tank heater keeps 40 to 50 gallons hot around the clock. A tankless unit heats water only as it flows, so it never runs out but has a limit on how many taps it can serve at once.'),
        jsonb_build_object('type', 'h2', 'text', 'Cost up front and over time'),
        jsonb_build_object('type', 'li', 'text', 'Tank: lower purchase and installation cost, typically replaced every 8 to 12 years.'),
        jsonb_build_object('type', 'li', 'text', 'Tankless: higher installed cost, lower energy use, and a working life closer to 20 years.'),
        jsonb_build_object('type', 'h2', 'text', 'Which one fits your home'),
        jsonb_build_object('type', 'p',  'text', 'Households that run several showers at once, or homes with limited gas line capacity, often do better with a tank. Smaller households and anyone short on garage space tend to prefer tankless. We are happy to look at your setup and give you a straight answer.')
      ),
      'image', null,
      'uniqueness', jsonb_build_object('compared', 4, 'max_overlap', 0.08, 'max_similarity', 0.41, 'warn', false)
    ),
    'pending_approval', 'demo:' || v_client || ':5', 'sonnet-class', now() - interval '3 days');

  -- Hand-apply: the site isn't connected, so the fix comes as instructions.
  insert into seo_actions (client_id, location_id, finding_id, action_type, target_field, target_url, previous_value,
                           proposed_value, diff, status, idempotency_key, drafted_by, apply_mode, manual_instructions,
                           approved_at, created_at)
  select v_client, v_loc2, f.id, 'onpage_fix', 'h1', f.target_url, 'null',
         '{"value": "Irvine Plumbers You Can Count On"}',
         '{"field": "h1", "before": null, "after": "Irvine Plumbers You Can Count On"}',
         'manual_required', 'demo:' || v_client || ':6', 'sonnet-class', 'manual',
         jsonb_build_object(
           'why', 'Your site isn''t connected to LumiLink, so this change has to be made in your site editor.',
           'steps', jsonb_build_array(
             'Open the Irvine page in your site editor.',
             'Find the first heading on the page and set its style to Heading 1 (H1).',
             'Replace its text with the text below, then publish the page.'),
           'copy', jsonb_build_object('label', 'Heading text', 'text', 'Irvine Plumbers You Can Count On')
         ),
         now() - interval '4 days', now() - interval '5 days'
    from seo_findings f where f.location_id = v_loc2 and f.finding_type = 'missing_h1';

  -- ---------------------------------------------------------------------------
  -- AI search visibility: four questions, weekly, two platforms, last 5 weeks.
  -- ---------------------------------------------------------------------------
  for v_i in 1..4 loop
    insert into seo_ai_queries (client_id, query, created_at)
    values (v_client,
            (array['best plumber in orange county', 'tankless water heater cost',
                   'emergency plumber near me', 'how to find a water leak under a slab'])[v_i],
            now() - interval '60 days')
    returning id into v_q;
    for v_week in 0..4 loop
      insert into seo_ai_mentions (client_id, query_id, platform, domain, cited_count, top_sources, check_date)
      select v_client, v_q, p, 'harborpine.lumilinkhub.com',
             case when (v_i + v_week + (p = 'google')::int) % 3 = 0 then 0 else 1 + (v_i % 2) end,
             case when (v_i + v_week + (p = 'google')::int) % 3 = 0 then '[]'::jsonb
                  else jsonb_build_array(jsonb_build_object('domain', 'harborpine.lumilinkhub.com',
                         'url', v_site || '/blog/signs-your-water-heater-is-failing',
                         'title', '7 Signs Your Water Heater Is About to Fail')) end,
             current_date - (7 * v_week) - 1
        from unnest(array['google', 'chat_gpt']) p;
    end loop;
  end loop;

  -- ---------------------------------------------------------------------------
  -- Last month's report (shape: ReportContent, supabase/functions/seo-report/lib.ts).
  -- ---------------------------------------------------------------------------
  insert into seo_reports (client_id, period_start, period_end, content, email_status, emailed_at, created_at)
  select v_client, v_prev_month, (v_prev_month + interval '1 month - 1 day')::date,
    jsonb_build_object(
      'version', 1,
      'client_name', 'Harbor & Pine Plumbing',
      'period', jsonb_build_object('start', v_prev_month, 'end', (v_prev_month + interval '1 month - 1 day')::date,
                                   'label', trim(to_char(v_prev_month, 'Month')) || ' ' || to_char(v_prev_month, 'YYYY')),
      'generated_at', v_prev_month + interval '1 month 6 hours',
      'is_first_report', false,
      'ai_visibility', jsonb_build_object('queries', 4, 'checks', 32, 'cited', 21),
      'locations', jsonb_build_array(
        jsonb_build_object(
          'id', v_loc1, 'name', 'Harbor & Pine Plumbing — Santa Ana',
          'rankings', jsonb_build_object(
            'keywords', jsonb_build_array(
              jsonb_build_object('keyword', 'plumber santa ana',
                'organic', jsonb_build_object('now', 6, 'before', 9, 'checked', true),
                'local_pack', jsonb_build_object('now', 3, 'before', 4, 'checked', true)),
              jsonb_build_object('keyword', 'emergency plumber santa ana',
                'organic', jsonb_build_object('now', 11, 'before', 15, 'checked', true),
                'local_pack', jsonb_build_object('now', 3, 'before', null, 'checked', true)),
              jsonb_build_object('keyword', 'water heater repair santa ana',
                'organic', jsonb_build_object('now', 4, 'before', 5, 'checked', true),
                'local_pack', jsonb_build_object('now', 2, 'before', 3, 'checked', true)),
              jsonb_build_object('keyword', 'drain cleaning santa ana',
                'organic', jsonb_build_object('now', 9, 'before', 12, 'checked', true),
                'local_pack', jsonb_build_object('now', 5, 'before', 7, 'checked', true)),
              jsonb_build_object('keyword', 'tankless water heater installation',
                'organic', jsonb_build_object('now', 17, 'before', 22, 'checked', true),
                'local_pack', jsonb_build_object('now', null, 'before', null, 'checked', true))
            ),
            'organic', jsonb_build_object('checked', 5, 'ranked', 5, 'top3', 0, 'top10', 3, 'avg_position', 9.4),
            'local_pack', jsonb_build_object('checked', 5, 'ranked', 4, 'top3', 3, 'top10', 4, 'avg_position', 3.3)
          ),
          'radius', jsonb_build_object('state', 'measured', 'km', 2.5, 'keywords_checked', 2,
                                       'last_check_date', (v_prev_month + interval '1 month - 3 days')::date,
                                       'statement', 'Right now this location reliably wins the map pack within about 2.5 km of its address.'),
          'profile_metrics', jsonb_build_object('available', false, 'reason',
            'Google Business Profile isn''t connected yet, so views, calls and direction requests aren''t available.'),
          'backlinks', jsonb_build_object('snapshot_date', v_prev_month + 1, 'referring_domains', 57, 'total', 314, 'gained', 6, 'lost', 3),
          'site_connection', null,
          'shipped', jsonb_build_array(
            jsonb_build_object('label', 'Page title', 'detail', null, 'url', v_site || '/services/drain-cleaning',
                               'published_at', v_prev_month + interval '12 days', 'verified', false),
            jsonb_build_object('label', 'Blog article', 'detail', '7 Signs Your Water Heater Is About to Fail',
                               'url', v_site || '/blog/signs-your-water-heater-is-failing',
                               'published_at', v_prev_month + interval '24 days', 'verified', false)
          ),
          'queued', jsonb_build_array(
            jsonb_build_object('label', 'Meta description', 'detail', v_site || '/services/water-heaters', 'needs', 'approval')
          )
        ),
        jsonb_build_object(
          'id', v_loc2, 'name', 'Harbor & Pine Plumbing — Irvine',
          'rankings', jsonb_build_object(
            'keywords', jsonb_build_array(
              jsonb_build_object('keyword', 'plumber irvine',
                'organic', jsonb_build_object('now', 10, 'before', 14, 'checked', true),
                'local_pack', jsonb_build_object('now', 5, 'before', null, 'checked', true)),
              jsonb_build_object('keyword', 'water heater repair irvine',
                'organic', jsonb_build_object('now', 7, 'before', 9, 'checked', true),
                'local_pack', jsonb_build_object('now', 4, 'before', 6, 'checked', true)),
              jsonb_build_object('keyword', 'leak detection irvine',
                'organic', jsonb_build_object('now', 12, 'before', 13, 'checked', true),
                'local_pack', jsonb_build_object('now', null, 'before', null, 'checked', true))
            ),
            'organic', jsonb_build_object('checked', 3, 'ranked', 3, 'top3', 0, 'top10', 2, 'avg_position', 9.7),
            'local_pack', jsonb_build_object('checked', 3, 'ranked', 2, 'top3', 0, 'top10', 2, 'avg_position', 4.5)
          ),
          'radius', jsonb_build_object('state', 'measured', 'km', 1.2, 'keywords_checked', 1,
                                       'last_check_date', (v_prev_month + interval '1 month - 3 days')::date,
                                       'statement', 'Right now this location reliably wins the map pack within about 1.2 km of its address.'),
          'profile_metrics', jsonb_build_object('available', false, 'reason',
            'Google Business Profile isn''t connected yet, so views, calls and direction requests aren''t available.'),
          'backlinks', jsonb_build_object('snapshot_date', v_prev_month + 1, 'referring_domains', 39, 'total', 194, 'gained', 5, 'lost', 2),
          'site_connection', null,
          'shipped', '[]'::jsonb,
          'queued', '[]'::jsonb
        )
      )
    ),
    'sent', v_prev_month + interval '1 month 6 hours', v_prev_month + interval '1 month 6 hours';

  raise notice 'Seeded SEO demo for client % (%).', v_client, v_email;
end $$;
