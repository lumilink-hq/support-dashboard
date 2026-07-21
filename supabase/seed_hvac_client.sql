-- =============================================================================
-- seed_hvac_client.sql — demo HVAC pilot client for the scheduling MVP.
-- Run in the Supabase SQL editor (NOT part of db reset). Idempotent: re-running
-- updates the client and rebuilds its service list.
--
-- After seeding: set phone_number to your ElevenLabs number, and use any work
-- email to sign in as this workspace's admin (Google Calendar not required —
-- Supabase is the source of truth for the MVP).
-- =============================================================================

do $$
declare
  v_client uuid;
begin
  -- Upsert the client (persona "Lumi" for the demo; structured scheduling config).
  insert into clients (
    name, slug, is_active, phone_number,
    brand_tone_config, business_hours, settings
  ) values (
    'Comfort Air (Demo)',
    'comfort-air-demo',
    true,
    null,  -- <-- set to your ElevenLabs phone number in E.164, e.g. +14155550123
    jsonb_build_object(
      'voice',   'warm, professional, efficient',
      'sign_off', '',
      'use_emoji', false,
      'persona', 'Lumi'
    ),
    jsonb_build_object('tz','America/Los_Angeles','hours','Mon-Fri 08:00-18:00, Sat 09:00-14:00'),
    jsonb_build_object(
      'is_demo', true,
      'scheduling', jsonb_build_object(
        'timezone', 'America/Los_Angeles',
        -- structured weekly hours the availability engine reads (24h, local time)
        'hours', jsonb_build_object(
          'mon', jsonb_build_array('08:00','18:00'),
          'tue', jsonb_build_array('08:00','18:00'),
          'wed', jsonb_build_array('08:00','18:00'),
          'thu', jsonb_build_array('08:00','18:00'),
          'fri', jsonb_build_array('08:00','18:00'),
          'sat', jsonb_build_array('09:00','14:00'),
          'sun', jsonb_build_array()               -- closed
        ),
        'slot_granularity_minutes', 30,
        'min_notice_minutes', 120,
        'service_area', 'Within 25 miles of San Francisco, CA',
        'persona', 'Lumi'
      ),
      'transfer_number', null                       -- optional human on-call line
    )
  )
  on conflict (slug) do update set
    name              = excluded.name,
    is_active         = excluded.is_active,
    brand_tone_config = excluded.brand_tone_config,
    business_hours    = excluded.business_hours,
    settings          = excluded.settings,
    updated_at        = now()
  returning id into v_client;

  -- Rebuild the service list (idempotent).
  delete from services where client_id = v_client;

  insert into services (client_id, name, category, price_type, price, callout_fee, default_duration_min, emergency_eligible) values
    (v_client, 'Service Call / Diagnostic', 'diagnostic', 'quote', null, 89,  60, true),
    (v_client, 'AC Tune-Up',                'maintenance','fixed', 99,   null, 60, false),
    (v_client, 'Furnace Tune-Up',           'maintenance','fixed', 109,  null, 60, false),
    (v_client, 'AC Repair',                 'repair',     'quote', null, 89,  90, true),
    (v_client, 'Heating / Furnace Repair',  'repair',     'quote', null, 89,  90, true),
    (v_client, 'New System Estimate',       'sales',      'fixed', 0,    null, 60, false);
end $$;

-- Confirm what was seeded.
select c.slug, c.id as client_id, s.name, s.price_type, s.price, s.callout_fee, s.default_duration_min, s.emergency_eligible
from clients c
join services s on s.client_id = c.id
where c.slug = 'comfort-air-demo'
order by s.name;
