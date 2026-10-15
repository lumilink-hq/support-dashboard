-- =============================================================================
-- test_loyalty_campaign_console.sql — non-destructive test of 0215 (Phase 1b
-- module 14): staff create / edit / pause campaigns (store-local times, the
-- started-campaign edit lock, access log), campaign results, and the
-- liability + expiry forecast. Staff + MFA only.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_campaign_console.sql
--
-- To see it FAIL:
--   * in loyalty_staff_campaign_save change "v_old.starts_at <= now()" to "false"
--     -> "save: a started campaign's bonus can't change" fails.
--   * in loyalty_staff_campaign_set_active drop the loyalty_log_access call
--     -> "pause: logged" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

create temp table t (k text primary key, v uuid) on commit drop;
grant select, insert on t to authenticated;

do $$
declare
  v_client uuid;
  v_prog   uuid;
  v_staff  uuid := gen_random_uuid();
  v_tm     uuid;
  v_b      int;
  v_cust   bigint;
begin
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at)
  values (v_staff, 'staff@lumilink.example', '{"business_name":"LumiLink"}', now());
  insert into platform_staff (user_id, email) values (v_staff, 'staff@lumilink.example');
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values (gen_random_uuid(), v_staff, 'test', 'totp', 'verified', now(), now(), 'x');

  insert into clients (name, slug, is_active) values ('Console Test', 'console-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, live_since, timezone, points_expire_after, treatment_since)
  values (v_client, 'console-test.myshopify.com', 'Wave Rewards', 3, now() - interval '400 days', 'America/Los_Angeles',
          '1 year', now() - interval '30 days')
  returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier) values
    (v_prog, 'bronze', 'Bronze', 0, 0, 1.0);
  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents) values
    (v_prog, 'five_off', '$5 off', 'amount_off_order', 750, 500);

  for i in 1..2000 loop
    v_b := ((hashtextextended(v_prog::text || ':' || i::text, 0) % 100) + 100) % 100;
    if v_b >= 10 then v_cust := i; exit; end if;
  end loop;
  v_tm := loyalty_enroll_member(v_prog, v_cust, 't@example.com', 'Tess', null, now() - interval '400 days');
  -- Two balances: one expiring in ~2 months, one in ~5 months (1 year of inactivity).
  perform loyalty_post_entry(v_tm, 1500, 'adjust', 'console-seed', 0, null, 'staff', null, null, 'test', now() - interval '300 days');
  perform loyalty_enroll_member(v_prog, 999001, 'u@example.com', null, null, now() - interval '400 days');
  perform loyalty_post_entry((select id from loyalty_members where program_id = v_prog and shopify_customer_id = 999001),
    300, 'action', 'console-seed2', 0, 'instagram_follow', 'rule', null, null, 'test', now() - interval '210 days');   -- activity: expiry clock starts here
  insert into loyalty_discount_codes (program_id, member_id, reward_key, code, title, value_cents, points_spent, status)
  values (v_prog, v_tm, 'five_off', 'WAVE-CONS0001', '$5 off', 500, 750, 'issued');

  insert into t values ('staff', v_staff), ('prog', v_prog), ('tm', v_tm);
  perform set_config('test.cust', v_cust::text, true);   -- the treatment customer's Shopify id
end $$;

-- --- not staff: refused ---
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
declare v_ok boolean;
begin
  begin
    perform loyalty_staff_campaigns((select v from t where k = 'prog'));
    v_ok := false;
  exception when insufficient_privilege then v_ok := sqlerrm = 'not_staff';
  end;
  assert v_ok, 'gate: not staff is refused';
end $$;
reset role;

-- --- staff without MFA: refused ---
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'staff'), 'aal', 'aal1')::text, true);
set local role authenticated;
do $$
declare v_ok boolean;
begin
  begin
    perform loyalty_staff_campaign_save((select v from t where k = 'prog'), null,
      '{"name":"x","kind":"flat","flat_points":"50","starts_local":"2030-01-01T00:00","ends_local":"2030-01-02T00:00"}');
    v_ok := false;
  exception when insufficient_privilege then v_ok := sqlerrm = 'mfa_required';
  end;
  assert v_ok, 'gate: staff need MFA';
end $$;
reset role;

-- --- staff with MFA ---
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'staff'), 'aal', 'aal2')::text, true);
set local role authenticated;
do $$
declare
  v_prog uuid := (select v from t where k = 'prog');
  v_id   uuid;
  v_live uuid;
  v_s    jsonb;
  v_c    jsonb;
  v_f    jsonb;
  v_ok   boolean;
  v_start text := to_char((now() + interval '2 days') at time zone 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI');
  v_end   text := to_char((now() + interval '5 days') at time zone 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI');
begin
  -- create (upcoming), key from the name and start date
  v_id := loyalty_staff_campaign_save(v_prog, null, jsonb_build_object(
    'name', 'Double points: New Arrivals!', 'kind', 'multiplier', 'multiplier', '2', 'product_tag', 'New',
    'starts_local', v_start, 'ends_local', v_end, 'announce', true));
  v_s := loyalty_staff_campaigns(v_prog);
  v_c := (select x from jsonb_array_elements(v_s->'campaigns') x where x->>'id' = v_id::text);
  assert v_c->>'status' = 'upcoming' and v_c->>'key' ~ '^double_points_new_arrivals_[0-9]{8}$' and v_c->>'created_by' = 'staff@lumilink.example',
    format('create: upcoming, key from name + date, got %s', v_c);
  assert v_c->>'starts_local' = v_start and v_c #>> '{scope,products}' = '0' and v_c->'scope'->>'resolved_at' is null,
    'create: store-local times round-trip; tag scope waits to be resolved';
  assert (v_s->>'live')::boolean, 'list: program is live';

  -- edit before start: anything
  perform loyalty_staff_campaign_save(v_prog, v_id, jsonb_build_object(
    'name', 'Triple points', 'kind', 'multiplier', 'multiplier', '3', 'collection_gid', '445566',
    'starts_local', v_start, 'ends_local', v_end));
  v_c := (select x from jsonb_array_elements(loyalty_staff_campaigns(v_prog)->'campaigns') x where x->>'id' = v_id::text);
  assert (v_c->>'multiplier')::numeric = 3 and v_c->>'collection_gid' = 'gid://shopify/Collection/445566' and v_c->'product_tag' = 'null'::jsonb
     and v_c->>'name' = 'Triple points', 'save: before the start everything can change; bare collection id accepted';

  begin
    perform loyalty_staff_campaign_save(v_prog, null, jsonb_build_object('name', 'Both', 'kind', 'flat', 'flat_points', '10',
      'collection_gid', '1', 'product_tag', 'x', 'starts_local', v_start, 'ends_local', v_end));
    v_ok := false;
  exception when raise_exception then v_ok := sqlerrm like '%not both%';
  end;
  assert v_ok, 'save: collection and tag together refused';
  begin
    perform loyalty_staff_campaign_save(v_prog, null, jsonb_build_object('name', 'Backwards', 'kind', 'flat', 'flat_points', '10',
      'starts_local', v_end, 'ends_local', v_start));
    v_ok := false;
  exception when raise_exception then v_ok := sqlerrm like '%end must be after%';
  end;
  assert v_ok, 'save: end before start refused';
  begin
    perform loyalty_staff_campaign_save(v_prog, null, jsonb_build_object('name', 'Past', 'kind', 'flat', 'flat_points', '10',
      'starts_local', '2020-01-01T00:00', 'ends_local', v_end));
    v_ok := false;
  exception when raise_exception then v_ok := sqlerrm like '%start in the past%';
  end;
  assert v_ok, 'save: a new campaign can''t start in the past';

  -- a started campaign: only name / end / announce
  v_live := loyalty_staff_campaign_save(v_prog, null, jsonb_build_object(
    'name', 'Flat 50', 'kind', 'flat', 'flat_points', '50',
    'starts_local', to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI'), 'ends_local', v_end));
  insert into t values ('live', v_live);
end $$;
reset role;

-- Started a minute ago (set as the owner: staff can't start a campaign in the past).
update loyalty_campaigns set starts_at = now() - interval '1 hour' where id = (select v from t where k = 'live');
-- One bonus order for results.
do $$
begin
  perform loyalty_record_order((select v from t where k = 'prog'),
    jsonb_build_object('id', 8801, 'processed_at', (now() - interval '10 minutes')::text, 'eligible_cents', 4000,
                       'customer', jsonb_build_object('id', current_setting('test.cust')::bigint, 'email', 't@example.com')), 'webhook');
  assert loyalty_apply_campaigns((select v from t where k = 'prog'), '{"id":8801}') = 50, 'setup: bonus awarded';
end $$;

set local role authenticated;
do $$
declare
  v_prog uuid := (select v from t where k = 'prog');
  v_live uuid := (select v from t where k = 'live');
  v_c    jsonb;
  v_f    jsonb;
  v_ok   boolean;
  v_start text;
begin
  -- What the edit form sends back: the start to the minute.
  v_start := (select x->>'starts_local' from jsonb_array_elements(loyalty_staff_campaigns(v_prog)->'campaigns') x where x->>'id' = v_live::text);
  begin
    perform loyalty_staff_campaign_save(v_prog, v_live, jsonb_build_object(
      'name', 'Flat 500', 'kind', 'flat', 'flat_points', '500', 'starts_local', v_start, 'ends_local', '2030-01-01T00:00'));
    v_ok := false;
  exception when raise_exception then v_ok := sqlerrm like '%has started%';
  end;
  assert v_ok, 'save: a started campaign''s bonus can''t change';

  perform loyalty_staff_campaign_save(v_prog, v_live, jsonb_build_object(
    'name', 'Flat 50 (extended)', 'kind', 'flat', 'flat_points', '50', 'starts_local', v_start,
    'ends_local', '2030-01-01T00:00', 'announce', false));
  v_c := (select x from jsonb_array_elements(loyalty_staff_campaigns(v_prog)->'campaigns') x where x->>'id' = v_live::text);
  assert v_c->>'name' = 'Flat 50 (extended)' and not (v_c->>'announce')::boolean and v_c->>'ends_local' = '2030-01-01T00:00',
    'save: a started campaign''s name, end and announce can change (form start, to the minute)';

  assert v_c->>'status' = 'running' and (v_c #>> '{results,orders}')::int = 1 and (v_c #>> '{results,bonus_points}')::int = 50
     and (v_c #>> '{results,revenue_cents}')::int = 4000 and (v_c #>> '{results,members}')::int = 1,
    format('results: orders, bonus points, revenue, members, got %s', v_c->'results');
  assert v_c->'window' is not null and v_c #>> '{window,aa_check}' = 'false', 'results: window comparison included';

  assert loyalty_staff_campaign_set_active(v_live, false), 'pause: paused';
  assert not loyalty_staff_campaign_set_active(v_live, false), 'pause: already paused is a no-op';
  assert (select x->>'status' from jsonb_array_elements(loyalty_staff_campaigns(v_prog)->'campaigns') x where x->>'id' = v_live::text) = 'paused',
    'pause: shows as paused';

  -- forecast: Tess 1,500 + 120 order + 50 bonus (her order just reset her clock: a year out),
  -- the other member 300 from an action 210 days ago (expires ~155 days out); $5 per 750 points.
  v_f := loyalty_staff_forecast(v_prog);
  assert (v_f #>> '{outstanding,points}')::int = 1970 and (v_f #>> '{outstanding,cents}')::int = 1313
     and (v_f #>> '{unused_codes,cents}')::int = 500, format('forecast: liability and unused codes, got %s', v_f);
  assert jsonb_array_length(v_f->'expiring') = 6
     and (select sum((x->>'points')::int) from jsonb_array_elements(v_f->'expiring') x) = 300
     and (select count(*) from jsonb_array_elements(v_f->'expiring') x where (x->>'points')::int > 0) = 1,
    format('forecast: only the inactive balance expires in the next 6 months, got %s', v_f->'expiring');
end $$;
reset role;

do $$
begin
  assert (select count(*) from loyalty_access_log where action = 'campaign_save' and staff_email = 'staff@lumilink.example') = 4,
    'save: logged (create, edit, create, edit)';
  assert (select count(*) from loyalty_access_log where action = 'campaign_active' and detail->>'active' = 'false') = 1,
    'pause: logged';
  raise notice 'test_loyalty_campaign_console: all assertions passed';
end $$;

rollback;
