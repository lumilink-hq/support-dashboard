-- =============================================================================
-- test_loyalty_shopify_sync.sql — non-destructive test of 0201 (LL Loyalty
-- module 2): enrollment rule, webhook vs backfill orders, tier spend window,
-- duplicate deliveries, proportional refund clawback, webhook receipts, token
-- storage, backfill start, and the privacy redact paths.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_shopify_sync.sql
--
-- To see it FAIL:
--   * in loyalty_record_order award points for p_source = 'backfill' too
--     -> "backfill: no points" fails.
--   * in loyalty_record_refund drop the least(v_o.eligible_cents, …) cap
--     -> "refund: never claws back more than the order earned" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_prog   uuid;
  v_alice  uuid;
  v_r      jsonb;
  v_n      int;
  v_text   text;
  v_denied boolean;
  v_live   timestamptz;
begin
  insert into clients (name, slug, is_active) values ('Loyalty Sync Test', 'loyalty-sync-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name, points_per_dollar, tier_spend_since)
  values (v_client, 'sync-test.myshopify.com', 'Wave Rewards', 3, '2026-06-05')
  returning id into v_prog;
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents, earn_multiplier) values
    (v_prog, 'bronze', 'Bronze', 0, 0, 1.0),
    (v_prog, 'silver', 'Silver', 1, 50000, 1.1);

  -- --- token + live_since ---
  perform vault.create_secret('{"client_id":"cid12345","client_secret":"csecret"}', 'test-loyalty-app');
  insert into loyalty_shopify_apps (shop_domain, app_client_id, program_id, app_secret_ref)
  values ('sync-test.myshopify.com', 'cid12345', v_prog, 'test-loyalty-app');
  v_text := get_loyalty_shopify_apps('SYNC-TEST.myshopify.com')->0->>'credentials';
  assert v_text like '%csecret%', 'apps: credentials come back for the shop (case-insensitive)';
  assert jsonb_array_length(get_loyalty_shopify_apps('nope.myshopify.com')) = 0, 'apps: unknown shop is an empty list';
  begin
    perform start_loyalty_backfill(v_prog);
    v_denied := false;
  exception when others then v_denied := sqlerrm like '%install the app first%';
  end;
  assert v_denied, 'backfill: refuses to start before install';

  assert store_loyalty_shopify_token('sync-test.myshopify.com', 'cid12345', 'shpat_test_123', array['read_orders']) = v_prog,
    'token: returns the program';
  assert get_loyalty_shopify_token(v_prog)->>'access_token' = 'shpat_test_123', 'token: readable for the backfill';
  select live_since into v_live from loyalty_programs where id = v_prog;
  assert v_live is not null, 'token: first install sets live_since';
  perform store_loyalty_shopify_token('sync-test.myshopify.com', 'cid12345', 'shpat_test_456', array['read_orders']);
  assert (select live_since from loyalty_programs where id = v_prog) = v_live, 'token: reinstall keeps live_since';

  -- --- enrollment rule ---
  assert loyalty_sync_customer(v_prog, '{"id":1,"email":"g@example.com","state":"disabled"}') is null,
    'enroll: a guest (no account) is not enrolled';
  v_alice := loyalty_sync_customer(v_prog, '{"id":2,"email":"a@example.com","first_name":"Alice","state":"enabled","created_at":"2026-05-01T00:00:00Z"}');
  assert v_alice is not null, 'enroll: an account holder is enrolled';
  assert (select enrolled_at from loyalty_members where id = v_alice) = '2026-05-01T00:00:00Z', 'enroll: dated by customer created_at';
  assert loyalty_sync_customer(v_prog, '{"id":1,"email":"g@example.com","state":"enabled"}') is not null,
    'enroll: a guest who makes an account is enrolled on update';
  assert loyalty_sync_customer(v_prog, '{"state":"enabled"}') is null, 'enroll: no customer id, nothing';

  -- --- webhook order: earns points, counts spend ---
  v_r := loyalty_record_order(v_prog, jsonb_build_object(
    'id', 9001, 'name', '#9001', 'processed_at', now(), 'eligible_cents', 10000,
    'customer', jsonb_build_object('id', 2, 'state', 'enabled')), 'webhook');
  assert v_r->>'status' = 'recorded' and (v_r->>'points')::int = 300, 'webhook: $100 at bronze = 300 points';
  assert (v_r->>'orders_before')::int = 0 and (v_r->>'orders_after')::int = 1, 'webhook: order count 0 -> 1';
  v_r := loyalty_record_order(v_prog, jsonb_build_object(
    'id', 9001, 'eligible_cents', 10000, 'customer', jsonb_build_object('id', 2)), 'webhook');
  assert v_r->>'status' = 'duplicate', 'webhook: redelivery is a duplicate';
  v_r := loyalty_record_order(v_prog, jsonb_build_object(
    'id', 9002, 'eligible_cents', 10000, 'customer', jsonb_build_object('id', 777, 'state', 'disabled')), 'webhook');
  assert v_r->>'status' = 'not_member', 'webhook: guest order is skipped';

  -- --- backfill: old order (before tier window) and a refunded one ---
  v_r := loyalty_record_orders(v_prog, jsonb_build_array(
    jsonb_build_object('id', 8001, 'processed_at', '2026-01-10T00:00:00Z', 'eligible_cents', 90000,
                       'customer', jsonb_build_object('id', 2, 'state', 'enabled')),
    jsonb_build_object('id', 8002, 'processed_at', '2026-07-10T00:00:00Z', 'eligible_cents', 60000,
                       'net_eligible_cents', 45000, 'customer', jsonb_build_object('id', 2, 'state', 'enabled')),
    jsonb_build_object('id', 9001, 'processed_at', '2026-07-11T00:00:00Z', 'eligible_cents', 10000,
                       'customer', jsonb_build_object('id', 2, 'state', 'enabled'))), 'backfill');
  assert (v_r->>'recorded')::int = 2 and (v_r->>'duplicate')::int = 1, 'backfill: 2 recorded, live order not double-counted';
  select count(*) into v_n from loyalty_members
   where id = v_alice and points_balance = 300 and paid_order_count = 3 and tier_spend_cents = 10000 + 45000;
  assert v_n = 1, 'backfill: no points; all orders counted; spend only inside the window, net of past refunds';
  assert (select tier_key from loyalty_members where id = v_alice) = 'silver', 'backfill: spend can promote';
  assert (select spend_counted from loyalty_orders where program_id = v_prog and shopify_order_id = 8001) = false,
    'backfill: order before tier_spend_since does not count toward tier';

  -- --- refunds: proportional, cumulative, capped ---
  assert loyalty_record_refund(v_prog, 9001, 70001, 2500) = 'recorded', 'refund: recorded';
  assert (select points_balance from loyalty_members where id = v_alice) = 225, 'refund: 25% of 300 clawed back';
  assert loyalty_record_refund(v_prog, 9001, 70001, 2500) = 'duplicate', 'refund: redelivery is a duplicate';
  assert loyalty_record_refund(v_prog, 9001, 70002, 999999) = 'recorded', 'refund: oversize refund still records';
  select count(*) into v_n from loyalty_orders
   where program_id = v_prog and shopify_order_id = 9001 and refunded_cents = 10000 and points_clawed = 300;
  assert v_n = 1, 'refund: never claws back more than the order earned';
  assert (select points_balance from loyalty_members where id = v_alice) = 0, 'refund: full refund returns the balance to 0';
  assert (select tier_spend_cents from loyalty_members where id = v_alice) = 45000, 'refund: spend clawed back';
  assert (select tier_key from loyalty_members where id = v_alice) = 'bronze', 'refund: tier drops below silver';
  assert loyalty_record_refund(v_prog, 8001, 70003, 1000) = 'recorded', 'refund: on a backfilled order';
  assert (select tier_spend_cents from loyalty_members where id = v_alice) = 45000,
    'refund: an order outside the tier window claws back no spend';
  assert loyalty_record_refund(v_prog, 123, 70004, 1000) = 'unknown_order', 'refund: unknown order is ignored';
  select count(*) into v_n from loyalty_verify_balances(v_prog);
  assert v_n = 0, 'verify: caches match the ledger';

  -- --- webhook receipts ---
  assert loyalty_webhook_begin('sync-test.myshopify.com', 'wh-1', 'orders/paid'), 'receipt: new delivery needs work';
  perform loyalty_webhook_finish('sync-test.myshopify.com', 'wh-1', 'error', 'boom');
  assert loyalty_webhook_begin('sync-test.myshopify.com', 'wh-1', 'orders/paid'), 'receipt: failed delivery is retried';
  perform loyalty_webhook_finish('sync-test.myshopify.com', 'wh-1', 'recorded');
  assert not loyalty_webhook_begin('sync-test.myshopify.com', 'wh-1', 'orders/paid'), 'receipt: processed delivery is skipped';
  assert (select attempts from loyalty_webhook_receipts where webhook_id = 'wh-1') = 3, 'receipt: attempts counted';

  -- --- backfill start ---
  assert start_loyalty_backfill(v_prog) = v_live, 'backfill: bounded by live_since';
  assert (select status = 'pending' and phase = 'customers' from loyalty_backfills where program_id = v_prog), 'backfill: pending';

  -- --- redact ---
  assert loyalty_redact_customer('sync-test.myshopify.com', 2) = 1, 'redact: member deleted';
  select count(*) into v_n from loyalty_orders where member_id = v_alice;
  assert v_n = 0, 'redact: their orders go with them';
  assert loyalty_redact_customer('other.myshopify.com', 1) = 0, 'redact: scoped to the shop';
  assert loyalty_redact_shop('sync-test.myshopify.com') = 1, 'shop redact: program deleted';
  select count(*) into v_n from loyalty_shopify_apps where shop_domain = 'sync-test.myshopify.com';
  assert v_n = 0, 'shop redact: app rows gone';
  select count(*) into v_n from vault.secrets where name like 'loyalty-shopify-token:sync-test.myshopify.com:%';
  assert v_n = 0, 'shop redact: token deleted from Vault';
  select count(*) into v_n from loyalty_webhook_receipts where shop_domain = 'sync-test.myshopify.com';
  assert v_n = 0, 'shop redact: receipts gone';
end $$;

do $$
declare
  v_denied boolean;
begin
  set local role authenticated;
  begin
    perform 1 from loyalty_orders limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rls: authenticated cannot read loyalty_orders';
  begin
    perform get_loyalty_shopify_apps('x.myshopify.com');
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rls: authenticated cannot read app credentials';
  reset role;
end $$;

rollback;

\echo 'test_loyalty_shopify_sync: all assertions passed'
