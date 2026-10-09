-- =============================================================================
-- test_seo_gbp_write_path.sql — 0079 (module 4): the profile-edit allowlist on
-- seo_actions, and when seo_draft_targets makes a location due for a Business
-- Profile description draft.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_gbp_write_path.sql
--
-- To see it FAIL:
--   * alter table seo_actions drop constraint seo_actions_gbp_field_allowlist;
--     -> "rule 2: only allowlisted profile fields" fails.
--   * drop the gbp_profile branch from seo_draft_targets
--     -> "due: an open description finding with no draft" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_loc    uuid;
  v_seen   int;
  v_denied boolean;
  f        text;
begin
  insert into clients (name, slug, is_active) values ('GBP Write', 'gbp-write-test', true) returning id into v_client;
  insert into seo_locations (client_id, name) values (v_client, 'Store') returning id into v_loc;

  -- Rule 2 at the database: profile edits only to allowlisted fields.
  foreach f in array array['gbp_hours', 'gbp_primary_category', 'gbp_title', 'gbp_phone', 'website'] loop
    begin
      insert into seo_actions (client_id, location_id, action_type, target_field, idempotency_key, status)
      values (v_client, v_loc, 'gbp_field_update', f, 'k-' || f, 'pending_approval');
      v_denied := false;
    exception when check_violation then v_denied := true;
    end;
    assert v_denied, format('rule 2: only allowlisted profile fields (%s was accepted)', f);
  end loop;
  begin
    insert into seo_actions (client_id, location_id, action_type, target_field, idempotency_key, status)
    values (v_client, v_loc, 'gbp_field_update', 'phone', 'k-phone', 'pending_approval');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'rule 2: 0042''s NAP check still refuses phone';

  -- Due: an open description finding, no draft yet.
  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, target_url)
  values (v_client, v_loc, 'gbp_profile', 'gbp_short_description', 'info', 'Short', 'https://maps.google.com/?cid=1');
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 1, 'due: an open description finding with no draft';

  -- A different, undraftable profile finding alone is not a reason.
  update seo_findings set finding_type = 'gbp_missing_hours' where location_id = v_loc;
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 0, 'not due: hours are not drafted';
  update seo_findings set finding_type = 'gbp_short_description' where location_id = v_loc;

  -- A live description draft (even one written for the other description finding) covers it.
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url, idempotency_key, status, proposed_value)
  values (v_client, v_loc, 'gbp_field_update', 'gbp_description', 'gbp_missing_description', 'https://maps.google.com/?cid=1', 'gbp-draft:x', 'pending_approval', '{"value":"x"}');
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 0, 'not due: a live description draft covers either finding';

  -- Rejected 10 days ago: still covered. 40 days ago: due again.
  update seo_actions set status = 'rejected' where idempotency_key = 'gbp-draft:x';
  -- Backdating needs the updated_at trigger off (same as test_seo_action_queue.sql;
  -- the transaction rolls it back).
  alter table seo_actions disable trigger trg_seo_actions_updated_at;
  update seo_actions set updated_at = now() - interval '10 days' where idempotency_key = 'gbp-draft:x';
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 0, 'not due: rejected recently';
  update seo_actions set updated_at = now() - interval '40 days' where idempotency_key = 'gbp-draft:x';
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 1, 'due: rejected over 30 days ago';

  -- Page fixes still schedule as before.
  delete from seo_findings where location_id = v_loc;
  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, target_url)
  values (v_client, v_loc, 'crawl', 'missing_title', 'warning', 'No title', 'https://x.example/');
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 1, 'due: crawl findings unchanged';

  -- Still service-role only (rule 4).
  select count(*) into v_seen from information_schema.role_table_grants
   where table_name = 'seo_draft_targets' and grantee in ('authenticated', 'anon');
  assert v_seen = 0, 'rule 4: seo_draft_targets not granted to tenants';

  raise notice 'test_seo_gbp_write_path: all assertions passed';
end;
$$;

rollback;
