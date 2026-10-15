-- =============================================================================
-- test_loyalty_retention.sql — non-destructive test of 0209: the monthly
-- retention purge deletes only what's past its period, keeps Joy snapshot
-- summaries, and the access log stays append-only for everything else.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_retention.sql
--
-- To see it FAIL:
--   * in loyalty_append_only drop the "old.at < now() - interval '2 years'" check
--     -> "retention: a recent access-log row is kept" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_prog   uuid;
  v_old    uuid;
  v_new    uuid;
  v_r      jsonb;
  v_ok     boolean;
  v_staff  uuid := gen_random_uuid();
begin
  insert into clients (name, slug, is_active) values ('Retention Test', 'retention-test', true) returning id into v_client;
  insert into loyalty_programs (client_id, shop_domain, name) values (v_client, 'retention-test.myshopify.com', 'Wave Rewards')
  returning id into v_prog;

  insert into loyalty_webhook_receipts (shop_domain, webhook_id, topic, received_at) values
    ('retention-test.myshopify.com', 'old', 'orders/paid', now() - interval '91 days'),
    ('retention-test.myshopify.com', 'new', 'orders/paid', now() - interval '89 days');

  insert into loyalty_joy_snapshots (id, program_id, kind, taken_at, file_name, created_at, summary)
  values (gen_random_uuid(), v_prog, 'compare', now() - interval '50 days', 'old.csv', now() - interval '50 days', '{"match": 1}')
  returning id into v_old;
  insert into loyalty_joy_snapshots (id, program_id, kind, taken_at, file_name, created_at)
  values (gen_random_uuid(), v_prog, 'compare', now() - interval '10 days', 'new.csv', now() - interval '10 days')
  returning id into v_new;
  insert into loyalty_joy_rows (snapshot_id, row_no, email, points) values
    (v_old, 2, 'a@example.com', 5), (v_old, 3, 'b@example.com', 6), (v_new, 2, 'c@example.com', 7);

  insert into loyalty_access_log (staff_user_id, staff_email, action, at) values
    (v_staff, 'staff@lumilink.example', 'search', now() - interval '2 years 1 day'),
    (v_staff, 'staff@lumilink.example', 'view', now() - interval '1 year');

  -- The append-only rule still holds outside the job.
  begin
    delete from loyalty_access_log where staff_user_id = v_staff;
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%append-only%';
  end;
  assert v_ok, 'append-only: a direct delete is still refused';
  begin
    perform set_config('loyalty.retention_purge', 'on', true);
    delete from loyalty_access_log where staff_user_id = v_staff and action = 'view';
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%append-only%';
  end;
  perform set_config('loyalty.retention_purge', '', true);
  assert v_ok, 'append-only: even with the flag, a row under 2 years old is refused';

  v_r := loyalty_retention_purge();
  assert (v_r->>'webhook_receipts')::int = 1 and (v_r->>'joy_snapshots_purged')::int = 1 and (v_r->>'joy_rows')::int = 2
     and (v_r->>'access_log')::int = 1, format('retention: summary, got %s', v_r);

  assert (select count(*) from loyalty_webhook_receipts where shop_domain = 'retention-test.myshopify.com') = 1
     and exists (select 1 from loyalty_webhook_receipts where webhook_id = 'new'), 'retention: receipts under 90 days kept';
  assert not exists (select 1 from loyalty_joy_rows where snapshot_id = v_old), 'retention: old Joy rows purged';
  assert (select count(*) from loyalty_joy_rows where snapshot_id = v_new) = 1, 'retention: recent Joy rows kept';
  assert (select summary = '{"match": 1}'::jsonb and file_name like '%(purged)' from loyalty_joy_snapshots where id = v_old),
    'retention: purged snapshot keeps its summary';
  assert (select count(*) from loyalty_access_log where staff_user_id = v_staff) = 1
     and exists (select 1 from loyalty_access_log where staff_user_id = v_staff and action = 'view'),
    'retention: a recent access-log row is kept';
  assert coalesce(current_setting('loyalty.retention_purge', true), '') = '', 'retention: the purge flag is off afterwards';

  v_r := loyalty_retention_purge();
  assert (v_r->>'webhook_receipts')::int = 0 and (v_r->>'access_log')::int = 0, 'retention: a second run deletes nothing';
end $$;

do $$
declare
  v_denied boolean;
begin
  set local role authenticated;
  begin
    perform loyalty_retention_purge();
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rls: authenticated cannot run the purge';
  reset role;
end $$;

rollback;

\echo 'test_loyalty_retention: all assertions passed'
