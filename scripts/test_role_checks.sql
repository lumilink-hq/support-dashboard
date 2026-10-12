-- =============================================================================
-- test_role_checks.sql — non-destructive test of 0083: a viewer can read SEO
-- approvals and the review queue but can't change them, directly or through
-- the RPCs; an agent and an admin can; service_role is unaffected.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_role_checks.sql
--
-- To see it FAIL: drop the policy seo_actions_role_update -> "viewer approve
-- is refused" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

create temp table t (k text primary key, v uuid) on commit drop;
grant all on t to authenticated, service_role;

do $$
declare
  v_admin  uuid := gen_random_uuid();
  v_agent  uuid := gen_random_uuid();
  v_viewer uuid := gen_random_uuid();
  v_client uuid;
  v_loc    uuid;
  v_id     uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at)
  values (v_admin, 'admin@roles.example', '{"business_name":"Roles Co"}', now());
  select client_id into v_client from users where id = v_admin;

  insert into client_invites (client_id, email, role) values
    (v_client, 'agent@roles.example', 'agent'),
    (v_client, 'viewer@roles.example', 'viewer');
  insert into auth.users (id, email, last_sign_in_at) values
    (v_agent, 'agent@roles.example', now()),
    (v_viewer, 'viewer@roles.example', now());

  insert into seo_locations (client_id, name, website_url)
  values (v_client, 'R', 'https://roles.example.com') returning id into v_loc;

  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url, proposed_value, status, idempotency_key)
  values (v_client, v_loc, 'onpage_fix', 'title_tag', 'title_length', 'https://roles.example.com/',
          '{"value":"Roles Example: A Title"}', 'pending_approval', 'test-roles-pending')
  returning id into v_id;
  insert into t values ('pending', v_id);

  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url, proposed_value, status, apply_mode, idempotency_key)
  values (v_client, v_loc, 'onpage_fix', 'meta_description', 'meta_description_length', 'https://roles.example.com/',
          '{"value":"Roles example meta description."}', 'published', 'api', 'test-roles-published')
  returning id into v_id;
  insert into t values ('published', v_id);

  insert into review_queue (client_id, reason, callback_number)
  values (v_client, 'callback_request', '+15555550100') returning id into v_id;
  insert into t values ('ticket', v_id);

  insert into t values ('admin', v_admin), ('agent', v_agent), ('viewer', v_viewer);
end $$;

set local role authenticated;

-- ---------------------------------------------------------------------------
-- Viewer: reads everything, changes nothing
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'viewer'), true);
do $$
declare
  v_n int;
begin
  assert not current_user_can_act(), 'viewer cannot act';
  assert (select count(*) from seo_actions) = 2, 'viewer can read seo_actions';
  assert (select count(*) from review_queue) = 1, 'viewer can read review_queue';

  update seo_actions set status = 'approved' where id = (select v from t where k = 'pending');
  get diagnostics v_n = row_count;
  assert v_n = 0, 'viewer approve is refused';

  assert request_seo_rollback((select v from t where k = 'published')) = 'not_allowed',
    'viewer rollback is refused';

  update review_queue set status = 'resolved' where id = (select v from t where k = 'ticket');
  get diagnostics v_n = row_count;
  assert v_n = 0, 'viewer resolve is refused';

  delete from review_queue where id = (select v from t where k = 'ticket');
  get diagnostics v_n = row_count;
  assert v_n = 0, 'viewer delete is refused';

  begin
    insert into ticket_notes (ticket_id, client_id, body)
    values ((select v from t where k = 'ticket'), current_client_id(), 'sneaky');
    raise exception 'viewer inserted a ticket note';
  exception when insufficient_privilege then null;
  end;

  assert (record_callback_attempt((select v from t where k = 'ticket'), 'attempted', null, auth.uid()))->>'error' = 'not_allowed',
    'viewer callback is refused';
  assert (select callback_attempts from review_queue where id = (select v from t where k = 'ticket')) = 0,
    'viewer callback changed nothing';
end $$;

-- ---------------------------------------------------------------------------
-- Agent: day-to-day actions work
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'agent'), true);
do $$
declare
  v_n int;
begin
  assert current_user_can_act(), 'agent can act';

  update seo_actions set status = 'approved' where id = (select v from t where k = 'pending');
  get diagnostics v_n = row_count;
  assert v_n = 1, 'agent approve works';

  assert (record_callback_attempt((select v from t where k = 'ticket'), 'attempted', 'left a message', auth.uid()))->>'ok' = 'true',
    'agent callback works';

  update review_queue set status = 'resolved' where id = (select v from t where k = 'ticket');
  get diagnostics v_n = row_count;
  assert v_n = 1, 'agent resolve works';
end $$;

-- ---------------------------------------------------------------------------
-- Admin: rollback works; a removed (inactive) admin can't act
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'admin'), true);
do $$
begin
  assert request_seo_rollback((select v from t where k = 'published')) = 'ok', 'admin rollback works';
end $$;

reset role;
update users set is_active = false where id = (select v from t where k = 'agent');
set local role authenticated;
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'agent'), true);
do $$
begin
  assert not current_user_can_act(), 'deactivated agent cannot act';
end $$;

-- ---------------------------------------------------------------------------
-- service_role (voice tools, edge functions) is unaffected
-- ---------------------------------------------------------------------------
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  assert (record_callback_attempt((select v from t where k = 'ticket'), 'failed', null, null))->>'ok' = 'true',
    'service_role callback still works';
end $$;

reset role;

select 'test_role_checks: all assertions passed' as result;

rollback;
