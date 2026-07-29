-- =============================================================================
-- test_voice_usage_caps.sql — non-destructive test of the 0012 voice usage
-- metering + cap RPCs. Wraps everything in a transaction and ROLLS BACK, so it's
-- safe to run against any environment with migrations 0001/0002/0005/0006/0012
-- applied.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_voice_usage_caps.sql
--   or: supabase db execute --file scripts/test_voice_usage_caps.sql
--
-- Any failed assertion aborts with a clear message; "ALL VOICE CAP TESTS PASSED"
-- prints only if every check held.
-- =============================================================================

begin;

do $$
declare
  v_client   uuid;
  v_other    uuid;
  v_caps     jsonb;
  v_res      jsonb;
  v_rec      jsonb;
  v_cnt      int;
  v_alloc    record;
begin
  -- Ensure the singleton exists with known values (rolled back with everything).
  update platform_settings
     set voice_enabled = true, plan_minutes = 1238, default_monthly_minutes = 200,
         default_cost_per_min_usd = 0.10, reserve_pct = 20, default_max_call_secs = 300
   where id = 1;

  insert into clients (name, slug, is_active, phone_number)
  values ('Cap Test Co', 'cap-test-co', true, '+14155559001')
  returning id into v_client;

  -- ---------------------------------------------------------------------------
  -- 1) Effective caps: a client with no voice_caps must inherit the platform
  --    default, NOT become unlimited.
  -- ---------------------------------------------------------------------------
  v_caps := client_voice_caps(v_client);
  assert (v_caps ->> 'monthly_minutes')::numeric = 200,
    'caps: unset monthly_minutes must inherit the platform default';
  assert (v_caps ->> 'enabled')::boolean is true, 'caps: enabled defaults true';
  assert (v_caps ->> 'daily_minutes') is null, 'caps: daily cap absent by default';
  assert (v_caps ->> 'max_call_secs')::int = 300, 'caps: max_call_secs default';
  assert (v_caps ->> 'cost_per_min_usd')::numeric = 0.10, 'caps: rate default';
  assert client_voice_caps(gen_random_uuid()) is null,
    'caps: unknown client returns null';

  -- Per-client overrides win over the platform default.
  update clients
     set settings = jsonb_build_object('voice_caps',
           jsonb_build_object('monthly_minutes', 50, 'daily_minutes', 10,
                              'max_call_secs', 240))
   where id = v_client;
  v_caps := client_voice_caps(v_client);
  assert (v_caps ->> 'monthly_minutes')::numeric = 50, 'caps: client override wins';
  assert (v_caps ->> 'daily_minutes')::numeric = 10, 'caps: daily override';
  assert (v_caps ->> 'max_call_secs')::int = 240, 'caps: max_call_secs override';

  -- ---------------------------------------------------------------------------
  -- 2) Fresh client is allowed.
  -- ---------------------------------------------------------------------------
  v_res := check_voice_allowance(v_client);
  assert (v_res ->> 'allowed')::boolean is true, 'allow: fresh client allowed';
  assert v_res ->> 'reason' = 'ok', 'allow: reason ok';
  assert (v_res ->> 'minutes_used')::numeric = 0, 'allow: no usage yet';
  assert (v_res ->> 'minutes_cap')::numeric = 50, 'allow: cap reported';
  assert (v_res ->> 'minutes_remaining')::numeric = 50, 'allow: remaining reported';
  assert (v_res ->> 'warn')::boolean is false, 'allow: no warning at 0%';
  assert check_voice_allowance(gen_random_uuid()) ->> 'reason' = 'unknown_client',
    'allow: unknown client';

  -- ---------------------------------------------------------------------------
  -- 3) record_call_usage: first write.
  -- ---------------------------------------------------------------------------
  v_rec := record_call_usage(v_client, 'CA_cap_001', 180);
  assert (v_rec ->> 'recorded')::boolean is true, 'record: first write recorded';
  assert (v_rec ->> 'duplicate')::boolean is false, 'record: not a duplicate';
  assert (v_rec ->> 'duration_secs')::int = 180, 'record: duration echoed';
  assert (v_rec ->> 'minutes_used')::numeric = 3, 'record: 180s = 3 minutes';
  -- Cost derived from duration x rate when the caller doesn't supply one.
  assert (v_rec ->> 'est_cost_usd')::numeric = 0.30,
    format('record: 3 min at $0.10 should be $0.30, got %s', v_rec ->> 'est_cost_usd');
  assert (v_rec ->> 'pct_used')::numeric = 6.0, 'record: 3/50 = 6%';
  assert (v_rec ->> 'over_cap')::boolean is false, 'record: not over cap';

  -- ---------------------------------------------------------------------------
  -- 4) THE IMPORTANT ONE — a re-fired post-call webhook must not double-count,
  --    and the duplicate must be VISIBLE rather than silently swallowed.
  -- ---------------------------------------------------------------------------
  v_rec := record_call_usage(v_client, 'CA_cap_001', 180);
  assert (v_rec ->> 'recorded')::boolean is false, 'dedupe: replay must not record';
  assert (v_rec ->> 'duplicate')::boolean is true, 'dedupe: replay must REPORT duplicate';
  assert (v_rec ->> 'minutes_used')::numeric = 3, 'dedupe: minutes must not double';

  select count(*) into v_cnt from voice_usage_events
   where client_id = v_client and call_sid = 'CA_cap_001';
  assert v_cnt = 1, format('dedupe: expected 1 row, got %s', v_cnt);

  -- A different call SID does record.
  v_rec := record_call_usage(v_client, 'CA_cap_002', 60);
  assert (v_rec ->> 'recorded')::boolean is true, 'record: distinct sid records';
  assert (v_rec ->> 'minutes_used')::numeric = 4, 'record: totals accumulate';

  -- Same SID for a DIFFERENT client is not a duplicate (dedupe is per tenant).
  insert into clients (name, slug, is_active) values ('Other Co', 'other-co', true)
  returning id into v_other;
  v_rec := record_call_usage(v_other, 'CA_cap_001', 60);
  assert (v_rec ->> 'recorded')::boolean is true,
    'dedupe: same sid under a different client is not a duplicate';

  -- ---------------------------------------------------------------------------
  -- 5) Explicit cost overrides the derived one; bad input is handled.
  -- ---------------------------------------------------------------------------
  v_rec := record_call_usage(v_client, 'CA_cap_003', 60, 0.99);
  assert (v_rec ->> 'est_cost_usd')::numeric = 0.99, 'record: explicit cost wins';

  -- A negative duration is a bad payload, not negative usage.
  v_rec := record_call_usage(v_client, 'CA_cap_neg', -500);
  assert (v_rec ->> 'duration_secs')::int = 0, 'record: negative duration clamps to 0';
  assert (v_rec ->> 'minutes_used')::numeric = 5, 'record: clamped call adds nothing';

  assert (record_call_usage(v_client, '   ', 60) ->> 'recorded')::boolean is false,
    'record: blank call_sid rejected';
  assert record_call_usage(v_client, '   ', 60) ->> 'error' is not null,
    'record: blank call_sid explains itself';
  assert record_call_usage(gen_random_uuid(), 'CA_x', 60) ->> 'error' = 'unknown_client',
    'record: unknown client rejected';

  -- ---------------------------------------------------------------------------
  -- 6) Usage from a previous period must not count against this month.
  -- ---------------------------------------------------------------------------
  v_rec := record_call_usage(v_client, 'CA_cap_lastmonth', 3600, null,
                             now() - interval '45 days');
  assert (v_rec ->> 'recorded')::boolean is true, 'period: old call still recorded';
  assert (v_rec ->> 'minutes_used')::numeric = 5,
    'period: a call from last month must not count toward this month';

  -- ---------------------------------------------------------------------------
  -- 7) Monthly minute cap trips.
  -- ---------------------------------------------------------------------------
  v_rec := record_call_usage(v_client, 'CA_cap_big', 2760);  -- +46 min -> 51 total
  assert (v_rec ->> 'over_cap')::boolean is true, 'cap: over_cap reported on the meter';

  v_res := check_voice_allowance(v_client);
  assert (v_res ->> 'allowed')::boolean is false, 'cap: over cap must block';
  assert v_res ->> 'reason' = 'over_monthly_minutes', 'cap: reason over_monthly_minutes';
  assert (v_res ->> 'minutes_remaining')::numeric = 0,
    'cap: remaining floors at 0, never negative';
  assert (v_res ->> 'warn')::boolean is true, 'cap: warn true past 80%';

  -- ---------------------------------------------------------------------------
  -- 8) Reason precedence: a deliberate switch outranks a cap.
  -- ---------------------------------------------------------------------------
  update clients set settings = jsonb_set(settings, '{voice_caps,enabled}', 'false')
   where id = v_client;
  assert check_voice_allowance(v_client) ->> 'reason' = 'client_disabled',
    'precedence: client_disabled outranks the cap';

  update clients set is_active = false where id = v_client;
  assert check_voice_allowance(v_client) ->> 'reason' = 'client_inactive',
    'precedence: client_inactive outranks client_disabled';

  update platform_settings set voice_enabled = false where id = 1;
  assert check_voice_allowance(v_client) ->> 'reason' = 'global_pause',
    'precedence: the global kill switch outranks everything';
  -- ...and it stops a perfectly healthy client too.
  assert (check_voice_allowance(v_other) ->> 'allowed')::boolean is false,
    'kill switch: stops every client, not just the capped one';

  update platform_settings set voice_enabled = true where id = 1;
  update clients set is_active = true,
         settings = jsonb_set(settings, '{voice_caps,enabled}', 'true')
   where id = v_client;
  assert check_voice_allowance(v_client) ->> 'reason' = 'over_monthly_minutes',
    'precedence: cap reason returns once the switches are back on';

  -- ---------------------------------------------------------------------------
  -- 9) Unlimited (-1) is an explicit opt-out.
  -- ---------------------------------------------------------------------------
  -- Replace the whole voice_caps object: the earlier daily_minutes=10 would
  -- otherwise still trip, which is correct behavior but not what we're testing.
  update clients set settings = jsonb_build_object('voice_caps',
         jsonb_build_object('monthly_minutes', -1))
   where id = v_client;
  v_res := check_voice_allowance(v_client);
  assert (v_res ->> 'allowed')::boolean is true,
    format('unlimited: -1 should allow past any usage, got reason %s', v_res ->> 'reason');
  assert v_res ->> 'minutes_remaining' is null, 'unlimited: remaining is null';

  -- Caps are independent: an unlimited minute cap does NOT disable a daily cap.
  update clients set settings = jsonb_build_object('voice_caps',
         jsonb_build_object('monthly_minutes', -1, 'daily_minutes', 2))
   where id = v_client;
  assert check_voice_allowance(v_client) ->> 'reason' = 'over_daily_minutes',
    'unlimited: an unlimited month still respects a daily cap';

  -- ---------------------------------------------------------------------------
  -- 10) Cost cap and daily cap trip independently of the minute cap.
  -- ---------------------------------------------------------------------------
  update clients set settings = jsonb_build_object('voice_caps',
         jsonb_build_object('monthly_minutes', 10000, 'monthly_cost_usd', 0.50))
   where id = v_client;
  assert check_voice_allowance(v_client) ->> 'reason' = 'over_monthly_cost',
    'cost cap: trips even when minutes are fine';

  update clients set settings = jsonb_build_object('voice_caps',
         jsonb_build_object('monthly_minutes', 10000, 'daily_minutes', 2))
   where id = v_client;
  assert check_voice_allowance(v_client) ->> 'reason' = 'over_daily_minutes',
    'daily cap: trips even when the month is fine';

  -- ---------------------------------------------------------------------------
  -- 11) crossed_warning fires exactly once, on the call that crosses 80%.
  -- ---------------------------------------------------------------------------
  delete from voice_usage_events where client_id = v_client;
  update clients set settings = jsonb_build_object('voice_caps',
         jsonb_build_object('monthly_minutes', 10))
   where id = v_client;

  v_rec := record_call_usage(v_client, 'CA_warn_1', 420);   -- 7 min -> 70%
  assert (v_rec ->> 'crossed_warning')::boolean is false, 'warn: 70% does not warn';
  v_rec := record_call_usage(v_client, 'CA_warn_2', 120);   -- +2 min -> 90%
  assert (v_rec ->> 'crossed_warning')::boolean is true, 'warn: crossing 80% warns';
  v_rec := record_call_usage(v_client, 'CA_warn_3', 60);    -- +1 min -> 100%
  assert (v_rec ->> 'crossed_warning')::boolean is false,
    'warn: must fire once, not on every subsequent call';

  -- ---------------------------------------------------------------------------
  -- 12) Timezone handling: a bad tz string must not throw inside the gate.
  -- ---------------------------------------------------------------------------
  update clients set business_hours = jsonb_build_object('tz', 'America/Los_Angeles')
   where id = v_client;
  assert client_timezone(v_client) = 'America/Los_Angeles', 'tz: reads business_hours.tz';

  update clients set business_hours = jsonb_build_object('tz', 'Not/AZone')
   where id = v_client;
  assert client_timezone(v_client) = 'UTC', 'tz: invalid tz falls back to UTC';
  assert (check_voice_allowance(v_client) ->> 'reason') is not null,
    'tz: an invalid tz must not raise inside the gate';

  update clients set business_hours = '{}'::jsonb,
         settings = settings || jsonb_build_object('scheduling',
                      jsonb_build_object('timezone', 'America/New_York'))
   where id = v_client;
  assert client_timezone(v_client) = 'America/New_York',
    'tz: falls back to settings.scheduling.timezone';

  -- ---------------------------------------------------------------------------
  -- 13) Dashboard views.
  -- ---------------------------------------------------------------------------
  select * into v_alloc from voice_usage_current where client_id = v_client;
  assert v_alloc.calls = 3, format('view: expected 3 calls, got %s', v_alloc.calls);
  assert v_alloc.minutes_used = 10, 'view: minutes rolled up';
  assert v_alloc.avg_call_minutes is not null, 'view: average call length present';

  -- A client with no calls still appears (left join), with zeroes not nulls.
  select * into v_alloc from voice_usage_current
   where client_id = (select id from clients where slug = 'cap-test-co' limit 1);
  assert v_alloc.calls is not null, 'view: zero-call clients still listed';

  -- Over-allocation guard: caps summing past the allocatable pool is visible.
  update clients set settings = jsonb_build_object('voice_caps',
         jsonb_build_object('monthly_minutes', 5000))
   where id = v_client;
  select * into v_alloc from voice_cap_allocation;
  assert v_alloc.allocatable_minutes = 990,
    format('alloc: 1238 minus 20%% reserve should be 990, got %s', v_alloc.allocatable_minutes);
  assert v_alloc.over_allocated is true, 'alloc: 5000 allocated must flag over_allocated';

  raise notice 'ALL VOICE CAP TESTS PASSED';
end;
$$;

-- =============================================================================
-- Tenant isolation, exercised as an actual signed-in user.
--
-- This is the part that can't be eyeballed: 0001 grants `authenticated` rights
-- on every future table AND view via default privileges, and a plain view runs
-- with its owner's rights — which would quietly bypass RLS. These checks fail
-- loudly if that protection ever regresses.
-- =============================================================================
do $$
declare
  v_a      uuid;
  v_b      uuid;
  v_user_a uuid := gen_random_uuid();
  v_seen   int;
  v_denied boolean := false;
begin
  insert into clients (name, slug, is_active) values ('Tenant A', 'tenant-a', true)
  returning id into v_a;
  insert into clients (name, slug, is_active) values ('Tenant B', 'tenant-b', true)
  returning id into v_b;

  perform record_call_usage(v_a, 'CA_a_1', 120);
  perform record_call_usage(v_b, 'CA_b_1', 600);

  -- A signed-in user belonging to Tenant A.
  insert into auth.users (id) values (v_user_a);
  insert into users (id, client_id, email, role)
  values (v_user_a, v_a, 'a@example.com', 'admin');

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  -- 1) The raw meter is filtered to their own tenant.
  select count(*) into v_seen from voice_usage_events;
  assert v_seen = 1, format('rls: tenant should see only its own 1 event, saw %s', v_seen);

  select count(*) into v_seen from voice_usage_events where client_id = v_b;
  assert v_seen = 0, 'rls: tenant must not see another tenant''s events';

  -- 2) The dashboard VIEW must not leak past RLS (security_invoker).
  select count(*) into v_seen from voice_usage_current where minutes_used > 0;
  assert v_seen = 1,
    format('rls: view leaked other tenants — expected 1 row with usage, saw %s', v_seen);

  select count(*) into v_seen from voice_usage_current where client_id = v_b and minutes_used > 0;
  assert v_seen = 0, 'rls: view must not expose another tenant''s minutes';

  -- 3) The tenant can read its own caps through the helper.
  assert (client_voice_caps(v_a) ->> 'monthly_minutes')::numeric = 200,
    'rls: tenant can resolve its own caps';

  -- 4) The meter is read-only for tenants — no forging or erasing usage.
  begin
    insert into voice_usage_events (client_id, call_sid, duration_secs)
    values (v_a, 'CA_forged', 1);
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: tenant must NOT be able to insert usage';

  begin
    delete from voice_usage_events where client_id = v_a;
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: tenant must NOT be able to delete usage';

  -- 5) The cross-tenant allocation view is operators-only.
  begin
    perform 1 from voice_cap_allocation;
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  assert v_denied, 'rls: voice_cap_allocation must not be readable by tenants';

  -- 6) The kill switch cannot be flipped by a tenant.
  begin
    update platform_settings set voice_enabled = false where id = 1;
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'rls: tenant must NOT be able to flip the global kill switch';

  reset role;
  raise notice 'ALL TENANT ISOLATION TESTS PASSED';
end;
$$;

rollback;
