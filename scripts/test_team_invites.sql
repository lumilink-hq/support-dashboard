-- =============================================================================
-- test_team_invites.sql — non-destructive test of 0082: client admins manage
-- their own team through the RPCs, nobody else can, and users can no longer
-- rewrite their own role or client_id.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_team_invites.sql
--
-- To see it FAIL: drop the `revoke update on public.users` line from 0082 ->
-- "agent cannot promote self" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

-- Fixtures, as postgres. Two clients; A has an admin, an agent who has signed
-- in, and an invited user who hasn't. B has its own admin.
create temp table t (k text primary key, v uuid) on commit drop;
grant all on t to authenticated;

do $$
declare
  v_admin uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_client_a uuid;
  v_client_b uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at)
  values (v_admin, 'admin@team-a.example', '{"business_name":"Team A"}', now());
  select client_id into v_client_a from users where id = v_admin;

  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at)
  values (v_other, 'admin@team-b.example', '{"business_name":"Team B"}', now());
  select client_id into v_client_b from users where id = v_other;

  insert into client_invites (client_id, email, role) values (v_client_a, 'agent@team-a.example', 'agent');
  insert into auth.users (id, email, last_sign_in_at) values (v_agent, 'agent@team-a.example', now());

  insert into t values ('admin', v_admin), ('agent', v_agent), ('other', v_other),
                       ('client_a', v_client_a), ('client_b', v_client_b);
end $$;

-- ---------------------------------------------------------------------------
-- As A's admin
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'admin'), true);

do $$
declare
  v_n int;
  v_row record;
begin
  perform create_team_invite('  New@Team-A.example ', 'New Person', 'viewer');
  -- Re-invite updates rather than duplicating.
  perform create_team_invite('new@team-a.example', 'New Person', 'agent');

  select count(*) into v_n from team_members();
  assert v_n = 3, 'team_members: admin + agent + pending invite, got ' || v_n;

  select * into v_row from team_members() where email = 'new@team-a.example';
  assert v_row.status = 'invited' and v_row.user_id is null and v_row.role = 'agent',
    'pending invite listed as invited with updated role';

  select * into v_row from team_members() where is_me;
  assert v_row.role = 'admin' and v_row.status = 'active', 'caller listed as active admin';

  assert team_invite_resendable('new@team-a.example'), 'pending invite is resendable';
  assert not team_invite_resendable('agent@team-a.example'), 'signed-in member is not resendable';
  assert not team_invite_resendable('admin@team-b.example'), 'other client''s user is not resendable';

  begin
    perform create_team_invite('admin@team-b.example', null, 'agent');
    raise exception 'invited an email that already has an account';
  exception when unique_violation then null;
  end;

  begin
    perform create_team_invite('not-an-email', null, 'agent');
    raise exception 'invalid email accepted';
  exception when invalid_parameter_value then null;
  end;

  perform set_team_member_role((select v from t where k = 'agent'), 'viewer');
  assert (select role from users where id = (select v from t where k = 'agent')) = 'viewer',
    'admin changed teammate role';

  begin
    perform set_team_member_role((select v from t where k = 'admin'), 'agent');
    raise exception 'admin demoted self';
  exception when insufficient_privilege then null;
  end;

  begin
    perform set_team_member_role((select v from t where k = 'other'), 'viewer');
    raise exception 'admin changed another client''s user';
  exception when insufficient_privilege then null;
  end;

  -- 0086: Remove is permanent for everyone; the app then deletes the auth user.
  assert remove_team_member((select v from t where k = 'agent')) = 'delete',
    'signed-in teammate is deleted on remove, not deactivated';
  assert (select status from team_members() where email = 'agent@team-a.example') = 'active',
    'remove_team_member itself changes nothing (the auth delete does)';

  perform withdraw_team_invite('new@team-a.example');
  assert not exists (select 1 from team_members() where email = 'new@team-a.example'),
    'withdrawn invite gone';
end $$;

-- ---------------------------------------------------------------------------
-- As B's admin: sees nothing of A
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'other'), true);
do $$
begin
  assert not exists (select 1 from team_members() where email like '%@team-a.example'),
    'other client sees none of A''s team';
end $$;

-- ---------------------------------------------------------------------------
-- As A's agent: can read the team, can't manage it, can't escalate
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'agent'), true);
do $$
begin
  assert (select count(*) from team_members()) = 2, 'agent can read own team';

  begin
    perform create_team_invite('sneaky@team-a.example', null, 'admin');
    raise exception 'agent created an invite';
  exception when insufficient_privilege then null;
  end;

  begin
    update users set role = 'admin' where id = auth.uid();
    raise exception 'agent cannot promote self';
  exception when insufficient_privilege then null;
  end;

  begin
    update users set client_id = (select v from t where k = 'client_b') where id = auth.uid();
    raise exception 'agent cannot move self to another client';
  exception when insufficient_privilege then null;
  end;

  -- full_name stays self-editable.
  update users set full_name = 'Renamed Agent' where id = auth.uid();
  assert (select full_name from users where id = auth.uid()) = 'Renamed Agent',
    'user can still edit own full_name';
end $$;

-- Direct table access still closed.
do $$
begin
  perform 1 from client_invites;
  raise exception 'authenticated could read client_invites';
exception when insufficient_privilege then null;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- Someone 0082 deactivated (still on prod): listed as deactivated, and the
-- admin can reactivate them or remove them for good.
-- ---------------------------------------------------------------------------
update users set is_active = false where id = (select v from t where k = 'agent');
set local role authenticated;
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'admin'), true);
do $$
begin
  assert (select status from team_members() where email = 'agent@team-a.example') = 'deactivated',
    'legacy deactivated teammate is listed as deactivated';
  assert remove_team_member((select v from t where k = 'agent')) = 'delete',
    'legacy deactivated teammate can be removed permanently';
  perform reactivate_team_member((select v from t where k = 'agent'));
  assert (select status from team_members() where email = 'agent@team-a.example') = 'active',
    'legacy deactivated teammate can be reactivated';
end $$;
reset role;

select 'test_team_invites: all assertions passed' as result;

rollback;
