-- =============================================================================
-- test_outbound_snapshots.sql — non-destructive test of 0305: snapshots keep
-- history per lead, validate status and todo shape, go when their lead is
-- deleted, and are unreachable from browser roles.
--
-- Run:  npm run test:sql -- outbound   (local stack only)
-- To see it FAIL:
--   * grant select on outbound_snapshots to authenticated; → "isolation" fails.
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_profile uuid;
  v_lead    uuid;
  v_client  uuid;
  v_user    uuid := gen_random_uuid();
  v_n       int;
  v_denied  boolean;
begin
  insert into outbound_profiles (name, product) values ('Snapshot test', 'seo') returning id into v_profile;
  insert into outbound_leads (profile_id, source_ref, business_name) values (v_profile, 'snap-1', 'Snap Biz')
  returning id into v_lead;

  insert into outbound_snapshots (lead_id, status, keyword, todo, summary, cost)
  values (v_lead, 'partial', 'cannabis store detroit', '[{"area":"maps","severity":"critical","text":"x"}]', 'line', 0.0182);
  insert into outbound_snapshots (lead_id, status, todo) values (v_lead, 'ready', '[]');
  select count(*) into v_n from outbound_snapshots where lead_id = v_lead;
  assert v_n = 2, 'history: a lead keeps every snapshot';

  begin
    insert into outbound_snapshots (lead_id, status) values (v_lead, 'done');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'status must be ready, partial or failed';

  begin
    insert into outbound_snapshots (lead_id, status, todo) values (v_lead, 'ready', '{"not":"a list"}');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'todo must be a list';

  -- Isolation, before the lead is deleted.
  insert into clients (name, slug, is_active) values ('Snapshot Test Client', 'snapshot-test-client', true)
  returning id into v_client;
  insert into auth.users (id, email) values (v_user, 'outbound-snapshot-test@example.com');
  update users set client_id = v_client, role = 'admin' where id = v_user;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;
  begin
    perform 1 from outbound_snapshots limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'isolation: a signed-in client can''t read snapshots';
  reset role;

  delete from outbound_leads where id = v_lead;
  select count(*) into v_n from outbound_snapshots where lead_id = v_lead;
  assert v_n = 0, 'cascade: snapshots go with their lead';

  raise notice 'test_outbound_snapshots: all assertions passed';
end;
$$;

rollback;
