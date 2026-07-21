-- =============================================================================
-- test_scheduling.sql — non-destructive test of 0007 (services, appointments,
-- book_appointment, the no-overlap guard, capture_lead). Transaction + ROLLBACK.
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_scheduling.sql
-- Prints "ALL SCHEDULING TESTS PASSED" only if every assertion holds.
-- =============================================================================

begin;

do $$
declare
  v_client   uuid;
  v_conv     uuid;
  v_conv2    uuid;
  v_fixed    uuid;
  v_quote    uuid;
  v_res      jsonb;
  v_cnt      int;
  v_committed numeric;
  v_rev_status text;
  v_outcome  text;
begin
  insert into clients (name, slug, is_active) values ('Sched Test', 'sched-test', true)
    returning id into v_client;

  insert into services (client_id, name, price_type, price, callout_fee, default_duration_min)
    values (v_client, 'AC Tune-Up', 'fixed', 99, null, 60) returning id into v_fixed;
  insert into services (client_id, name, price_type, price, callout_fee, default_duration_min)
    values (v_client, 'AC Repair', 'quote', null, 89, 90) returning id into v_quote;

  insert into conversations (client_id, channel, status) values (v_client, 'voice', 'open')
    returning id into v_conv;
  insert into conversations (client_id, channel, status) values (v_client, 'voice', 'open')
    returning id into v_conv2;

  -- 1) Fixed-price booking: committed_amount = price, revenue committed.
  v_res := book_appointment(v_client, v_fixed, 'AC Tune-Up', v_conv,
    'Jane Doe', 'jane@example.com', '+16505551212', '1 Main St', false,
    '2026-08-03 10:00:00-07:00'::timestamptz, '2026-08-03 11:00:00-07:00'::timestamptz,
    'America/Los_Angeles', null, 'voice');
  assert (v_res->>'ok')::boolean, 'fixed booking should succeed';
  select committed_amount, revenue_status into v_committed, v_rev_status
    from appointments where id = (v_res->>'appointment_id')::uuid;
  assert v_committed = 99, format('fixed committed_amount should be 99, got %s', v_committed);
  assert v_rev_status = 'committed', 'fixed revenue_status should be committed';

  -- conversation marked booked
  select booking_outcome into v_outcome from conversations where id = v_conv;
  assert v_outcome = 'booked', 'conversation should be booked';

  -- 2) Quote booking: committed_amount = callout fee.
  v_res := book_appointment(v_client, v_quote, 'AC Repair', null,
    'Bob Roe', null, '+16505553434', '2 Oak Ave', true,
    '2026-08-03 13:00:00-07:00'::timestamptz, '2026-08-03 14:30:00-07:00'::timestamptz,
    'America/Los_Angeles', 'no cooling', 'voice');
  assert (v_res->>'ok')::boolean, 'quote booking should succeed';
  select committed_amount, price_type into v_committed, v_rev_status
    from appointments where id = (v_res->>'appointment_id')::uuid;
  assert v_committed = 89, format('quote committed_amount should be callout 89, got %s', v_committed);

  -- 3) Overlap is rejected (10:00-11:00 already booked; try 10:30-11:30).
  v_res := book_appointment(v_client, v_fixed, 'AC Tune-Up', null,
    'Overlap', null, null, '3 Pine', false,
    '2026-08-03 10:30:00-07:00'::timestamptz, '2026-08-03 11:30:00-07:00'::timestamptz,
    'America/Los_Angeles', null, 'voice');
  assert (v_res->>'ok')::boolean is false, 'overlapping booking must be rejected';
  assert v_res->>'reason' = 'slot_unavailable', 'overlap reason should be slot_unavailable';

  -- 4) Adjacent (touching) booking IS allowed: 11:00-12:00 after 10:00-11:00.
  v_res := book_appointment(v_client, v_fixed, 'AC Tune-Up', null,
    'Adjacent', null, null, '4 Elm', false,
    '2026-08-03 11:00:00-07:00'::timestamptz, '2026-08-03 12:00:00-07:00'::timestamptz,
    'America/Los_Angeles', null, 'voice');
  assert (v_res->>'ok')::boolean, 'adjacent (non-overlapping) booking should succeed';

  -- 5) A cancelled slot frees up for rebooking.
  update appointments set status = 'cancelled'
    where client_id = v_client and starts_at = '2026-08-03 10:00:00-07:00'::timestamptz;
  v_res := book_appointment(v_client, v_fixed, 'AC Tune-Up', null,
    'Rebook', null, null, '5 Ash', false,
    '2026-08-03 10:00:00-07:00'::timestamptz, '2026-08-03 11:00:00-07:00'::timestamptz,
    'America/Los_Angeles', null, 'voice');
  assert (v_res->>'ok')::boolean, 'rebooking a cancelled slot should succeed';

  -- 6) capture_lead marks the second conversation.
  perform capture_lead(v_conv2, 'Lead Person', '+16505559999', 'lead_only');
  select booking_outcome into v_outcome from conversations where id = v_conv2;
  assert v_outcome = 'lead_only', 'capture_lead should set lead_only';

  select count(*) into v_cnt from appointments where client_id = v_client
    and status not in ('cancelled');
  assert v_cnt = 3, format('expected 3 live appointments, got %s', v_cnt);

  raise notice 'ALL SCHEDULING TESTS PASSED';
end;
$$;

rollback;
