-- =============================================================================
-- add-staff.sql — pre-approve staff emails for an existing client (needs 0080).
--
-- Supabase Dashboard -> SQL Editor. Fill in v_staff, run once with
-- v_dry_run = true to see what would happen, then flip it to false.
--
-- After this runs, each person goes to https://www.lumilinkhub.com/signup and
-- signs up with THAT email. The business name they type is ignored: the
-- signup trigger sees the invite and puts them on the client below with the
-- role listed, instead of creating a new workspace. They confirm their email
-- as normal, then sign in.
--
-- Roles (user_role_t):
--   admin  — Settings and Services edits. Give to whoever runs the account.
--   agent  — day-to-day use. The default.
--   viewer — read only.
--
-- Already has a login? An email that already signed up has its own stray
-- workspace, and the invite never fires for them. The NOTICE output flags
-- these; move them with scripts/add-user-to-client.sql instead.
--
-- Re-running is safe: emails with a pending invite are updated (name/role),
-- not duplicated.
-- =============================================================================

do $$
declare
  v_dry_run boolean := true;   -- set to false for the real run
  v_client  uuid := '91fec91b-b0a4-419a-a85b-743aae18073a';   -- PACKS
  v_name    text := 'PACKS';                                  -- safety check on v_client
  -- email, full name ('' if unknown), role
  v_staff   text[][] := array[
    array['someone@packsclub.com', 'Someone Example', 'agent']
  ];
  v_email   text;
  v_role    public.user_role_t;
  i         int;
begin
  if not exists (select 1 from clients where id = v_client and name = v_name) then
    raise exception 'client % (%) not found', v_name, v_client;
  end if;

  for i in 1 .. array_length(v_staff, 1) loop
    v_email := lower(trim(v_staff[i][1]));
    v_role  := v_staff[i][3]::public.user_role_t;   -- errors on a typo'd role

    if exists (select 1 from auth.users where lower(email) = v_email) then
      raise notice 'SKIP % — already has a login (client: %). Use add-user-to-client.sql.',
        v_email,
        (select c.name from users u join clients c on c.id = u.client_id
          join auth.users a on a.id = u.id where lower(a.email) = v_email);
      continue;
    end if;

    if exists (select 1 from client_invites
                where email = v_email and accepted_at is null and client_id <> v_client) then
      raise notice 'SKIP % — pending invite for a different client', v_email;
      continue;
    end if;

    raise notice '% % as %', case when v_dry_run then 'would invite' else 'invite' end, v_email, v_role;

    if not v_dry_run then
      insert into client_invites (client_id, email, full_name, role)
      values (v_client, v_email, nullif(trim(v_staff[i][2]), ''), v_role)
      on conflict (email) where accepted_at is null
      do update set full_name = excluded.full_name, role = excluded.role;
    end if;
  end loop;
end $$;


-- =============================================================================
-- Status: who's been invited, who has signed up
-- =============================================================================
select i.email, i.full_name, i.role,
       case when i.accepted_at is null then 'pending' else 'joined' end as status,
       i.created_at, i.accepted_at
  from client_invites i
 where i.client_id = '91fec91b-b0a4-419a-a85b-743aae18073a'
 order by i.accepted_at nulls first, i.email;

-- Withdraw a pending invite:
--   delete from client_invites where email = 'someone@packsclub.com' and accepted_at is null;
-- Remove someone who already joined: deactivate them, don't delete.
--   update users set is_active = false where email = 'someone@packsclub.com';
--   (is_active isn't enforced yet; ban the auth user too: Dashboard ->
--    Authentication -> Users -> Ban user.)
