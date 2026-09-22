-- =============================================================================
-- test_seo_site_adapter.sql — non-destructive test of 0055: connection and
-- credential isolation (rule 4), the claim/rollback/manual RPCs, the widened
-- live-draft index, the publish/check scheduling, and seo_draft_targets' new
-- coverage windows. Needs pg_net; the Vault secrets are created here.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_seo_site_adapter.sql
--
-- To see it FAIL:
--   * drop policy seo_site_connections_tenant_select on seo_site_connections;
--     -> "rls: tenant A sees only its own connection" fails.
--   * grant select on seo_site_credentials to authenticated;
--     -> "rule 4: authenticated must not read seo_site_credentials" fails.
--   * change request_seo_rollback's client check to `true`;
--     -> "rollback: another tenant's action is not_found" fails.
--   * drop index uq_seo_actions_live;
--     -> "dedupe: a manual_required draft still blocks a second live draft" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client_a uuid;
  v_client_b uuid;
  v_loc_a    uuid;
  v_loc_a2   uuid;
  v_loc_b    uuid;
  v_conn_a   uuid;
  v_conn_b   uuid;
  v_user_a   uuid;
  v_act      uuid;
  v_act_b    uuid;
  v_seen     int;
  v_denied   boolean;
  v_ok       boolean;
  v_txt      text;
  v_json     jsonb;
  v_row      seo_actions%rowtype;
begin
  insert into clients (name, slug, is_active) values ('Site Test A', 'site-test-a', true) returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('Site Test B', 'site-test-b', true) returning id into v_client_b;
  insert into seo_locations (client_id, name, website_url) values (v_client_a, 'Loc A',  'https://a.example.com') returning id into v_loc_a;
  insert into seo_locations (client_id, name, website_url) values (v_client_a, 'Loc A2', 'https://a2.example.com') returning id into v_loc_a2;
  insert into seo_locations (client_id, name, website_url) values (v_client_b, 'Loc B',  'https://b.example.com') returning id into v_loc_b;

  -- ---------------------------------------------------------------------------
  -- Schema guardrails
  -- ---------------------------------------------------------------------------
  insert into seo_site_connections (client_id, location_id, shop_domain) values (v_client_a, v_loc_a, 'shop-a.myshopify.com') returning id into v_conn_a;
  insert into seo_site_connections (client_id, location_id, shop_domain) values (v_client_b, v_loc_b, 'shop-b.myshopify.com') returning id into v_conn_b;

  begin
    insert into seo_site_connections (client_id, location_id, shop_domain) values (v_client_a, v_loc_a2, 'evil.example.com');
    v_denied := false;
  exception when check_violation then v_denied := true; end;
  assert v_denied, 'schema: shop_domain must be a *.myshopify.com host';

  begin
    insert into seo_site_connections (client_id, location_id, shop_domain) values (v_client_a, v_loc_a, 'other.myshopify.com');
    v_denied := false;
  exception when unique_violation then v_denied := true; end;
  assert v_denied, 'schema: one connection per location';

  begin
    update seo_site_connections set status = 'bogus' where id = v_conn_a;
    v_denied := false;
  exception when check_violation then v_denied := true; end;
  assert v_denied, 'schema: connection status is constrained';

  perform vault.create_secret('{"access_token":"shpat_secret_a"}', 'seo-site-a', '');
  insert into seo_site_credentials (connection_id, credentials_ref) values (v_conn_a, 'seo-site-a');

  -- ---------------------------------------------------------------------------
  -- get_seo_site_credentials (service role / owner)
  -- ---------------------------------------------------------------------------
  v_json := get_seo_site_credentials(v_loc_a);
  assert v_json ->> 'credentials' = '{"access_token":"shpat_secret_a"}', 'creds: decrypts the Vault secret';
  assert v_json ->> 'shop_domain' = 'shop-a.myshopify.com', 'creds: carries the shop domain';
  assert get_seo_site_credentials(v_loc_a2) is null, 'creds: a location with no connection returns null';
  assert (get_seo_site_credentials(v_loc_b) ->> 'credentials') is null, 'creds: a connection with no credential row returns a null credential';

  -- ---------------------------------------------------------------------------
  -- Actions in each state
  -- ---------------------------------------------------------------------------
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url, proposed_value, status, idempotency_key)
  values (v_client_a, v_loc_a, 'onpage_fix', 'title_tag', 'missing_title', 'https://a.example.com/products/x', '{"value":"T"}', 'approved', 'k-appr')
  returning id into v_act;

  -- claim
  assert claim_seo_action(v_act, 'publish') is true, 'claim: an approved action can be claimed';
  select * into v_row from seo_actions where id = v_act;
  assert v_row.status = 'publishing', 'claim: it is now publishing';
  assert claim_seo_action(v_act, 'publish') is false, 'claim: a second claim is refused (already in flight)';

  alter table seo_actions disable trigger trg_seo_actions_updated_at;
  update seo_actions set updated_at = now() - interval '20 minutes' where id = v_act;
  alter table seo_actions enable trigger trg_seo_actions_updated_at;
  assert claim_seo_action(v_act, 'publish') is true, 'claim: an action stuck in publishing for 15+ minutes can be reclaimed';

  begin
    perform claim_seo_action(v_act, 'nonsense');
    v_denied := false;
  exception when others then v_denied := true; end;
  assert v_denied, 'claim: an unknown kind raises';

  -- rollback claim
  update seo_actions set status = 'rollback_requested' where id = v_act;
  assert claim_seo_action(v_act, 'publish') is false, 'claim: publish cannot claim a rollback_requested row';
  assert claim_seo_action(v_act, 'rollback') is true, 'claim: rollback claims a rollback_requested row';
  select * into v_row from seo_actions where id = v_act;
  assert v_row.status = 'rolling_back', 'claim: it is now rolling_back';

  -- the live index now also covers publishing / manual_required
  update seo_actions set status = 'manual_required' where id = v_act;
  begin
    insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url, proposed_value, status, idempotency_key)
    values (v_client_a, v_loc_a, 'onpage_fix', 'title_tag', 'missing_title', 'https://a.example.com/products/x', '{"value":"T2"}', 'pending_approval', 'k-dup');
    v_denied := false;
  exception when unique_violation then v_denied := true; end;
  assert v_denied, 'dedupe: a manual_required draft still blocks a second live draft';

  -- ---------------------------------------------------------------------------
  -- seo_draft_targets coverage windows
  -- ---------------------------------------------------------------------------
  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, target_url)
  values (v_client_a, v_loc_a, 'crawl', 'missing_title', 'critical', 't', 'https://a.example.com/products/x');
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc_a;
  assert v_seen = 0, 'targets: a manual_required draft covers its finding';

  update seo_actions set status = 'published' where id = v_act;
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc_a;
  assert v_seen = 0, 'targets: a draft published in the last 14 days covers its finding';

  alter table seo_actions disable trigger trg_seo_actions_updated_at;
  update seo_actions set updated_at = now() - interval '15 days' where id = v_act;
  alter table seo_actions enable trigger trg_seo_actions_updated_at;
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc_a;
  assert v_seen = 1, 'targets: a publish older than 14 days no longer covers a finding that is still open';

  -- ---------------------------------------------------------------------------
  -- Scheduling
  -- ---------------------------------------------------------------------------
  -- Work waiting on a location WITH NO connection is still a publish target.
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url, proposed_value, status, idempotency_key)
  values (v_client_a, v_loc_a2, 'onpage_fix', 'h1', 'missing_h1', 'https://a2.example.com/', '{"value":"H"}', 'approved', 'k-noconn');
  select count(*) into v_seen from seo_site_job_targets where location_id = v_loc_a2 and task = 'publish';
  assert v_seen = 1, 'targets: approved work on a location with no connection is still dispatched (it becomes manual steps)';
  select count(*) into v_seen from seo_site_job_targets where location_id = v_loc_a2 and task = 'check';
  assert v_seen = 0, 'targets: no connection means no heartbeat';
  select count(*) into v_seen from seo_site_job_targets where location_id = v_loc_b and task = 'publish';
  assert v_seen = 0, 'targets: a location with nothing waiting is not a publish target';
  select count(*) into v_seen from seo_site_job_targets where location_id = v_loc_a and task = 'check';
  assert v_seen = 1, 'targets: a never-checked connection is due a heartbeat';
  update seo_site_connections set last_checked_at = now() where id = v_conn_a;
  select count(*) into v_seen from seo_site_job_targets where location_id = v_loc_a and task = 'check';
  assert v_seen = 0, 'targets: a connection checked today is not due';

  assert request_seo_site_job(v_loc_a2, 'publish') is null, 'dispatch: without the Vault secrets nothing is sent';
  assert (select last_error from job_attempts where job_type = 'seo_publish' and entity_id = v_loc_a2) = 'missing_vault_secret',
    'dispatch: without the Vault secrets it settles as a failure instead of hanging';
  update job_attempts set next_run_at = now() where job_type = 'seo_publish' and entity_id = v_loc_a2;

  perform vault.create_secret('https://example.supabase.co/functions/v1/seo-publish', 'seo_publish_url', '');
  perform vault.create_secret('unit-test-shared-secret', 'voice_tool_secret', '');

  assert request_seo_site_job(v_loc_a2, 'publish') is not null, 'dispatch: succeeds once the secrets exist';
  assert request_seo_site_job(v_loc_a2, 'publish') is null, 'dedup: a second dispatch while running is refused';
  perform complete_job_attempt(v_client_a, 'seo_publish', true, null, 5, 1440, v_loc_a2);
  select next_run_at into v_row.updated_at from job_attempts where job_type = 'seo_publish' and entity_id = v_loc_a2;
  assert v_row.updated_at between now() + interval '4 minutes' and now() + interval '6 minutes', 'dispatch: publish settles on a 5-minute interval';

  begin
    perform request_seo_site_job(v_loc_a2, 'bogus');
    v_denied := false;
  exception when others then v_denied := true; end;
  assert v_denied, 'dispatch: an unknown task raises';

  assert (run_due_seo_site_jobs() ->> 'requested')::int >= 1, 'run_due: requests due jobs (the heartbeat for the never-checked connection)';

  -- ---------------------------------------------------------------------------
  -- Tenant-facing RPCs and isolation. Set up one action per state first.
  -- ---------------------------------------------------------------------------
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url, proposed_value, status, apply_mode, idempotency_key)
  values (v_client_a, v_loc_a, 'onpage_fix', 'meta_description', 'missing_meta_description', 'https://a.example.com/pages/p', '{"value":"M"}', 'published', 'api', 'k-pub-api');
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url, proposed_value, status, apply_mode, idempotency_key)
  values (v_client_a, v_loc_a, 'onpage_fix', 'h1', 'missing_h1', 'https://a.example.com/pages/q', '{"value":"H"}', 'published', 'manual', 'k-pub-manual');
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url, proposed_value, status, idempotency_key)
  values (v_client_a, v_loc_a, 'onpage_fix', 'local_business_schema', 'missing_local_business_schema', 'https://a.example.com/', '{"value":"S"}', 'manual_required', 'k-manual');
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url, proposed_value, status, idempotency_key)
  values (v_client_a, v_loc_a, 'onpage_fix', 'title_tag', 'title_length', 'https://a.example.com/pages/r', '{"value":"P"}', 'pending_approval', 'k-pending');
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url, proposed_value, status, apply_mode, idempotency_key)
  values (v_client_b, v_loc_b, 'onpage_fix', 'title_tag', 'missing_title', 'https://b.example.com/products/z', '{"value":"B"}', 'published', 'api', 'k-b-pub')
  returning id into v_act_b;

  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'seo-site-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  -- connections: tenant-readable, read-only
  select count(*) into v_seen from seo_site_connections;
  assert v_seen = 1, 'rls: tenant A sees only its own connection';
  select count(*) into v_seen from seo_site_connections where client_id = v_client_b;
  assert v_seen = 0, 'rls: tenant A must not see tenant B''s connection';

  begin
    update seo_site_connections set status = 'healthy' where id = v_conn_a;
    get diagnostics v_seen = row_count;
    v_denied := v_seen = 0;
  exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'rls: a tenant cannot mark its own connection healthy';

  begin
    insert into seo_site_connections (client_id, location_id, shop_domain) values (v_client_a, v_loc_a2, 'self.myshopify.com');
    v_denied := false;
  exception when others then v_denied := true; end;
  assert v_denied, 'rls: a tenant cannot create a connection';

  begin
    perform 1 from seo_site_credentials limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'rule 4: authenticated must not read seo_site_credentials';

  begin
    perform get_seo_site_credentials(v_loc_a);
    v_denied := false;
  exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'rule 4: authenticated must not execute get_seo_site_credentials';

  begin
    perform claim_seo_action(v_act, 'publish');
    v_denied := false;
  exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'authenticated must not execute claim_seo_action';

  begin
    perform 1 from seo_site_job_targets limit 1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'rule 4: authenticated must not read seo_site_job_targets';

  -- request_seo_rollback
  select id into v_act from seo_actions where idempotency_key = 'k-pub-api';
  assert request_seo_rollback(v_act) = 'ok', 'rollback: a published, API-applied action can be rolled back by its tenant';
  select status into v_txt from seo_actions where id = v_act;
  assert v_txt = 'rollback_requested', 'rollback: the row is now rollback_requested';
  assert request_seo_rollback(v_act) = 'not_rollbackable', 'rollback: asking twice is refused';

  assert request_seo_rollback(v_act_b) = 'not_found', 'rollback: another tenant''s action is not_found';
  assert request_seo_rollback(gen_random_uuid()) = 'not_found', 'rollback: a random id is the same not_found (no probing)';

  select id into v_act from seo_actions where idempotency_key = 'k-pub-manual';
  assert request_seo_rollback(v_act) = 'not_rollbackable', 'rollback: a manually applied change cannot be rolled back by us';
  select id into v_act from seo_actions where idempotency_key = 'k-pending';
  assert request_seo_rollback(v_act) = 'not_rollbackable', 'rollback: a pending draft is not rollbackable';

  -- the tenant still cannot write the rollback state directly
  begin
    update seo_actions set status = 'rollback_requested' where idempotency_key = 'k-pub-manual';
    get diagnostics v_seen = row_count;
    v_denied := v_seen = 0;
  exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'rls: a tenant cannot flip a published row directly';

  -- confirm_seo_manual_apply
  select id into v_act from seo_actions where idempotency_key = 'k-manual';
  assert confirm_seo_manual_apply(v_act) = 'ok', 'manual: a tenant can confirm they applied a manual_required change';
  select * into v_row from seo_actions where id = v_act;
  assert v_row.status = 'published' and v_row.apply_mode = 'manual' and v_row.published_at is not null, 'manual: it is published, marked manual, and stamped';
  assert (v_row.publish_result ->> 'verified')::boolean is false, 'manual: it is recorded as NOT verified (the next crawl confirms it)';
  assert (v_row.publish_result ->> 'confirmed_manually_by')::uuid = v_user_a, 'manual: it records who confirmed';
  assert confirm_seo_manual_apply(v_act) = 'not_pending_manual', 'manual: confirming twice is refused';
  select id into v_act from seo_actions where idempotency_key = 'k-pending';
  assert confirm_seo_manual_apply(v_act) = 'not_pending_manual', 'manual: only a manual_required action can be confirmed';
  assert confirm_seo_manual_apply(v_act_b) = 'not_found', 'manual: another tenant''s action is not_found';

  reset role;

  -- tenant A's RPC calls must not have touched tenant B
  select status into v_txt from seo_actions where id = v_act_b;
  assert v_txt = 'published', 'isolation: tenant B''s action is untouched';

  raise notice 'ALL 0055 SEO SITE ADAPTER TESTS PASSED';
end;
$$;

rollback;
