-- =============================================================================
-- 0225_loyalty_embedded_admin.sql - LL Loyalty Phase 2 module P4: the merchant
-- admin embedded in Shopify admin.
-- Plan: docs/loyalty/PLAN.md section 7.
--
-- Inside Shopify admin there is no LumiLink login. The page sends a Shopify
-- session token (HS256, signed with the app secret), the Next.js route
-- /api/loyalty/embedded verifies it and calls the same staff RPCs with the
-- service role and two request headers:
--   x-ll-embedded-shop   the shop from the verified token (dest)
--   x-ll-embedded-user   the Shopify staff user id from the verified token (sub)
-- loyalty_embedded_actor() reads them ONLY when the caller is the service role
-- (request.jwt.claims role). A browser holding the anon key cannot set them to
-- any effect, its role is anon or authenticated.
--
-- The embedded actor manages exactly one program, the one for that shop, and
-- only when merchant_access is on (0223, same rule as a portal admin). No MFA
-- step here - the Shopify admin login is the authentication.
--
-- Access log rows from the embedded admin have actor_kind shopify, no LumiLink
-- user (staff_user_id null) and the Shopify user id in shopify_user_id.
--
-- Comment rule (plan section 1): no semicolons or apostrophes in top-level
-- comments.
--
-- Test: scripts/test_loyalty_embedded_admin.sql.
-- =============================================================================

alter table loyalty_access_log alter column staff_user_id drop not null;
alter table loyalty_access_log add column if not exists shopify_user_id text;
alter table loyalty_access_log drop constraint if exists loyalty_access_log_actor_kind_check;
alter table loyalty_access_log add constraint loyalty_access_log_actor_kind_check
  check (actor_kind in ('staff', 'merchant', 'shopify'));
alter table loyalty_access_log drop constraint if exists loyalty_access_log_actor_check;
alter table loyalty_access_log add constraint loyalty_access_log_actor_check
  check (staff_user_id is not null or (actor_kind = 'shopify' and shopify_user_id is not null));

-- loyalty_embedded_actor - {shop, user} for a service-role call made by the
-- embedded admin route, else null.
create or replace function loyalty_embedded_actor()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_claims  jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_headers jsonb := nullif(current_setting('request.headers', true), '')::jsonb;
  v_shop    text;
  v_user    text;
begin
  if coalesce(v_claims ->> 'role', '') <> 'service_role' or v_headers is null then
    return null;
  end if;
  v_shop := lower(v_headers ->> 'x-ll-embedded-shop');
  v_user := v_headers ->> 'x-ll-embedded-user';
  if v_shop !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' or v_user !~ '^[0-9]{1,20}$' then
    return null;
  end if;
  return jsonb_build_object('shop', v_shop, 'user', v_user);
end;
$$;

create or replace function loyalty_can_manage(p_program uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select loyalty_is_staff()
      or exists (select 1
                   from loyalty_programs p
                   join users u on u.client_id = p.client_id
                  where p.id = p_program and p.merchant_access
                    and u.id = auth.uid() and u.is_active and u.role = 'admin')
      or exists (select 1
                   from loyalty_programs p
                  where p.id = p_program and p.merchant_access
                    and p.shop_domain = loyalty_embedded_actor() ->> 'shop');
$$;

create or replace function loyalty_require_manager(p_program uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_actor jsonb;
begin
  select email into v_email from platform_staff where user_id = auth.uid();
  if v_email is not null then
    if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
      raise exception 'mfa_required' using errcode = '42501';
    end if;
    return v_email;
  end if;
  if p_program is null or not loyalty_can_manage(p_program) then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  v_actor := loyalty_embedded_actor();
  if v_actor is not null then
    return 'shopify:' || (v_actor ->> 'user') || '@' || (v_actor ->> 'shop');
  end if;
  if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'mfa_required' using errcode = '42501';
  end if;
  select email into v_email from users where id = auth.uid();
  return v_email;
end;
$$;

create or replace function loyalty_require_manager_any()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog uuid;
begin
  if loyalty_is_staff() then
    return loyalty_require_staff();
  end if;
  select p.id into v_prog
    from loyalty_programs p
   where p.merchant_access
     and (p.shop_domain = loyalty_embedded_actor() ->> 'shop'
          or exists (select 1 from users u where u.client_id = p.client_id and u.id = auth.uid()))
   limit 1;
  return loyalty_require_manager(v_prog);
end;
$$;

create or replace function loyalty_log_access(p_action text, p_program uuid, p_member uuid, p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into loyalty_access_log (staff_user_id, staff_email, action, program_id, member_id, detail, actor_kind, shopify_user_id)
  select a.uid, a.email, p_action, p_program, p_member, coalesce(p_detail, '{}'::jsonb), a.kind, a.shopify_user
    from (select auth.uid() as uid, s.email, 'staff' as kind, null::text as shopify_user
            from platform_staff s where s.user_id = auth.uid()
          union all
          select auth.uid(), u.email, 'merchant', null from users u
           where u.id = auth.uid()
             and not exists (select 1 from platform_staff s where s.user_id = auth.uid())
             and loyalty_can_manage(p_program)
          union all
          select null, 'shopify:' || (e.actor ->> 'user') || '@' || (e.actor ->> 'shop'), 'shopify', e.actor ->> 'user'
            from (select loyalty_embedded_actor() as actor) e
           where e.actor is not null and auth.uid() is null and loyalty_can_manage(p_program)) a;
$$;

-- loyalty_embedded_program - the program the embedded admin opens, with what
-- the shell needs. Null when the shop has no program or merchant access is off.
create or replace function loyalty_embedded_program()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('id', p.id, 'name', p.name, 'shop_domain', p.shop_domain, 'is_active', p.is_active,
                            'live_since', p.live_since,
                            'members', (select count(*) from loyalty_members m where m.program_id = p.id),
                            'backfill', (select status from loyalty_backfills b where b.program_id = p.id))
    from loyalty_programs p
   where p.merchant_access and p.shop_domain = loyalty_embedded_actor() ->> 'shop';
$$;

revoke execute on function loyalty_embedded_actor() from public, anon, authenticated;
revoke execute on function loyalty_embedded_program() from public, anon, authenticated;
grant execute on function loyalty_embedded_program() to service_role;
