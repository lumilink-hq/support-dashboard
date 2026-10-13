-- =============================================================================
-- test_loyalty_earning_jobs.sql — non-destructive test of 0202 (LL Loyalty
-- module 3): live-only signup/newsletter, milestones, referrals, and the
-- jobs (expiry, demotion + warning, birthdays, anniversaries) at fixed dates.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_earning_jobs.sql
--
-- To see it FAIL:
--   * in loyalty_record_order drop "p_source = 'webhook' and" from the milestone block
--     -> "milestone: backfill pays none" fails.
--   * in run_loyalty_jobs use v_now::date instead of the program timezone for v_today
--     -> "birthday: not yet in the program's timezone" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_prog   uuid;
  v_alice  uuid;
  v_new    uuid;
  v_old    uuid;
  v_dave   uuid;
  v_erin   uuid;
  v_frank  uuid;
  v_leap   uuid;
  v_grace  uuid;
  v_r      jsonb;
  v_ref    uuid;
  v_n      int;
  v_text   text;
begin
  insert into clients (name, slug, is_active) values ('Loyalty Jobs Test', 'loyalty-jobs-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, live_since, timezone,
                                points_expire_after, demote_after_inactive, demotion_warning_days)
  values (v_client, 'jobs-test.myshopify.com', 'Wave Rewards', 3, '2026-10-01T00:00:00Z', 'America/Los_Angeles',
          '1 year', '6 months', 7)
  returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier) values
    (v_prog, 'bronze', 'Bronze', 0, 0, 1.0),
    (v_prog, 'silver', 'Silver', 1, 50000, 1.1),
    (v_prog, 'gold',   'Gold',   2, 120000, 1.2);
  insert into loyalty_earn_rules (program_id, key, kind, points, order_count) values
    (v_prog, 'signup',      'action',    100, null),
    (v_prog, 'newsletter',  'action',    75,  null),
    (v_prog, 'birthday',    'action',    225, null),
    (v_prog, 'anniversary', 'action',    225, null),
    (v_prog, 'referral',    'referral',  300, null),
    (v_prog, 'order_1',     'milestone', 100, 1),
    (v_prog, 'order_10',    'milestone', 300, 10);

  -- --- signup: live, account created after go-live, once ---
  v_new := loyalty_sync_customer(v_prog, '{"id":1,"email":"new@example.com","state":"enabled","created_at":"2026-10-05T00:00:00Z"}', true);
  assert (select points_balance from loyalty_members where id = v_new) = 100, 'signup: new account after go-live earns 100';
  perform loyalty_sync_customer(v_prog, '{"id":1,"state":"enabled","created_at":"2026-10-05T00:00:00Z"}', true);
  assert (select points_balance from loyalty_members where id = v_new) = 100, 'signup: paid once';
  v_old := loyalty_sync_customer(v_prog, '{"id":2,"email":"old@example.com","state":"enabled","created_at":"2026-01-01T00:00:00Z"}', true);
  assert (select points_balance from loyalty_members where id = v_old) = 0, 'signup: account from before go-live (Joy paid it) earns 0';
  v_n := loyalty_sync_customers(v_prog, '[{"id":3,"state":"enabled","created_at":"2026-10-06T00:00:00Z"}]');
  assert (select points_balance from loyalty_members where program_id = v_prog and shopify_customer_id = 3) = 0,
    'signup: backfill never pays';

  -- --- newsletter: consent after go-live only, once ---
  perform loyalty_sync_customer(v_prog, '{"id":2,"state":"enabled","email_marketing_consent":{"state":"subscribed","consent_updated_at":"2026-09-01T00:00:00Z"}}', true);
  assert (select points_balance from loyalty_members where id = v_old) = 0, 'newsletter: subscribed before go-live earns 0';
  perform loyalty_sync_customer(v_prog, '{"id":2,"state":"enabled","email_marketing_consent":{"state":"subscribed","consent_updated_at":"2026-10-07T00:00:00Z"}}', true);
  perform loyalty_sync_customer(v_prog, '{"id":2,"state":"enabled","email_marketing_consent":{"state":"subscribed","consent_updated_at":"2026-10-08T00:00:00Z"}}', true);
  assert (select points_balance from loyalty_members where id = v_old) = 75, 'newsletter: 75 once';
  perform loyalty_sync_customer(v_prog, '{"id":1,"state":"enabled","email_marketing_consent":{"state":"unsubscribed","consent_updated_at":"2026-10-08T00:00:00Z"}}', true);
  assert (select points_balance from loyalty_members where id = v_new) = 100, 'newsletter: unsubscribed earns nothing';

  -- --- milestones: 9 backfilled orders then a live one crosses the 10th ---
  select loyalty_record_orders(v_prog, jsonb_agg(jsonb_build_object(
           'id', 100 + g, 'processed_at', '2026-07-01T00:00:00Z', 'eligible_cents', 1000,
           'customer', jsonb_build_object('id', 10, 'email', 'alice.smith@gmail.com', 'state', 'enabled'))), 'backfill')
    into v_r from generate_series(1, 9) g;
  select id into v_alice from loyalty_members where program_id = v_prog and shopify_customer_id = 10;
  assert (select points_balance = 0 and paid_order_count = 9 from loyalty_members where id = v_alice),
    'milestone: backfill pays none (orders counted, 1st-order milestone not paid)';
  v_r := loyalty_record_order(v_prog, jsonb_build_object('id', 200, 'eligible_cents', 1000, 'processed_at', '2026-10-10T00:00:00Z',
           'customer', jsonb_build_object('id', 10, 'state', 'enabled')), 'webhook');
  assert v_r->'milestones' = '["order_10"]'::jsonb, 'milestone: 10th order on a live order';
  assert (select points_balance from loyalty_members where id = v_alice) = 30 + 300, 'milestone: 30 order points + 300';
  v_r := loyalty_record_order(v_prog, jsonb_build_object('id', 201, 'eligible_cents', 1000,
           'customer', jsonb_build_object('id', 1, 'state', 'enabled')), 'webhook');
  assert v_r->'milestones' = '["order_1"]'::jsonb, 'milestone: first live order for a new member';

  -- --- referrals ---
  assert loyalty_normalize_email(' A.l.i.c.e.Smith+promo@GoogleMail.com ') = 'alicesmith@gmail.com', 'normalize: gmail dots, +tag, domain';
  assert loyalty_normalize_email('a.b+x@example.com') = 'a.b@example.com', 'normalize: other domains keep dots';
  assert loyalty_create_referral(v_alice, 'alicesmith+2@gmail.com')->>'status' = 'similar_email', 'referral: similar email rejected';
  assert loyalty_create_referral(v_alice, 'not-an-email')->>'status' = 'invalid_email', 'referral: invalid email';
  update loyalty_members set email = 'new@example.com' where id = v_new;
  assert loyalty_create_referral(v_alice, 'NEW@example.com')->>'status' = 'already_customer', 'referral: paying member rejected';
  v_r := loyalty_create_referral(v_alice, 'bob@example.com');
  assert v_r->>'status' = 'created', 'referral: created';
  v_ref := (v_r->>'referral_id')::uuid;
  assert loyalty_create_referral(v_new, 'Bob@Example.com')->>'status' = 'already_referred', 'referral: a friend is referred once';
  update loyalty_referrals set discount_code = 'WAVE-REF-1' where id = v_ref;

  v_r := loyalty_record_order(v_prog, jsonb_build_object('id', 300, 'eligible_cents', 5000, 'email', 'bob@example.com',
           'discount_codes', jsonb_build_array('wave-ref-1'), 'customer', null), 'webhook');
  assert v_r->>'status' = 'not_member' and v_r->>'referral' = 'completed', 'referral: guest friend order completes it';
  assert (select points_balance from loyalty_members where id = v_alice) = 330 + 300, 'referral: referrer earns 300';
  v_r := loyalty_record_order(v_prog, jsonb_build_object('id', 301, 'eligible_cents', 5000,
           'discount_codes', jsonb_build_array('WAVE-REF-1'), 'customer', null), 'webhook');
  assert v_r->>'referral' is null, 'referral: a completed referral pays once';

  v_r := loyalty_create_referral(v_alice, 'carl@example.com');
  update loyalty_referrals set discount_code = 'WAVE-REF-2' where id = (v_r->>'referral_id')::uuid;
  v_r := loyalty_record_order(v_prog, jsonb_build_object('id', 302, 'eligible_cents', 5000,
           'discount_codes', jsonb_build_array('WAVE-REF-2'), 'customer', jsonb_build_object('id', 10, 'state', 'enabled')), 'webhook');
  assert v_r->>'referral' = 'rejected', 'referral: referrer using their own friend code is rejected';
  assert (select reject_reason from loyalty_referrals where discount_code = 'WAVE-REF-2') = 'self', 'referral: reason self';
  assert (select points_balance from loyalty_members where id = v_alice) = 630 + 150, 'referral: a rejected referral still earns the order''s own points';

  -- --- expiry ---
  v_dave := loyalty_enroll_member(v_prog, 40, 'dave@example.com', null, null, '2025-06-01T00:00:00Z');
  perform loyalty_post_entry(v_dave, 500, 'adjust', 'test:dave', 0, null, 'staff', null, null, 'test', '2025-06-01T00:00:00Z');
  v_r := run_loyalty_jobs('2026-10-13T20:00:00Z');
  assert (select points_balance from loyalty_members where id = v_dave) = 0, 'expiry: a year with no activity expires the balance';
  assert (select points_balance from loyalty_members where id = v_alice) = 780, 'expiry: an active member keeps theirs';
  perform loyalty_post_entry(v_dave, 50, 'adjust', 'test:dave2', 0, null, 'staff', null, null, 'test');
  perform run_loyalty_jobs('2026-10-13T21:00:00Z');
  assert (select points_balance from loyalty_members where id = v_dave) = 50,
    'expiry: points added after a lapse wait for the next lapse (expire key is per lapse)';
  select count(*) into v_n from loyalty_ledger where member_id = v_dave and reason = 'expire';
  assert v_n = 1, 'expiry: one expire entry per lapse';

  -- --- demotion ---
  v_erin := loyalty_enroll_member(v_prog, 50, 'erin@example.com', null, null, '2026-01-01T00:00:00Z');
  perform loyalty_set_tier(v_erin, 'gold', 'staff', 'test');
  perform loyalty_post_entry(v_erin, 0, 'order', 'test:erin-order', 0, null, null, null, null, 'test', '2026-03-01T00:00:00Z');
  perform run_loyalty_jobs('2026-08-20T00:00:00Z');
  select count(*) into v_n from loyalty_events where member_id = v_erin;
  assert v_n = 0, 'demotion: no warning before the window';
  perform run_loyalty_jobs('2026-08-26T00:00:00Z');
  perform run_loyalty_jobs('2026-08-27T00:00:00Z');
  select count(*) into v_n from loyalty_events where member_id = v_erin and kind = 'demotion_warning';
  assert v_n = 1, 'demotion: one warning 7 days before';
  perform run_loyalty_jobs('2026-09-02T00:00:00Z');
  assert (select tier_key from loyalty_members where id = v_erin) = 'silver', 'demotion: gold -> silver after 6 months';
  perform run_loyalty_jobs('2026-09-03T00:00:00Z');
  assert (select tier_key from loyalty_members where id = v_erin) = 'silver', 'demotion: one tier per lapse';
  select count(*) into v_n from loyalty_tier_changes where member_id = v_erin and reason = 'inactivity' and direction = 'down';
  assert v_n = 1, 'demotion: logged as inactivity';
  perform run_loyalty_jobs('2027-03-03T00:00:00Z');
  assert (select tier_key from loyalty_members where id = v_erin) = 'bronze', 'demotion: silver -> bronze after another lapse';

  -- --- birthdays (America/Los_Angeles) ---
  v_frank := loyalty_enroll_member(v_prog, 60, 'frank@example.com');
  update loyalty_members set birthday = '1990-10-20' where id = v_frank;
  perform run_loyalty_jobs('2026-10-13T19:00:00Z');
  select count(*) into v_n from loyalty_events where member_id = v_frank and kind = 'pre_birthday';
  assert v_n = 1, 'birthday: pre-birthday event 7 days before';
  perform run_loyalty_jobs('2026-10-20T05:00:00Z');   -- Oct 19, 22:00 in LA
  assert (select points_balance from loyalty_members where id = v_frank) = 0, 'birthday: not yet in the program''s timezone';
  perform run_loyalty_jobs('2026-10-20T19:00:00Z');
  perform run_loyalty_jobs('2026-10-21T19:00:00Z');
  assert (select points_balance from loyalty_members where id = v_frank) = 225, 'birthday: 225 once on the day';
  select count(*) into v_n from loyalty_events where member_id = v_frank and kind = 'birthday';
  assert v_n = 1, 'birthday: one birthday event';

  v_leap := loyalty_enroll_member(v_prog, 61, 'leap@example.com');
  update loyalty_members set birthday = '2000-02-29' where id = v_leap;
  perform run_loyalty_jobs('2027-02-28T20:00:00Z');
  assert (select count(*) from loyalty_ledger where member_id = v_leap and rule_key = 'birthday') = 1, 'birthday: Feb 29 paid on Feb 28';
  assert loyalty_occurrence('2000-02-29', 2028) = '2028-02-29', 'occurrence: leap year keeps Feb 29';

  update loyalty_members set birthday = '1990-12-31' where id = v_leap;
  perform run_loyalty_jobs('2027-01-01T20:00:00Z');   -- missed Dec 31; caught up Jan 1
  assert (select count(*) from loyalty_ledger where member_id = v_leap and rule_key = 'birthday'
           and idempotency_key like '%:2026') = 1, 'birthday: Dec 31 caught up on Jan 1 counts for last year';
  update loyalty_members set birthday = '1990-01-04' where id = v_leap;
  perform run_loyalty_jobs('2027-12-28T20:00:00Z');
  assert (select count(*) from loyalty_events where member_id = v_leap and kind = 'pre_birthday'
           and dedupe_key like '%:2028') = 1, 'birthday: pre-birthday across new year';

  -- --- anniversaries ---
  v_grace := loyalty_enroll_member(v_prog, 70, 'grace@example.com', null, null, '2025-10-13T18:00:00Z');
  perform run_loyalty_jobs('2026-10-13T20:00:00Z');
  perform run_loyalty_jobs('2026-10-14T20:00:00Z');
  assert (select points_balance from loyalty_members where id = v_grace) = 225, 'anniversary: 225 once after a year';
  assert (select count(*) from loyalty_ledger where member_id = v_frank and rule_key = 'anniversary') = 0,
    'anniversary: none in the first year';

  -- --- outbox and caches ---
  assert loyalty_emit_event(v_frank, 'birthday', 'birthday:' || v_frank || ':2026') = false, 'events: dedupe';
  select count(*) into v_n from loyalty_verify_balances(v_prog);
  assert v_n = 0, 'verify: caches match the ledger';
end $$;

do $$
declare
  v_denied boolean;
begin
  set local role authenticated;
  begin
    perform 1 from loyalty_referrals limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rls: authenticated cannot read loyalty_referrals';
  begin
    perform run_loyalty_jobs();
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rls: authenticated cannot run the jobs';
  reset role;
end $$;

rollback;

\echo 'test_loyalty_earning_jobs: all assertions passed'
