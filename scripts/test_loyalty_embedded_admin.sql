-- =============================================================================
-- test_loyalty_embedded_admin.sql — non-destructive test of 0225 (Phase 2 P4):
-- the embedded Shopify admin acts through the service role + two headers, for
-- its own shop only, with merchant access on, and is logged as shopify.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_loyalty_embedded_admin.sql
--
-- To see it FAIL:
--   * drop the service_role check in loyalty_embedded_actor
--     -> "headers from a signed-in user are ignored" fails.
--   * drop "p.merchant_access" from the embedded branch of loyalty_can_manage
--     -> "shop without merchant access is refused" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

create temp table t (k text primary key, v uuid) on commit drop;
grant all on t to authenticated, service_role;

create or replace function pg_temp.refused(p_sql text)
returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when insufficient_privilege then
  return sqlerrm = 'not_staff';
end;
$$;
grant execute on function pg_temp.refused(text) to authenticated, service_role;

do $$
declare
  v_ca uuid;
  v_cb uuid;
  v_u  uuid := gen_random_uuid();
  v_pa uuid;
  v_pb uuid;
begin
  insert into clients (name, slug) values ('Emb A', 'test-emb-a') returning id into v_ca;
  insert into clients (name, slug) values ('Emb B', 'test-emb-b') returning id into v_cb;
  insert into loyalty_programs (client_id, shop_domain, name, created_via)
  values (v_ca, 'emb-a.myshopify.com', 'A Rewards', 'self_serve') returning id into v_pa;
  insert into loyalty_programs (client_id, shop_domain, name)
  values (v_cb, 'emb-b.myshopify.com', 'B Rewards') returning id into v_pb;   -- merchant_access off
  insert into loyalty_tiers (program_id, key, name, rank, min_spend_cents) values
    (v_pa, 'bronze', 'Bronze', 0, 0), (v_pb, 'bronze', 'Bronze', 0, 0);
  insert into t values ('pa', v_pa), ('pb', v_pb),
    ('ma', loyalty_enroll_member(v_pa, 11, 'a@emb.example', 'A', 'A')),
    ('mb', loyalty_enroll_member(v_pb, 22, 'b@emb.example', 'B', 'B'));
  -- A signed-in user (no loyalty rights) for the forged-header case.
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at) values (v_u, 'nobody@emb.example', '{"business_name":"Nobody"}', now());
  insert into t values ('u', v_u);
end $$;

-- ---------------------------------------------------------------------------
-- Embedded call for shop A.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.headers', '{"x-ll-embedded-shop":"emb-a.myshopify.com","x-ll-embedded-user":"8812"}', true);
set local role service_role;
do $$
declare
  v_pa uuid := (select v from t where k = 'pa');
  v_pb uuid := (select v from t where k = 'pb');
  v_list jsonb;
begin
  if (loyalty_embedded_program()->>'id')::uuid <> v_pa then
    raise exception 'FAIL embedded program: %', loyalty_embedded_program();
  end if;
  v_list := loyalty_staff_programs();
  if jsonb_array_length(v_list) <> 1 or (v_list->0->>'id')::uuid <> v_pa then
    raise exception 'FAIL embedded sees only its shop: %', v_list;
  end if;
  if loyalty_staff_program_config(v_pa) is null or (loyalty_staff_members(v_pa)->>'total')::int <> 1 then
    raise exception 'FAIL embedded reads its program';
  end if;
  perform loyalty_staff_adjust((select v from t where k = 'ma'), 25, 'embedded test', 'emb-test-0001');
  raise notice 'ok  embedded admin reads and adjusts its own shop';

  if not pg_temp.refused(format('select loyalty_staff_program_config(%L)', v_pb))
     or not pg_temp.refused(format('select loyalty_staff_member(%L)', (select v from t where k = 'mb')))
     or not pg_temp.refused('select loyalty_staff_data_requests()') then
    raise exception 'FAIL other shop, other member, data requests refused';
  end if;
  raise notice 'ok  other shop, other member and data requests refused';
end $$;
reset role;

do $$
begin
  if not exists (select 1 from loyalty_access_log
                  where actor_kind = 'shopify' and shopify_user_id = '8812' and staff_user_id is null
                    and staff_email = 'shopify:8812@emb-a.myshopify.com' and action = 'adjust') then
    raise exception 'FAIL embedded adjust logged as shopify';
  end if;
  if (select points_balance from loyalty_members where id = (select v from t where k = 'ma')) <> 25 then
    raise exception 'FAIL embedded adjust landed';
  end if;
  raise notice 'ok  embedded actions logged as shopify with the Shopify user id';
end $$;

-- Shop B: merchant access off.
select set_config('request.headers', '{"x-ll-embedded-shop":"emb-b.myshopify.com","x-ll-embedded-user":"8812"}', true);
set local role service_role;
do $$
begin
  if loyalty_embedded_program() is not null
     or not pg_temp.refused(format('select loyalty_staff_program_config(%L)', (select v from t where k = 'pb'))) then
    raise exception 'FAIL shop without merchant access is refused';
  end if;
  raise notice 'ok  shop without merchant access is refused';
end $$;
reset role;

-- Malformed headers.
select set_config('request.headers', '{"x-ll-embedded-shop":"emb-a.myshopify.com","x-ll-embedded-user":"gid://shopify/User/1"}', true);
set local role service_role;
do $$
begin
  if loyalty_embedded_actor() is not null then
    raise exception 'FAIL malformed user id is ignored';
  end if;
end $$;
reset role;

-- Same headers from a signed-in user: ignored.
select set_config('request.jwt.claims', json_build_object('sub', (select v from t where k = 'u'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
select set_config('request.headers', '{"x-ll-embedded-shop":"emb-a.myshopify.com","x-ll-embedded-user":"8812"}', true);
set local role authenticated;
do $$
begin
  if not pg_temp.refused(format('select loyalty_staff_program_config(%L)', (select v from t where k = 'pa')))
     or not pg_temp.refused('select loyalty_staff_programs()') then
    raise exception 'FAIL headers from a signed-in user are ignored';
  end if;
  raise notice 'ok  headers from a signed-in user are ignored';
end $$;
reset role;

do $$
begin
  if has_function_privilege('authenticated', 'loyalty_embedded_program()', 'execute')
     or has_function_privilege('anon', 'loyalty_embedded_actor()', 'execute') then
    raise exception 'FAIL privileges';
  end if;
  raise notice 'ok  embedded functions service role only';
end $$;

rollback;
