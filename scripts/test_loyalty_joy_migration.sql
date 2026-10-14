-- =============================================================================
-- test_loyalty_joy_migration.sql — non-destructive test of 0207 (LL Loyalty
-- module 8): the Joy import SETS balances (no double count of orders both
-- systems saw), matches by customer id then email, enrolls Joy-only members,
-- carries dates and birthdays, runs quiet; with no activity date (Klaviyo
-- export) the expiry/demotion clocks start at the export (0208); a later
-- import trues up and an older one is refused; the compare reports differences without changing
-- anything; purge drops PII.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_joy_migration.sql
--
-- To see it FAIL:
--   * in loyalty_joy_apply_import post v_row.points instead of v_row.points - v_balance
--     -> "import: sets Joy's balance, no double count" fails.
--   * in loyalty_joy_compare add "update loyalty_members set points_balance = r.points …"
--     -> "compare: changes nothing" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_prog   uuid;
  v_alice  uuid;
  v_bob    uuid;
  v_new    uuid;
  v_snap   uuid;
  v_cmp    uuid;
  v_r      jsonb;
  v_n      int;
begin
  insert into clients (name, slug, is_active) values ('Loyalty Joy Test', 'loyalty-joy-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, live_since, timezone)
  values (v_client, 'joy-test.myshopify.com', 'Wave Rewards', 3, '2026-10-20T00:00:00Z', 'America/Los_Angeles')
  returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier) values
    (v_prog, 'bronze', 'Bronze', 0, 0, 1.0), (v_prog, 'silver', 'Silver', 1, 50000, 1.1), (v_prog, 'gold', 'Gold', 2, 120000, 1.2);
  insert into loyalty_rewards (program_id, key, name, kind, points_cost, value_cents) values (v_prog, 'five_off', '$5 off', 'amount_off_order', 750, 500);

  -- Alice: backfilled, then a live order after install that Joy ALSO counted (300 pts).
  v_alice := loyalty_sync_customer(v_prog, '{"id":10,"email":"alice@example.com","state":"enabled","created_at":"2025-03-01T00:00:00Z"}');
  perform loyalty_post_entry(v_alice, 300, 'order', 'order:1:earn', 10000, null, 'shopify_order', '1', null, 'system', '2026-10-21T00:00:00Z');
  -- Bob: no customer id in Joy's file, matched by email.
  v_bob := loyalty_sync_customer(v_prog, '{"id":11,"email":"Bob@Example.com","state":"enabled","created_at":"2024-01-01T00:00:00Z"}');

  v_snap := loyalty_joy_create_snapshot(v_prog, 'import', '2026-10-22T09:00:00Z', 'joy-export-2026-10-22.csv');
  assert loyalty_joy_add_rows(v_snap, jsonb_build_array(
    jsonb_build_object('row_no', 1, 'shopify_customer_id', 10, 'email', 'alice@example.com', 'points', 2150, 'tier_name', 'gold',
                       'birthday', '1990-04-18', 'joined_at', '2024-06-01T00:00:00Z', 'last_activity_at', '2026-10-21T00:00:00Z'),
    jsonb_build_object('row_no', 2, 'email', 'BOB@example.com', 'points', 80, 'tier_name', 'Bronze'),
    jsonb_build_object('row_no', 3, 'shopify_customer_id', 12, 'email', 'carol@example.com', 'first_name', 'Carol', 'points', 900,
                       'tier_name', 'Silver', 'joined_at', '2025-01-05T00:00:00Z'),
    jsonb_build_object('row_no', 4, 'email', 'ghost@example.com', 'points', 50),
    jsonb_build_object('row_no', 5, 'shopify_customer_id', 13, 'points', 10, 'tier_name', 'Platinum'))) = 5, 'load: 5 rows';

  v_r := loyalty_joy_apply_import(v_snap);
  assert v_r = '{"imported": 2, "enrolled": 1, "unmatched": 1, "unknown_tier": 1}'::jsonb, format('import: summary, got %s', v_r);

  assert (select points_balance from loyalty_members where id = v_alice) = 2150, 'import: sets Joy''s balance, no double count';
  assert (select points from loyalty_ledger where member_id = v_alice and reason = 'import') = 1850, 'import: one entry for the difference';
  assert (select note from loyalty_ledger where member_id = v_alice and reason = 'import') like 'Joy balance 2150 at % (ours was 300)',
    'import: the note keeps both numbers';
  assert (select tier_key from loyalty_members where id = v_alice) = 'gold', 'import: Joy''s tier';
  assert (select enrolled_at from loyalty_members where id = v_alice) = '2024-06-01T00:00:00Z', 'import: earlier join date carried';
  assert (select last_activity_at from loyalty_members where id = v_alice) = '2026-10-21T00:00:00Z', 'import: activity date kept (never moved earlier)';
  assert (select birthday from loyalty_members where id = v_alice) = '1990-04-18', 'import: birthday filled';
  assert (select points_balance from loyalty_members where id = v_bob) = 80, 'import: matched by email, case-insensitive';
  assert (select enrolled_at from loyalty_members where id = v_bob) = '2024-01-01T00:00:00Z', 'import: a later Joy join date doesn''t move ours';

  select id into v_new from loyalty_members where program_id = v_prog and shopify_customer_id = 12;
  assert (select points_balance = 900 and tier_key = 'silver' and enrolled_at = '2025-01-05T00:00:00Z' and first_name = 'Carol'
            from loyalty_members where id = v_new), 'import: Joy-only member enrolled with their balance, tier and join date';
  assert not exists (select 1 from loyalty_members where program_id = v_prog and shopify_customer_id = 13), 'import: unknown tier row skipped';

  -- 0208: no activity date in the file (a Klaviyo export) -> clocks start at the export.
  assert (select last_activity_at = '2026-10-22T09:00:00Z' and last_demoted_at = '2026-10-22T09:00:00Z'
            from loyalty_members where id = v_bob), 'clocks: no activity date starts expiry and demotion at the export';
  assert (select last_demoted_at is null from loyalty_members where id = v_alice),
    'clocks: a row WITH an activity date keeps it (no demotion grace)';
  -- Carol: joined 2025-01-05, no orders, 900 Joy points. Without the floor the
  -- next hourly job would expire her balance; with it she keeps it.
  perform run_loyalty_jobs('2026-10-23T09:00:00Z');
  assert (select points_balance from loyalty_members where id = v_new) = 900,
    'clocks: a Joy-active member with no recent order keeps her points after the next job run';
  assert (select message from loyalty_joy_rows where snapshot_id = v_snap and row_no = 5) = 'no tier named Platinum', 'import: reason recorded';

  select count(*) into v_n from loyalty_events where program_id = v_prog;
  assert v_n = 0, 'import: quiet, no Klaviyo events (tier ups, reward thresholds)';
  assert not loyalty_quiet(), 'import: quiet mode off afterwards';
  select count(*) into v_n from loyalty_tier_changes where program_id = v_prog and reason = 'import';
  assert v_n = 2, 'import: tier changes logged as import';

  -- A snapshot applies once.
  begin
    perform loyalty_joy_apply_import(v_snap);
    assert false, 'import: a snapshot applies once';
  exception when others then
    if sqlerrm not like '%already applied%' then raise; end if;
  end;
  -- An OLDER export can't roll balances back.
  v_snap := loyalty_joy_create_snapshot(v_prog, 'import', '2026-10-21T09:00:00Z', 'older.csv');
  perform loyalty_joy_add_rows(v_snap, jsonb_build_array(jsonb_build_object('row_no', 1, 'shopify_customer_id', 10, 'points', 5, 'tier_name', 'Bronze')));
  begin
    perform loyalty_joy_apply_import(v_snap);
    assert false, 'import: an older export is refused';
  exception when others then
    if sqlerrm not like '%refusing to roll balances back%' then raise; end if;
  end;
  assert (select points_balance from loyalty_members where id = v_alice) = 2150, 'import: refused import changed nothing';

  -- --- parallel run: both systems keep going, then compare ---
  perform loyalty_post_entry(v_alice, 330, 'order', 'order:2:earn', 10000);          -- we saw it, Joy too
  perform loyalty_post_entry(v_bob, 100, 'adjust', 'test:bob', 0, null, 'staff', null, null, 'test');  -- only us
  perform loyalty_sync_customer(v_prog, '{"id":14,"email":"dan@example.com","state":"enabled"}');      -- 0 points: not a "missing in Joy"
  v_cmp := loyalty_joy_create_snapshot(v_prog, 'compare', '2026-10-30T09:00:00Z', 'joy-2026-10-30.csv');
  perform loyalty_joy_add_rows(v_cmp, jsonb_build_array(
    jsonb_build_object('row_no', 1, 'shopify_customer_id', 10, 'points', 2480, 'tier_name', 'Gold'),
    jsonb_build_object('row_no', 2, 'email', 'bob@example.com', 'points', 80, 'tier_name', 'Silver'),
    jsonb_build_object('row_no', 3, 'shopify_customer_id', 12, 'points', 900, 'tier_name', 'Silver'),
    jsonb_build_object('row_no', 4, 'shopify_customer_id', 99, 'email', 'zed@example.com', 'points', 10)));
  v_r := loyalty_joy_compare(v_cmp);
  assert (v_r->>'match')::int = 2 and (v_r->>'points_and_tier')::int = 1 and (v_r->>'missing_here')::int = 1
     and (v_r->>'missing_in_joy')::int = 0 and (v_r->>'points_diff_total')::int = 100, format('compare: summary, got %s', v_r);
  v_r := loyalty_joy_mismatches(v_cmp);
  assert jsonb_array_length(v_r) = 2 and v_r->0->>'status' = 'both' and v_r->0->>'message' = 'ours 180, Joy 80 (+100)',
    'compare: mismatches, biggest first, with the difference spelled out';
  assert (select points_balance from loyalty_members where id = v_bob) = 180, 'compare: changes nothing';

  -- --- cutover true-up: Alice redeemed 500 in Joy (we never saw it); a newer import sets her to Joy's ---
  v_snap := loyalty_joy_create_snapshot(v_prog, 'import', '2026-11-20T09:00:00Z', 'cutover.csv');
  perform loyalty_joy_add_rows(v_snap, jsonb_build_array(
    jsonb_build_object('row_no', 1, 'shopify_customer_id', 10, 'points', 1980, 'tier_name', 'Gold'),
    jsonb_build_object('row_no', 2, 'email', 'alice@example.com', 'points', 1980, 'tier_name', 'Gold')));
  v_r := loyalty_joy_apply_import(v_snap);
  assert v_r = '{"imported": 1, "already_imported": 1}'::jsonb, format('true-up: summary, got %s', v_r);
  assert (select points_balance from loyalty_members where id = v_alice) = 1980, 'true-up: 2480 -> Joy''s 1980';
  assert (select points from loyalty_ledger where member_id = v_alice and idempotency_key like 'import:%:' || v_snap) = -500,
    'true-up: the gap is a recorded -500 entry';

  -- --- purge ---
  assert loyalty_joy_purge(v_cmp) = 4, 'purge: rows deleted';
  assert (select row_count = 0 and file_name like '%(purged)' and summary is not null from loyalty_joy_snapshots where id = v_cmp),
    'purge: summary kept, PII gone';

  select count(*) into v_n from loyalty_verify_balances(v_prog);
  assert v_n = 0, 'verify: caches match the ledger';
end $$;

do $$
declare
  v_denied boolean;
begin
  set local role authenticated;
  begin
    perform 1 from loyalty_joy_rows limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rls: authenticated cannot read Joy export rows';
  reset role;
end $$;

rollback;

\echo 'test_loyalty_joy_migration: all assertions passed'
