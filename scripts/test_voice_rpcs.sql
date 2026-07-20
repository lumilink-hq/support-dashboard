-- =============================================================================
-- test_voice_rpcs.sql — non-destructive test of the 0006 voice RPCs + the shared
-- evaluate_flag rule. Wraps everything in a transaction and ROLLS BACK, so it's
-- safe to run against any environment that has migrations 0001/0002/0005/0006
-- applied.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_voice_rpcs.sql
--   or: supabase db execute --file scripts/test_voice_rpcs.sql   (against a shadow db)
--
-- Any failed assertion aborts with a clear message; "ALL VOICE RPC TESTS PASSED"
-- prints only if every check held.
-- =============================================================================

begin;

do $$
declare
  v_client   uuid;
  v_resolved uuid;
  v_conv     uuid;
  v_conv2    uuid;
  v_turn     uuid;
  v_dup      uuid;
  v_flag     jsonb;
  v_msg_cnt  int;
begin
  -- Fixture: an active client with an E.164 phone number + abnormal-status rules.
  insert into clients (name, slug, is_active, phone_number, abnormal_status_rules)
  values ('Voice Test Co', 'voice-test-co', true, '+14155550123',
          jsonb_build_object('abnormal_statuses', jsonb_build_array('on-hold','failed'),
                             'stale_after_hours', 24))
  returning id into v_client;

  -- 1) resolve_client_by_number: exact, and digits-only tolerant.
  select resolve_client_by_number('+14155550123') into v_resolved;
  assert v_resolved = v_client, 'resolve: exact E.164 should match';

  -- Twilio delivers E.164 (with country code); digits-only tolerates punctuation/spaces.
  select resolve_client_by_number('+1 (415) 555-0123') into v_resolved;
  assert v_resolved = v_client, 'resolve: E.164 with punctuation should match digits-only';

  select resolve_client_by_number('+19998887777') into v_resolved;
  assert v_resolved is null, 'resolve: unknown number should be null';

  -- 2) ingest_call: creates a voice conversation keyed by call SID; idempotent.
  select ingest_call(v_client, 'CA_test_001', '+16505551212', 'Jane Caller', null)
    into v_conv;
  assert v_conv is not null, 'ingest_call: should return a conversation id';

  assert (select channel::text from conversations where id = v_conv) = 'voice',
    'ingest_call: channel must be voice';

  -- Re-fire the same call SID -> same conversation (no duplicate).
  select ingest_call(v_client, 'CA_test_001', '+16505551212', 'Jane Caller', '12345')
    into v_conv2;
  assert v_conv2 = v_conv, 'ingest_call: same call SID must be idempotent';
  assert (select order_number from conversations where id = v_conv) = '12345',
    'ingest_call: order_number should be filled in on re-ingest';

  -- 3) log_call_turn: appends turns; idempotent on turn_ref.
  select log_call_turn(v_conv, 'customer', 'Where is my order?', null, null,
                       'CA_test_001:0', null) into v_turn;
  assert v_turn is not null, 'log_call_turn: first turn should insert';

  select log_call_turn(v_conv, 'agent', 'It shipped yesterday.', null,
                       'claude-haiku-4-5', 'CA_test_001:1', 'resolved') into v_turn;
  assert v_turn is not null, 'log_call_turn: agent turn should insert';

  -- Replay a turn with the same ref -> no duplicate.
  select log_call_turn(v_conv, 'customer', 'Where is my order?', null, null,
                       'CA_test_001:0', null) into v_dup;
  assert v_dup is null, 'log_call_turn: duplicate turn_ref must be a no-op';

  select count(*) into v_msg_cnt from messages where conversation_id = v_conv;
  assert v_msg_cnt = 2, format('log_call_turn: expected 2 messages, got %s', v_msg_cnt);

  assert (select status from conversations where id = v_conv) = 'resolved',
    'log_call_turn: status should advance to resolved';

  -- 4) evaluate_flag (shared rule) drives voice escalation the same as email.
  select evaluate_flag(v_client, 'on-hold', now()) into v_flag;
  assert (v_flag->>'flagged')::boolean is true, 'flag: on-hold is abnormal';
  assert v_flag->>'reason' = 'abnormal_status', 'flag: reason abnormal_status';

  select evaluate_flag(v_client, 'processing', now() - interval '30 hours') into v_flag;
  assert (v_flag->>'flagged')::boolean is true, 'flag: >24h stale should flag';
  assert v_flag->>'reason' = 'order_over_24h', 'flag: reason order_over_24h';

  select evaluate_flag(v_client, 'processing', now() - interval '2 hours') into v_flag;
  assert (v_flag->>'flagged')::boolean is false, 'flag: fresh normal order not flagged';

  raise notice 'ALL VOICE RPC TESTS PASSED';
end;
$$;

rollback;
