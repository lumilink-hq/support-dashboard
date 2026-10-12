-- =============================================================================
-- test_client_invites.sql — non-destructive test of 0080: an invited email
-- joins the existing client with the invited role, everyone else still gets a
-- fresh workspace as admin, and dashboard roles can't see the invite list.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_client_invites.sql
--
-- To see it FAIL: delete the `if found then ... end if;` invite block from
-- handle_new_user() -> "invited signup joins existing client" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client  uuid;
  v_id      uuid;
  v_row     record;
  v_clients int;
begin
  insert into clients (name, slug) values ('Invite Test Co', 'invite-test-co')
  returning id into v_client;

  insert into client_invites (client_id, email, full_name, role)
  values (v_client, 'staff@invite-test.example', 'Staff Person', 'viewer');

  -- ---------------------------------------------------------------------------
  -- Invited email, mixed case, typed a different business name at signup
  -- ---------------------------------------------------------------------------
  select count(*) into v_clients from clients;
  v_id := gen_random_uuid();
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_id, 'Staff@Invite-Test.example', '{"business_name":"Something Else"}');

  select u.client_id, u.role, u.full_name into v_row from users u where u.id = v_id;
  assert v_row.client_id = v_client, 'invited signup joins existing client';
  assert v_row.role = 'viewer', 'invited signup gets the invited role';
  assert v_row.full_name = 'Staff Person', 'invite name used when signup had none';
  assert (select count(*) from clients) = v_clients, 'invited signup creates no client';

  select accepted_at, user_id into v_row from client_invites where email = 'staff@invite-test.example';
  assert v_row.accepted_at is not null and v_row.user_id = v_id, 'invite marked accepted';

  -- ---------------------------------------------------------------------------
  -- Uninvited signup: unchanged behaviour
  -- ---------------------------------------------------------------------------
  v_id := gen_random_uuid();
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_id, 'owner@elsewhere.example', '{"business_name":"Elsewhere Co"}');
  select u.client_id, u.role into v_row from users u where u.id = v_id;
  assert v_row.client_id <> v_client, 'uninvited signup gets its own client';
  assert v_row.role = 'admin', 'uninvited signup is admin of its own client';

  -- ---------------------------------------------------------------------------
  -- Constraints
  -- ---------------------------------------------------------------------------
  insert into client_invites (client_id, email) values (v_client, 'dup@invite-test.example');
  begin
    insert into client_invites (client_id, email) values (v_client, 'dup@invite-test.example');
    raise exception 'second pending invite for same email was allowed';
  exception when unique_violation then null;
  end;

  begin
    insert into client_invites (client_id, email) values (v_client, 'Upper@Invite-Test.example');
    raise exception 'non-lowercase email was allowed';
  exception when check_violation then null;
  end;
end $$;

-- Dashboard roles can't touch the invite list.
set local role authenticated;
do $$
begin
  perform 1 from client_invites;
  raise exception 'authenticated could read client_invites';
exception when insufficient_privilege then null;
end $$;
reset role;

select 'test_client_invites: all assertions passed' as result;

rollback;
