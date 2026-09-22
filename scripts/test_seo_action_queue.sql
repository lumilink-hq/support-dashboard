-- =============================================================================
-- test_seo_action_queue.sql — non-destructive test of 0054: the tenant
-- column-protection trigger on seo_actions, the one-live-draft-per-page guard,
-- the drafting target view, and tenant isolation (rule 4).
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_seo_action_queue.sql
--
-- To see it FAIL:
--   * drop trigger trg_protect_seo_actions_tenant_columns on seo_actions;
--     -> "trigger: a tenant cannot rewrite the draft while approving" fails.
--   * drop index uq_seo_actions_live;
--     -> "dedupe: a second live draft for the same page and field" fails.
--   * grant select on seo_draft_targets, job_attempts to authenticated;
--     -> "rule 4: authenticated must not read seo_draft_targets" fails. Both
--     grants are needed: the view is security_invoker and reads job_attempts,
--     which authenticated cannot select either, so removing only the view's
--     revoke exposes nothing (two layers; the test fails if both are gone).
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client_a uuid;
  v_client_b uuid;
  v_loc_a    uuid;
  v_loc_b    uuid;
  v_find_a   uuid;
  v_act_a    uuid;
  v_act_b    uuid;
  v_user_a   uuid;
  v_seen     int;
  v_denied   boolean;
  v_row      seo_actions%rowtype;
begin
  insert into clients (name, slug, is_active) values ('Queue Test A', 'queue-test-a', true) returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('Queue Test B', 'queue-test-b', true) returning id into v_client_b;
  insert into seo_locations (client_id, name, website_url) values (v_client_a, 'Loc A', 'https://a.example.com') returning id into v_loc_a;
  insert into seo_locations (client_id, name, website_url) values (v_client_b, 'Loc B', 'https://b.example.com') returning id into v_loc_b;

  -- ---------------------------------------------------------------------------
  -- Target view (as the owner role).
  -- ---------------------------------------------------------------------------
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc_a;
  assert v_seen = 0, 'targets: a location with no findings is not a target';

  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, target_url)
  values (v_client_a, v_loc_a, 'crawl', 'missing_title', 'critical', 'no title', 'https://a.example.com/')
  returning id into v_find_a;
  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, target_url)
  values (v_client_a, v_loc_a, 'crawl', 'thin_content', 'warning', 'thin', 'https://a.example.com/');

  select count(*) into v_seen from seo_draft_targets where location_id = v_loc_a and is_due;
  assert v_seen = 1, 'targets: an open draftable finding makes the location due';

  -- thin_content alone is not draftable.
  update seo_findings set status = 'dismissed' where id = v_find_a;
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc_a;
  assert v_seen = 0, 'targets: a location with only non-draftable open findings is not a target';
  update seo_findings set status = 'open' where id = v_find_a;

  -- ---------------------------------------------------------------------------
  -- Dispatch (needs pg_net; the Vault secrets are created here).
  -- ---------------------------------------------------------------------------
  assert request_seo_draft(v_loc_a) is null, 'dispatch: without the Vault secrets nothing is sent';
  assert (select last_error from job_attempts where client_id = v_client_a and job_type = 'seo_draft' and entity_id = v_loc_a) = 'missing_vault_secret',
    'dispatch: without the Vault secrets it settles as a failure instead of hanging';
  update job_attempts set next_run_at = now() where client_id = v_client_a and job_type = 'seo_draft';

  perform vault.create_secret('https://example.supabase.co/functions/v1/seo-draft', 'seo_draft_url', '');
  perform vault.create_secret('unit-test-shared-secret', 'voice_tool_secret', '');

  assert request_seo_draft(v_loc_a) is not null, 'dispatch: succeeds once the secrets exist';
  assert request_seo_draft(v_loc_a) is null, 'dedup: a second dispatch while running is refused';
  perform complete_job_attempt(v_client_a, 'seo_draft', true, null, 1440, 1440, v_loc_a);
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc_a and is_due;
  assert v_seen = 0, 'dispatch: a completed location is not due again for a day';
  update job_attempts set next_run_at = now() where client_id = v_client_a and job_type = 'seo_draft';
  assert (run_due_seo_drafts() ->> 'requested')::int >= 1, 'run_due: requests due locations';

  -- ---------------------------------------------------------------------------
  -- One live draft per (location, page, field).
  -- ---------------------------------------------------------------------------
  insert into seo_actions (client_id, location_id, finding_id, action_type, target_field, finding_type, target_url,
                           previous_value, proposed_value, diff, status, idempotency_key)
  values (v_client_a, v_loc_a, v_find_a, 'onpage_fix', 'title_tag', 'missing_title', 'https://a.example.com/',
          '{"value":null}', '{"value":"Acme Plumbing: Drain Repair in Tulsa"}',
          '{"field":"title_tag","before":null,"after":"Acme Plumbing: Drain Repair in Tulsa"}',
          'pending_approval', 'seo-draft:test-1')
  returning id into v_act_a;

  select count(*) into v_seen from seo_draft_targets where location_id = v_loc_a;
  assert v_seen = 0, 'targets: a finding with a live draft no longer makes the location a target';

  begin
    insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url,
                             proposed_value, status, idempotency_key)
    values (v_client_a, v_loc_a, 'onpage_fix', 'title_tag', 'missing_title', 'https://a.example.com/',
            '{"value":"another"}', 'pending_approval', 'seo-draft:test-2');
    v_denied := false;
  exception when unique_violation then
    v_denied := true;
  end;
  assert v_denied, 'dedupe: a second live draft for the same page and field must be refused';

  -- A different page, or a different field, is fine.
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url,
                           proposed_value, status, idempotency_key)
  values (v_client_a, v_loc_a, 'onpage_fix', 'title_tag', 'missing_title', 'https://a.example.com/about',
          '{"value":"x"}', 'pending_approval', 'seo-draft:test-3');
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url,
                           proposed_value, status, idempotency_key)
  values (v_client_a, v_loc_a, 'onpage_fix', 'meta_description', 'missing_meta_description', 'https://a.example.com/',
          '{"value":"y"}', 'pending_approval', 'seo-draft:test-4');

  -- Rule 2's DB backstop still holds.
  begin
    insert into seo_actions (client_id, location_id, action_type, target_field, proposed_value, status, idempotency_key)
    values (v_client_a, v_loc_a, 'onpage_fix', 'phone', '{"value":"z"}', 'pending_approval', 'seo-draft:test-5');
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'rule 2: target_field phone must be refused';

  -- A terminal draft no longer blocks a new one for the same page and field.
  update seo_actions set status = 'published' where id = v_act_a;
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url,
                           proposed_value, status, idempotency_key)
  values (v_client_a, v_loc_a, 'onpage_fix', 'title_tag', 'missing_title', 'https://a.example.com/',
          '{"value":"again"}', 'pending_approval', 'seo-draft:test-6');

  -- A recent rejection keeps the finding out of the target view; an old one doesn't.
  update seo_actions set status = 'rejected' where idempotency_key = 'seo-draft:test-6';
  update seo_actions set status = 'published' where idempotency_key = 'seo-draft:test-1';
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc_a;
  assert v_seen = 0, 'targets: a rejection in the last 30 days suppresses re-drafting';
  update seo_actions set updated_at = now() - interval '31 days' where idempotency_key = 'seo-draft:test-6';
  -- (the updated_at trigger runs on that update too; force the stored value)
  alter table seo_actions disable trigger trg_seo_actions_updated_at;
  update seo_actions set updated_at = now() - interval '31 days' where idempotency_key = 'seo-draft:test-6';
  -- 0055: a draft published in the last 14 days also covers its finding, so age
  -- the published one too or it (not the rejection) would be what suppresses it.
  update seo_actions set updated_at = now() - interval '31 days' where idempotency_key = 'seo-draft:test-1';
  alter table seo_actions enable trigger trg_seo_actions_updated_at;
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc_a;
  assert v_seen = 1, 'targets: a rejection older than 30 days no longer suppresses re-drafting';

  -- Tenant B's draft, for the isolation checks below.
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url,
                           proposed_value, status, idempotency_key)
  values (v_client_b, v_loc_b, 'onpage_fix', 'title_tag', 'missing_title', 'https://b.example.com/',
          '{"value":"b"}', 'pending_approval', 'seo-draft:test-b')
  returning id into v_act_b;

  -- Give tenant A one clean pending draft to approve.
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url,
                           previous_value, proposed_value, diff, status, idempotency_key)
  values (v_client_a, v_loc_a, 'onpage_fix', 'h1', 'missing_h1', 'https://a.example.com/',
          '{"value":null}', '{"value":"Drain Repair in Tulsa"}',
          '{"field":"h1","before":null,"after":"Drain Repair in Tulsa"}',
          'pending_approval', 'seo-draft:test-h1')
  returning id into v_act_a;

  -- ---------------------------------------------------------------------------
  -- As tenant A (authenticated, RLS in effect).
  -- ---------------------------------------------------------------------------
  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'seo-queue-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  select count(*) into v_seen from seo_actions where client_id = v_client_b;
  assert v_seen = 0, 'rls: tenant A must not see tenant B''s drafts';

  begin
    perform 1 from seo_draft_targets limit 1;
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  assert v_denied, 'rule 4: authenticated must not read seo_draft_targets';

  -- The tenant cannot rewrite the draft while approving it.
  begin
    update seo_actions
       set status = 'approved',
           proposed_value = '{"value":"Buy cheap watches"}',
           diff = '{"field":"h1","before":null,"after":"Buy cheap watches"}'
     where id = v_act_a;
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  assert v_denied, 'trigger: a tenant cannot rewrite the draft while approving it';

  begin
    update seo_actions set target_field = 'meta_description', status = 'approved' where id = v_act_a;
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  assert v_denied, 'trigger: a tenant cannot retarget the draft while approving it';

  -- Forging who approved is refused, both alone and alongside a status change.
  begin
    update seo_actions set approved_by = gen_random_uuid() where id = v_act_a;
    v_denied := false;
  exception when others then
    v_denied := true;
  end;
  assert v_denied, 'trigger: approved_by cannot be set without an approval';

  -- The clean approval works, and the trigger stamps the approver itself.
  update seo_actions set status = 'approved', approved_by = gen_random_uuid() where id = v_act_a;
  select * into v_row from seo_actions where id = v_act_a;
  assert v_row.status = 'approved', 'approve: a pending draft can be approved';
  assert v_row.approved_by = v_user_a, 'approve: approved_by is the caller, not what the client sent';
  assert v_row.approved_at is not null, 'approve: approved_at is stamped';
  assert v_row.proposed_value = '{"value":"Drain Repair in Tulsa"}'::jsonb, 'approve: the draft text is untouched';

  -- Only a pending draft can be resolved (0042's policy still holds).
  update seo_actions set status = 'rejected' where id = v_act_a;
  select status into v_row.status from seo_actions where id = v_act_a;
  assert v_row.status = 'approved', 'rls: an approved draft cannot be flipped back by the tenant';

  -- Tenant A cannot touch tenant B's draft.
  update seo_actions set status = 'approved' where id = v_act_b;
  reset role;
  select status into v_row.status from seo_actions where id = v_act_b;
  assert v_row.status = 'pending_approval', 'rls: tenant A must not approve tenant B''s draft';

  raise notice 'ALL 0054 SEO ACTION QUEUE TESTS PASSED';
end;
$$;

rollback;
